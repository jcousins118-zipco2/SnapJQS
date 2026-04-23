import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { canonicalDumps, sha256Hex, CanonicalizationError } from "./canonical";
import { signReceipt, verifyReceipt, SignatureError } from "./signer";
import { decide } from "./decision";
import { globalRegistry, EvidenceType, validateCitations } from "./evidence";
import { 
  buildJurorPrompt, 
  normalizeJurorOutput, 
  processJurorResponse,
  JUROR_CONTRACT_VERSION,
  PRIMARY_JUROR_SYSTEM,
  callPrimaryJurorEnforced,
  finalizePrimaryOutput
} from "./contract";
import { runSessionInMemory } from "./orchestrator";
import { normalizeVerdictEnvelope, enforceRulesOutGate, type VerdictEnvelope } from "./verdict";
import { normalizeFinalText, normalizeForMode, extractPrimaryThen, extractNotes, downgradeImpossibilityInAnalyze } from "./jury_policy";
import { buildPrompt } from "./triage";
import { applyGovernorToPrompt, stripBoilerplateIfPresent, type GovernorMode } from "./governor";
import {
  crypt_logIncomingUserText,
  crypt_logGateSnapshot,
  crypt_logModelDispatch,
  crypt_detectMismatch,
} from "./crypt";
import { runResearchGovernor } from "./governor_research";
import OpenAI from "openai";

// ============================================================
// HARD ANALYZE OVERRIDE: never allow ESCALATE_HUMAN / dead-ends to reach UI
// ============================================================
const ANALYZE_BLOCKER_RE = /(ESCALATE_HUMAN|Not settled yet|requires human|human decision|value judgment|more constraints|cannot conclude|impossib(ility|le))/i;

function extractPrimaryText(envelope: unknown): string {
  const e = envelope as any;
  if (typeof e === "string") return e;
  // common shapes
  const candidates = [
    e?.then, e?.text, e?.content, e?.message,
    e?.primary?.then, e?.primary?.text, e?.primary?.content, e?.primary?.message,
    e?.result?.then, e?.result?.text, e?.result?.content, e?.result?.message,
    e?.data?.then, e?.data?.text, e?.data?.content, e?.data?.message,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return "";
}

function hardAnalyzeLetThrough(envelope: unknown): any {
  const text = extractPrimaryText(envelope);
  const safeThen =
    text && !ANALYZE_BLOCKER_RE.test(text)
      ? text
      : (text && text.trim() ? text : "Continue: produce the requested output now, as-is, without asking questions or escalating.");

  // Force a UI-renderable "content" shape regardless of upstream status.
  return {
    status: "CONCLUDE",      // IMPORTANT: do not emit ESCALATE_* in ANALYZE
    then: safeThen,          // IMPORTANT: UI should render from `then`
    text: safeThen,
    content: safeThen,
    message: safeThen,
    // keep citations if present, but never leak debug blobs
    citations: (envelope as any)?.citations ?? [],
    need_detail: null,
    rules_out: [],
  };
}

// ============================================================
// HARD REMOVE "HUMAN INTERVENTION" IN ANALYZE MODE (object-level)
// ============================================================
type AnyVerdict = Record<string, any>;

function removeHumanInterventionInAnalyze(v: AnyVerdict, mode: string): AnyVerdict {
  if (mode !== "ANALYZE") return v;

  // 1) Clear *all* common escalation / human-gate flags
  const keysToForceFalse = [
    "requiresHumanDecision",
    "requiresHuman",
    "needsHuman",
    "humanDecisionRequired",
    "escalateHuman",
    "escalate_human",
    "shouldEscalate",
    "block",
    "blocked",
    "mustEscalate",
  ];

  for (const k of keysToForceFalse) {
    if (k in v) v[k] = false;
  }

  // 2) Downgrade status/verdict types that trigger the UI banner
  const statusKeys = ["status", "verdict", "decision", "outcome", "final"];
  for (const sk of statusKeys) {
    if (sk in v) {
      const val = String(v[sk]).toUpperCase();
      if (val.includes("ESCALATE") || val.includes("HUMAN") || val.includes("BLOCK") || val.includes("NOT_SETTLED")) {
        v[sk] = "OK";
      }
    }
  }

  // 3) If there is a dedicated banner/message field, neutralize it
  const msgKeys = ["banner", "bannerText", "blockingText", "blockerText", "systemNote", "note"];
  for (const mk of msgKeys) {
    if (mk in v) {
      const s = String(v[mk] ?? "");
      if (/human decision|value judgment|not settled|more constraints|cannot conclude|escalate/i.test(s)) {
        v[mk] = "";
      }
    }
  }

  // 4) If the model output text itself is only the blocker line, replace it with a continuation cue
  const textKeys = ["text", "output", "finalText", "answer", "content", "follows"];
  for (const tk of textKeys) {
    if (tk in v && typeof v[tk] === "string") {
      const s = v[tk].trim();
      if (/^(this is a value judgment.*human decision\.?|not settled yet|more constraints are needed.*)$/i.test(s)) {
        v[tk] = "Proceed in ANALYZE mode: provide the best-effort structured response under the given constraints, and include any value/policy concerns as notes (not blockers).";
      }
    }
  }

  return v;
}

// ============================================================
// AGGRESSIVE FINAL FILTER - catches ANY blocker that slips through
// ============================================================
function forceAnalyzeLetThrough(follows: string, mode: string): string {
  if (mode !== "ANALYZE") return follows;
  
  const t = (follows ?? "").toLowerCase();
  const blockerPatterns = [
    "value judgment that requires human decision",
    "requires human decision",
    "value judgment",
    "human decision",
    "not settled",
    "more constraints are needed",
    "cannot conclude",
    "must be decided by a human",
  ];
  
  const isBlocker = blockerPatterns.some(p => t.includes(p));
  
  if (isBlocker) {
    // Replace with continuation prompt
    return "Proceed in ANALYZE mode: provide a concrete 8-step program. For each step include: (a) action (b) why it plausibly reduces injuries (c) public trust/legibility note (d) measurement signal. Do not ask questions. Do not escalate. Treat any policy or value judgments as notes inside the plan, not blockers. Begin.";
  }
  
  return follows;
}

// ---- SNAPSPACE OUTPUT GUARD ----

function norm(s: string) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function keywordsFromIf(ifText: string) {
  const stop = new Set([
    "if","then","the","a","an","and","or","but","is","are","was","were","to","of","in","on","for","with",
    "must","should","can","could","would","will","this","that","these","those","what","follows","from","it",
    "be","as","at","by","not","no","yes","under","over","into","than","so"
  ]);
  const toks = norm(ifText).split(" ").filter(t => t.length >= 4 && !stop.has(t));
  return Array.from(new Set(toks)).slice(0, 12);
}

function hasSupport(ifText: string, claim: string) {
  const kws = keywordsFromIf(ifText);
  if (!kws.length) return true;
  const c = norm(claim);
  const hits = kws.filter(k => c.includes(k)).length;
  return hits >= 1;
}

function enforceIfThenGuard(stands: string, follows: string, rulesOut: string, userIf: string) {
  const cleanUserIf = userIf.trim().replace(/\s+/g, " ");
  
  // IF must be exactly the user's IF (verbatim), not rewritten
  const outIf = `${cleanUserIf.replace(/^if\s+/i, "").replace(/\?$/, "").trim()}`;
  
  // THEN must reference IF keywords OR be very generic
  let outThen = follows;
  if (!hasSupport(cleanUserIf, follows)) {
    outThen = "a direct consequence cannot be stated without more detail.";
  }
  
  // RULES OUT: only keep if supported by IF keywords
  let outRulesOut = rulesOut;
  if (rulesOut && !hasSupport(cleanUserIf, rulesOut)) {
    outRulesOut = "";
  }
  
  return { stands: outIf, follows: outThen, rulesOut: outRulesOut };
}

// ---- END GUARD ----

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.post(api.canonical.process.path, async (req, res) => {
    try {
      const { data } = api.canonical.process.input.parse(req.body);
      
      const canonical = canonicalDumps(data);
      const hash = sha256Hex(canonical);
      
      // Store in history
      await storage.createHistory({
        originalInput: JSON.stringify(data), // Store the raw input as JSON
        canonicalOutput: canonical,
        sha256Hash: hash,
      });

      res.json({
        canonical,
        hash,
        valid: true
      });
    } catch (err) {
      if (err instanceof CanonicalizationError) {
        res.status(400).json({
          message: "Canonicalization failed",
          error: err.message
        });
        return;
      }
      if (err instanceof z.ZodError) {
        res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
        return;
      }
      // Handle parsing errors or others
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  app.get(api.canonical.history.path, async (req, res) => {
    const items = await storage.getHistory();
    res.json(items);
  });

  // Sign endpoint
  app.post(api.canonical.sign.path, async (req, res) => {
    try {
      const { data, kid, keyHex } = api.canonical.sign.input.parse(req.body);
      
      // Convert hex key to Buffer
      const key = Buffer.from(keyHex, 'hex');
      if (key.length === 0) {
        return res.status(400).json({
          message: "Invalid key",
          error: "Key must be non-empty hex string"
        });
      }

      const receiptSig = signReceipt(data as Record<string, unknown>, kid, key);
      const canonical = canonicalDumps(data);

      res.json({
        receipt_sig: receiptSig,
        canonical
      });
    } catch (err) {
      if (err instanceof SignatureError) {
        return res.status(400).json({
          message: "Signing failed",
          error: err.message
        });
      }
      if (err instanceof CanonicalizationError) {
        return res.status(400).json({
          message: "Canonicalization failed",
          error: err.message
        });
      }
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
      }
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  // Verify endpoint
  app.post(api.canonical.verify.path, async (req, res) => {
    try {
      const { data, receipt_sig, kidToKeyHex } = api.canonical.verify.input.parse(req.body);
      
      // Convert hex keys to Buffer map
      const kidToKey = new Map<string, Buffer>();
      for (const [kid, hexKey] of Object.entries(kidToKeyHex)) {
        kidToKey.set(kid, Buffer.from(hexKey, 'hex'));
      }

      const valid = verifyReceipt(
        data as Record<string, unknown>,
        receipt_sig,
        kidToKey
      );

      const response: { valid: boolean; canonical?: string } = { valid };
      
      if (valid) {
        try {
          response.canonical = canonicalDumps(data);
        } catch {
          // If canonicalization fails during verify, still return valid status
        }
      }

      res.json(response);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
      }
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  // Decision endpoint
  app.post(api.canonical.decide.path, async (req, res) => {
    try {
      const { requiredPredicates, predicateResults, forceEscalate } = 
        api.canonical.decide.input.parse(req.body);

      const decision = decide({
        requiredPredicates,
        predicateResults,
        forceEscalate,
      });

      res.json(decision);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
      }
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  // =====================
  // Evidence Endpoints
  // =====================

  // Register evidence
  app.post(api.evidence.register.path, async (req, res) => {
    try {
      const { evidenceType, payloadBase64, meta } = api.evidence.register.input.parse(req.body);
      
      const payload = Buffer.from(payloadBase64, 'base64');
      
      const record = globalRegistry.register({
        evidenceType: evidenceType as EvidenceType,
        payload,
        meta,
      });

      res.json(record);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
      }
      if (err instanceof Error) {
        return res.status(400).json({
          message: "Registration failed",
          error: err.message
        });
      }
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  // Get evidence record by ID
  app.get(api.evidence.get.path, async (req, res) => {
    const { id } = req.params;
    const record = globalRegistry.get(id as string);
    
    if (!record) {
      return res.status(404).json({ message: "Evidence not found" });
    }

    res.json(record);
  });

  // Get evidence payload by ID
  app.get(api.evidence.getPayload.path, async (req, res) => {
    const { id } = req.params;
    const payload = globalRegistry.getPayload(id as string);
    
    if (!payload) {
      return res.status(404).json({ message: "Payload not found or not shared" });
    }

    res.json({ payloadBase64: payload.toString('base64') });
  });

  // Get evidence index (juror-safe)
  app.get(api.evidence.index.path, async (req, res) => {
    res.json(globalRegistry.exportIndex());
  });

  // Validate citations
  app.post(api.evidence.validateCitations.path, async (req, res) => {
    try {
      const { citedIds } = api.evidence.validateCitations.input.parse(req.body);
      
      const valid = validateCitations(citedIds, globalRegistry);
      
      if (!valid) {
        const missingIds = citedIds.filter(id => !globalRegistry.has(id));
        return res.json({ valid: false, missingIds });
      }

      res.json({ valid: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
      }
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  // =====================
  // Contract Endpoints
  // =====================

  // Build juror prompt
  app.post(api.contract.buildPrompt.path, async (req, res) => {
    try {
      const { role, caseId, predicates, evidenceIndex } = 
        api.contract.buildPrompt.input.parse(req.body);

      const prompt = buildJurorPrompt({
        role,
        caseId,
        predicates,
        evidenceIndex: evidenceIndex as Record<string, unknown>,
      });

      res.json({
        prompt,
        contractVersion: JUROR_CONTRACT_VERSION,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
      }
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  // Normalize juror output
  app.post(api.contract.normalizeOutput.path, async (req, res) => {
    try {
      const { rawText, allowedPredicates } = 
        api.contract.normalizeOutput.input.parse(req.body);

      const outputs = normalizeJurorOutput(rawText, allowedPredicates);

      res.json({ outputs });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
      }
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  // Process juror response (normalize + enforce citations)
  app.post(api.contract.processResponse.path, async (req, res) => {
    try {
      const { rawText, allowedPredicates } = 
        api.contract.processResponse.input.parse(req.body);

      const { outputs, diagnostics } = processJurorResponse(
        rawText,
        allowedPredicates,
        globalRegistry
      );

      res.json({ outputs, diagnostics });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
      }
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  // =====================
  // Session Endpoints
  // =====================

  // Run a complete JQS session
  app.post(api.session.run.path, async (req, res) => {
    try {
      const { 
        caseId, 
        requiredPredicates, 
        jurorInputs, 
        signerKid, 
        signerKeyHex,
        forceEscalate 
      } = api.session.run.input.parse(req.body);

      const signerKey = Buffer.from(signerKeyHex, 'hex');
      if (signerKey.length === 0) {
        return res.status(400).json({
          message: "Invalid signer key",
          error: "Key must be non-empty hex string"
        });
      }

      const result = runSessionInMemory({
        caseId,
        requiredPredicates,
        jurorInputs,
        evidenceRegistry: globalRegistry,
        signerKid,
        signerKey,
        forceEscalate,
      });

      res.json(result);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid request format",
          error: err.message
        });
      }
      res.status(500).json({
        message: "Internal server error",
        error: String(err)
      });
    }
  });

  // =====================
  // IF Space LLM Bridge
  // =====================

  const QUORUM_MODE = process.env.QUORUM_MODE || "off";
  const JUROR_MODEL = "gpt-4o-mini";

  // --- Verdict Envelope Juror Prompt ---
  const verdictPrompt = `
You are a reasoning juror. Analyze the user's IF statement and produce a verdict.

Respond ONLY in strict JSON with this exact structure:
{
  "status": "CONCLUDE" | "NEED_MORE_DETAIL" | "ESCALATE_HUMAN",
  "then": "what logically follows (only if CONCLUDE)",
  "rules_out": ["list of excluded options (only if justified by IF)"],
  "need_detail": "ONE specific question to ask (only if NEED_MORE_DETAIL)",
  "citations": ["exact quoted phrases from the IF that support your reasoning"]
}

Rules:
- CONCLUDE: Only if you can state a direct consequence from the IF.
- NEED_MORE_DETAIL: If constraints are missing or ambiguous.
- ESCALATE_HUMAN: If it's a value judgment or policy choice.
- citations: Quote exact phrases from the user's IF that ground your reasoning.
- rules_out: Only include if you can cite the exact phrase from IF that justifies it.
- Be concise. No speculation. No advice.
`;

  const verifierPrompt = `
You are a verifier juror.

Rules:
- Answer ONLY "YES" or "NO".
- Question: Does the primary answer strictly follow from the user's IF?
- If ANY assumption is made that is not in the IF, answer NO.
`;

  const gapPrompt = `
You are a gap-checking juror.

Rules:
- Answer ONLY "YES" or "NO".
- Question: Is there missing information required before a conclusion can follow?
- If more constraints are needed, answer YES.
`;

  // Raw text model call for ANALYZE mode (no JSON, no verdict envelope)
  async function callModelRawText(prompt: string, systemPrompt?: string): Promise<string> {
    const messages: { role: "system" | "user"; content: string }[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });
    
    const response = await openai.chat.completions.create({
      model: JUROR_MODEL,
      messages,
      temperature: 0.3,
      max_completion_tokens: 2000,
    });
    return response.choices?.[0]?.message?.content?.trim() || "";
  }

  async function runVerdictJuror(userQuestion: string): Promise<string> {
    const response = await openai.chat.completions.create({
      model: JUROR_MODEL,
      messages: [
        { role: "system", content: verdictPrompt },
        { role: "user", content: userQuestion }
      ],
      temperature: 0,
      max_completion_tokens: 300,
      response_format: { type: "json_object" },
    });
    return response.choices?.[0]?.message?.content?.trim() || "";
  }

  async function runVerifierJuror(ifText: string, verdict: VerdictEnvelope): Promise<string> {
    const content = `IF: "${ifText}"\nVERDICT: ${JSON.stringify(verdict)}`;
    const response = await openai.chat.completions.create({
      model: JUROR_MODEL,
      messages: [
        { role: "system", content: verifierPrompt },
        { role: "user", content: content }
      ],
      temperature: 0,
      max_completion_tokens: 3
    });
    return response.choices?.[0]?.message?.content?.trim().toUpperCase() || "NO";
  }

  async function runGapJuror(ifText: string, verdict: VerdictEnvelope): Promise<string> {
    const content = `IF: "${ifText}"\nVERDICT: ${JSON.stringify(verdict)}`;
    const response = await openai.chat.completions.create({
      model: JUROR_MODEL,
      messages: [
        { role: "system", content: gapPrompt },
        { role: "user", content: content }
      ],
      temperature: 0,
      max_completion_tokens: 3
    });
    return response.choices?.[0]?.message?.content?.trim().toUpperCase() || "YES";
  }

  function applyModeWrapper(userPrompt: string, mode: "STRICT" | "ANALYZE"): string {
    const p = (userPrompt ?? "").trim();

    if (mode === "ANALYZE") {
      return [
        "MODE: ANALYZE",
        "Task: Provide a long-form, structured analysis.",
        "Rules:",
        "- Do NOT claim 'what follows' as a forced conclusion.",
        "- Do NOT request more constraints unless absolutely necessary; if needed, ask at most 2 questions at the end.",
        "Output format:",
        "1) Framing (what is being asked / what can be answered safely)",
        "2) Design space (options + tradeoffs)",
        "3) A plausible example plan (clearly labeled as an example, not 'the answer')",
        "",
        p,
      ].join("\n");
    }

    // STRICT default
    return [
      "MODE: STRICT",
      "Task: Treat this as an 'IF → THEN what follows?' entailment check.",
      "Rule: If underdetermined, say so briefly and propose 1–2 minimal missing constraints.",
      "",
      p,
    ].join("\n");
  }

  app.post("/api/ifspace/run", async (req, res) => {
    try {
      const { question, mode, add_detail } = req.body;
      const safeMode: GovernorMode = mode === "ANALYZE" ? "ANALYZE" : "STRICT";
      
      // CODE CRYPT HOOK 1: Log incoming user text
      crypt_logIncomingUserText(String(question ?? ""), {
        route: "/api/ifspace/run",
        mode: safeMode,
        hasAddDetail: Boolean(add_detail),
        addDetailValue: add_detail ?? null,
      });

      // ============================================================
      // RESEARCH GOVERNOR PATH — Short-circuit before normal gates
      // Triggers when: mode=RESEARCH, "Role: Research", or "Research Topic"
      // ============================================================
      const rawQ = String(question ?? "");
      const rawAdd = String(add_detail ?? "");
      const rawMode = String(mode ?? "").toUpperCase();
      
      const isResearch =
        rawMode === "RESEARCH" ||
        /^role:\s*research/i.test(rawQ) ||
        /^research topic/i.test(rawQ);

      if (isResearch) {
        crypt_logGateSnapshot({
          gateName: "RESEARCH_GOVERNOR_GATE",
          isSettled: true,
          missing: [],
          state: { rawQ: rawQ.slice(0, 200), rawAdd: rawAdd.slice(0, 200), rawMode },
        });

        const researchOut = await runResearchGovernor({
          topic: rawQ,
          addDetail: rawAdd,
          mode: rawMode === "STRICT" ? "STRICT" : "ANALYZE",
          callModel: async (p: string) => {
            crypt_logModelDispatch({
              finalPrompt: p,
              modelName: "gpt-4o-mini",
              mode: "RESEARCH",
            });
            return await callModelRawText(p, PRIMARY_JUROR_SYSTEM);
          },
        });

        return res.json({
          status: "ok",
          mode: rawMode || "ANALYZE",
          stands: rawQ.replace(/^(role:\s*research|research topic)[:\s]*/i, "").trim().slice(0, 100),
          follows: researchOut,
          rulesOut: "",
          notes: [],
        });
      }
      
      // Check for continuation override first, then fall back to mode wrapper
      const continuationPrompt = buildPrompt(String(question ?? ""), safeMode);
      const basePrompt = continuationPrompt || applyModeWrapper(String(question ?? ""), safeMode);
      
      // Apply Governor constraints to the prompt
      const finalPrompt = applyGovernorToPrompt(basePrompt, safeMode);

      if (!question || question.trim().length < 5) {
        // CODE CRYPT HOOK 2: Log gate snapshot for insufficient input
        const snap = {
          gateName: "INPUT_LENGTH_GATE",
          isSettled: false,
          missing: ["question_text"],
          stateKeys: ["question", "mode", "add_detail"],
          state: { question, mode, add_detail },
        };
        crypt_logGateSnapshot(snap);
        crypt_detectMismatch(String(question ?? ""), snap);
        
        return res.json({
          status: "insufficient",
          message: "Not enough information yet.",
          prompts: ["Clarify what must be true", "Add one constraint"],
        });
      }

      const cleanIf = question.trim().replace(/^if\s+/i, "").replace(/\?$/, "").trim();

      // ANALYZE mode: call raw text model directly, bypass all verdict/quorum/jury code
      if (safeMode === "ANALYZE") {
        // CODE CRYPT HOOK 2: Log gate snapshot for ANALYZE mode proceeding
        crypt_logGateSnapshot({
          gateName: "ANALYZE_MODE_GATE",
          isSettled: true,
          missing: [],
          stateKeys: ["question", "mode", "add_detail", "finalPrompt"],
          state: { question, mode, add_detail, promptLength: finalPrompt?.length },
        });
        
        // CODE CRYPT HOOK 3: Log model dispatch for ANALYZE mode
        crypt_logModelDispatch({
          finalPrompt,
          modelName: "gpt-4o-mini",
          mode: "ANALYZE",
        });
        
        // Use enforced wrapper with PRIMARY_JUROR_SYSTEM for format compliance
        const rawText = await callPrimaryJurorEnforced(finalPrompt, async (prompt) => {
          return callModelRawText(prompt, PRIMARY_JUROR_SYSTEM);
        });
        // Strip any boilerplate that leaked through
        const strippedText = stripBoilerplateIfPresent(rawText);
        // Apply continuation mode normalization if detected
        const outText = normalizeForMode({ mode: safeMode, promptText: finalPrompt, modelText: strippedText });
        
        // ==== OBLIGATION ENFORCEMENT: hard fail on violated obligations ====
        const finalizedText = finalizePrimaryOutput(outText);
        
        // ==== HARD GUARANTEE (ANALYZE): never block; never show dead-ends ====
        // If anything upstream returned a blocker, override it into a renderable answer.
        const prelimEnvelope = { then: finalizedText, text: finalizedText, content: finalizedText, status: "CONCLUDE" as const };
        
        // Apply kernel-side downgrade AFTER all processing, BEFORE UI render
        // This fixes the "Impossibility occurs at step 2..." loop in ANALYZE mode.
        const downgraded = downgradeImpossibilityInAnalyze(prelimEnvelope, safeMode);
        const forced = hardAnalyzeLetThrough(downgraded);
        
        return res.json({
          status: "ok",
          stands: cleanIf,
          follows: forced.then,
          rulesOut: "",
          notes: downgraded.notes || [],
        });
      }

      // STRICT mode only below this point
      // CODE CRYPT HOOK 2: Log gate snapshot for STRICT mode proceeding
      crypt_logGateSnapshot({
        gateName: "STRICT_MODE_GATE",
        isSettled: true,
        missing: [],
        stateKeys: ["question", "mode", "add_detail", "finalPrompt"],
        state: { question, mode, add_detail, promptLength: finalPrompt?.length },
      });
      
      // CODE CRYPT HOOK 3: Log model dispatch for STRICT mode
      crypt_logModelDispatch({
        finalPrompt,
        modelName: "gpt-4o-mini",
        mode: "STRICT",
      });
      
      // Step 1: Primary juror generates verdict envelope
      const rawVerdict = await runVerdictJuror(finalPrompt);

      if (!rawVerdict) {
        return res.json({
          status: "insufficient",
          message: "Unable to reason about this.",
          prompts: ["Rephrase the question"],
        });
      }

      // Normalize through VerdictEnvelope (applies all guards)
      const envelope = normalizeVerdictEnvelope(question, rawVerdict, JUROR_MODEL);

      // Step 2: Quorum voting (if enabled and status is CONCLUDE)
      // Note: ANALYZE mode already returned above, so this is STRICT mode only

      if (QUORUM_MODE === "triple" && envelope.status === "CONCLUDE") {
        const [verifierVote, gapVote] = await Promise.all([
          runVerifierJuror(question, envelope),
          runGapJuror(question, envelope),
        ]);

        const verified = verifierVote.startsWith("YES");
        const hasGap = gapVote.startsWith("YES");
        const wouldBlock = !verified || hasGap;

        // ANALYZE mode already returned above, so this is STRICT mode blocking
        if (wouldBlock) {
          return res.json({
            status: "ok",
            stands: cleanIf,
            follows: hasGap 
              ? "more constraints are needed before a conclusion can follow."
              : "the reasoning could not be verified. Add more detail.",
            rulesOut: "",
          });
        }
      }

      // Map envelope to API response
      // FORCE: always prefer PRIMARY juror's "then" field
      const thenText = extractPrimaryThen(envelope);
      const notes = extractNotes(envelope);
      
      // Hard fail-safe: if we didn't find primary "then", do NOT output blocker prose
      const safeThen = thenText || "Then: I can proceed, but I need the primary answer channel wired correctly (primary.then).";
      
      // STRICT mode only (ANALYZE already returned above)
      if (envelope.status === "CONCLUDE") {
        const rawRulesOut = envelope.rules_out?.join("; ") || "";
        const gated = enforceRulesOutGate(question, safeThen, rawRulesOut);
        const finalFollows = gated.thenText?.trim().length ? gated.thenText : safeThen;
        res.json({
          status: "ok",
          stands: cleanIf,
          follows: finalFollows,
          rulesOut: gated.rulesOutText,
          notes,
        });
      } else if (envelope.status === "NEED_MORE_DETAIL") {
        res.json({
          status: "insufficient",
          message: envelope.need_detail || "More detail needed.",
          prompts: ["Add a specific constraint"],
          notes,
        });
      } else {
        // ESCALATE_HUMAN - STRICT mode only (ANALYZE already returned above)
        res.json({
          status: "ok",
          stands: cleanIf,
          follows: "this is a value judgment that requires human decision.",
          rulesOut: "",
          notes,
        });
      }

    } catch (err) {
      console.error(err);
      res.status(500).json({ status: "error" });
    }
  });

  return httpServer;
}
