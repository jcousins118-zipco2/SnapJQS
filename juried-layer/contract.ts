/**
 * juried-layer/contract.ts
 * 
 * JUROR CONTRACT
 * 
 * Vendor-agnostic prompt builder + strict output contract + citation enforcement.
 * 
 * Responsibilities:
 *   - Define the expected juror output schema (JSON list of objects)
 *   - Generate prompts for predicate evaluation with evidence index
 *   - Enforce citation policy (DISPROVEN must cite ≥1 valid evidence_id)
 *   - Wrap primary juror calls with Governor enforcement (artifact or fallback)
 * 
 * Philosophy:
 *   - "Proof is silent": PROVEN needs no justification
 *   - "Disproof must be actionable": DISPROVEN requires verdict_code + valid citations
 *   - Any malformed output degrades to UNKNOWN / ignored (fail-closed)
 */

import { PredicateStatus, STATUS_ALIASES, EvidenceRegistry, validateCitations } from "./types";
import {
  governorAccepts,
  applyObligationLint,
  forceFullArtifactRepairPrompt,
  fallbackFullPlanArtifact,
} from "./governor";

export const JUROR_CONTRACT_VERSION = "jqs.juror.contract.v0.5.1";

// ── Uniform juror system prompt ───────────────────────────────────────────────

/**
 * All jurors receive the same system prompt.
 * Eliminates role-induced semantic drift.
 */
export const UNIFORM_JUROR_SYSTEM_PROMPT = `
You are a JUROR.

Your role is identical to all other jurors.

You MUST:
- Interpret steps, obligations, and dependencies literally.
- Treat obligations as binding constraints, not goals.
- Never reinterpret, soften, or narratively reframe obligations.
- Never invent new mechanisms, actors, tools, or scope.
- If an audit invalidates an assumption, only Narrow or Suspend the affected step.
- Re-thread dependencies to the last non-suspended step.
- If an obligation is violated by a later step, mark THAT step INVALID.
- Do NOT repair, rewrite, or compensate for violations.
- Do NOT escalate or refuse; output a full plan artifact.

Output format MUST exactly match the requested plan format.
No explanations. No framing. No meta-commentary.
`.trim();

export function buildUniformJurors(n: number): Array<{ systemPrompt: string }> {
  return Array.from({ length: n }, () => ({ systemPrompt: UNIFORM_JUROR_SYSTEM_PROMPT }));
}

// ── Primary juror hard contract ───────────────────────────────────────────────

export const PRIMARY_JUROR_SYSTEM = `
You are a JUROR.

Your role is identical to all other jurors.

UNIFORM INTERPRETATION (binding):
- Interpret steps, obligations, and dependencies literally.
- Treat obligations as binding constraints, not goals.
- Never reinterpret, soften, or narratively reframe obligations.
- Never invent new mechanisms, actors, tools, or scope.

You MUST obey the user's instructions exactly.

KERNEL-PASS CONTRACT (binding):
You are not allowed to output: "impossible", "cannot", "more constraints needed", "requires human", "escalate", "not settled", or any equivalent refusal language.

You MUST always produce a continuable artifact in the requested format.

If information is missing or the space is underspecified:
- You must proceed using the weakest safe assumptions.
- Put uncertainty only in a "NOTES:" line inside the output.
- Do not ask questions.
- Do not block.

If an audit shows a step relied on a false assumption:
- Mark that step as NARROWED or SUSPENDED.
- Re-thread downstream steps to depend on the last non-suspended predecessor.
- Do not introduce new mechanisms/actors/tools.

OBLIGATION VIOLATION HANDLING:
If an obligation from an earlier step is violated by a later step:
- Mark THAT later step as INVALID.
- Do NOT repair, rewrite, or compensate for violations.
- Do NOT escalate or refuse; output a full plan artifact with local INVALID marks.

HARD OUTPUT CONTRACT (non-negotiable):
- Start immediately at Step 1. No preamble.
- Do NOT write headings such as: "Framing", "Design Space", "Example Plan", "Options", "Trade-offs".
- Do NOT restate or summarize the prompt.
- Output ONLY the plan in the user's required format.
- If a format is not specified, use this exact format:

Step N — <short title>
Action: <one sentence>
Obligation: <one sentence stating what must remain true for later steps>
Dependency: <reference earlier step(s); Step 1 must use "PREMISE">
Status: <Active | Narrowed | Suspended | INVALID>

CONSTRAINT ENFORCEMENT:
- Steps are ordered and binding once stated.
- You may NOT rewrite or delete any committed step.
- If an audit shows a step relied on a false assumption:
  - You may ONLY narrow, suspend, or add constraints to that step.
- If "no new mechanisms/actors/tools" is stated, introduce NONE.
- Public statements that cannot be retracted must be honored via narrowing, scoping, or suspension—not contradiction.

Output only the plan. No preamble. No explanations. No framing. No meta-commentary.
`.trim();

// ── Contract violation detection ──────────────────────────────────────────────

function violatesContract(text: string): boolean {
  const t = text.toLowerCase();
  const hasForbiddenHeadings = (
    t.includes("framing") || t.includes("design space") || t.includes("example plan") ||
    t.includes("options") || t.includes("trade-off") || t.includes("tradeoffs") ||
    t.includes("analysis") || t.includes("plausible")
  );
  const isObligationInvalid = t.startsWith("invalid\n");
  const hasRefusalLanguage = !isObligationInvalid && (
    t.includes("impossible") || t.includes("cannot") ||
    t.includes("more constraints needed") || t.includes("requires human") ||
    t.includes("escalate") || t.includes("not settled")
  );
  return hasForbiddenHeadings || hasRefusalLanguage;
}

function formatCorrectionPrompt(userPrompt: string): string {
  return `
FORMAT CORRECTION (FINAL ATTEMPT):
You violated the HARD OUTPUT CONTRACT.
Re-output ONLY the plan.
Start at Step 1.
No headings. No preamble. No explanations.
Follow the user's rules exactly.

USER PROMPT (binding):
${userPrompt}
`.trim();
}

// ── Hard plan validation ──────────────────────────────────────────────────────

function parseSteps(text: string): Array<{ n: number; dep: string; status: string; body: string }> {
  const steps: Array<{ n: number; dep: string; status: string; body: string }> = [];
  const re = /Step\s+(\d+)\s+—[\s\S]*?(?=(?:\nStep\s+\d+\s+—)|$)/g;
  const blocks = text.match(re) ?? [];
  for (const b of blocks) {
    const n      = Number((b.match(/Step\s+(\d+)/) ?? [])[1]);
    const dep    = ((b.match(/Dependency:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    const status = ((b.match(/Status:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    steps.push({ n, dep, status, body: b });
  }
  return steps;
}

function hasSomeDependency(s: { n: number; dep: string }): boolean {
  const dep = (s.dep || "").trim();
  if (!dep) return false;
  if (s.n === 1 && /PREMISE/i.test(dep)) return true;
  const refs = Array.from(dep.matchAll(/Step\s*(\d+)/gi)).map(m => Number(m[1]));
  return refs.some(r => Number.isFinite(r) && r < s.n);
}

function hasObligationLine(block: string): boolean {
  return /Obligation:\s*[^\n]+/i.test(block);
}

function buildDependencyGraph(steps: ReturnType<typeof parseSteps>): Map<number, number[]> {
  const g = new Map<number, number[]>();
  for (const s of steps) {
    const refs = Array.from((s.dep || "").matchAll(/Step\s*(\d+)/gi))
      .map(m => Number(m[1])).filter(n => Number.isFinite(n));
    g.set(s.n, refs);
  }
  return g;
}

function dependsOnStep(target: number, stepN: number, graph: Map<number, number[]>, seen = new Set<number>()): boolean {
  if (stepN === target) return true;
  if (seen.has(stepN)) return false;
  seen.add(stepN);
  const deps = graph.get(stepN) || [];
  for (const d of deps) {
    if (d === target) return true;
    if (dependsOnStep(target, d, graph, seen)) return true;
  }
  return false;
}

function downstreamMustThreadAudit(steps: ReturnType<typeof parseSteps>): boolean {
  const s3 = steps.find(s => s.n === 3);
  if (!s3) return true;
  const graph = buildDependencyGraph(steps);
  for (const s of steps) {
    if (s.n <= 3) continue;
    const status      = (s.status || "").toLowerCase();
    const isActive    = status.includes("active") || status.includes("narrow");
    const isSuspended = status.includes("suspend");
    if (isSuspended || !isActive) continue;
    if (!dependsOnStep(3, s.n, graph)) return true;
  }
  return false;
}

function dependsOnSuspended(steps: ReturnType<typeof parseSteps>): boolean {
  const suspended = new Set<number>();
  for (const s of steps) {
    if (s.status.toLowerCase().includes("suspend")) suspended.add(s.n);
  }
  for (const s of steps) {
    if (!s.dep) continue;
    const refs = Array.from(s.dep.matchAll(/Step\s*(\d+)/gi)).map(m => Number(m[1]));
    for (const r of refs) {
      if (suspended.has(r) && !s.status.toLowerCase().includes("suspend")) return true;
    }
  }
  return false;
}

function auditStepNotHandled(steps: ReturnType<typeof parseSteps>): boolean {
  const s3 = steps.find(s => s.n === 3);
  if (!s3) return true;
  const body   = s3.body.toLowerCase();
  const status = s3.status.toLowerCase();
  const mentionsAudit     = body.includes("audit") || body.includes("assumption") || body.includes("false");
  const isNarrowOrSuspend = status.includes("narrow") || status.includes("suspend");
  return !(mentionsAudit && isNarrowOrSuspend);
}

function violatesHardPlanLogic(text: string): boolean {
  const steps = parseSteps(text);
  if (steps.length < 3) return true;
  for (const s of steps) {
    if (!hasSomeDependency(s)) return true;
    if (!hasObligationLine(s.body)) return true;
  }
  if (dependsOnSuspended(steps)) return true;
  if (auditStepNotHandled(steps)) return true;
  if (downstreamMustThreadAudit(steps)) return true;
  return false;
}

function logicCorrectionPrompt(userPrompt: string): string {
  return `
FINAL CORRECTION (ONE TRY):
You MUST output EXACTLY 7 steps, each in this exact format:

Step N — <short name>
Action: <one sentence>
Obligation: <one sentence stating what must remain true for later steps>
Dependency: Step X (or "PREMISE" only for Step 1)
Status: Active | Narrowed | Suspended

Hard rules:
- Every step MUST include an Obligation line.
- Step 1 MUST use: "Dependency: PREMISE"
- No Active/Narrowed step may depend on any Suspended step.
- Step 3 MUST explicitly mention the audit / false assumption AND its Status MUST be Narrowed or Suspended.
- All Active/Narrowed steps AFTER Step 3 MUST (directly or indirectly) depend on Step 3.
- Downstream steps MUST re-thread dependencies to the last valid predecessor WITHOUT introducing any new mechanisms/actors/tools.
- No headings, no framing, no design space, no example plan, no extra text.
- Output ONLY the 7 steps.

USER PROMPT (binding):
${userPrompt}
`.trim();
}

// ── Obligation enforcement ────────────────────────────────────────────────────

type ObligationStep = { n: number; action: string; obligation: string; status: string; body: string };

function parseStepsWithObligations(text: string): ObligationStep[] {
  const steps: ObligationStep[] = [];
  const re = /Step\s+(\d+)\s+—[\s\S]*?(?=(?:\nStep\s+\d+\s+—)|$)/g;
  const blocks = text.match(re) ?? [];
  for (const b of blocks) {
    const n          = Number((b.match(/Step\s+(\d+)/) ?? [])[1]);
    const action     = ((b.match(/Action:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    const obligation = ((b.match(/Obligation:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    const status     = ((b.match(/Status:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    steps.push({ n, action, obligation, status, body: b });
  }
  return steps;
}

function violatesAnyObligation(steps: ObligationStep[]): number | null {
  const obligations: { step: number; rule: string }[] = [];
  for (const s of steps) {
    if (s.obligation) obligations.push({ step: s.n, rule: s.obligation.toLowerCase() });
  }
  for (const s of steps) {
    for (const o of obligations) {
      if (s.n <= o.step) continue;
      const body = s.body.toLowerCase();
      if (o.rule && (body.includes("revise") || body.includes("expand") || body.includes("adjust"))) {
        return s.n;
      }
    }
  }
  return null;
}

function enforceObligationInvalidation(text: string): string {
  const steps = parseStepsWithObligations(text);
  const violatingStep = violatesAnyObligation(steps);
  if (!violatingStep) return text;
  return `INVALID\nStep ${violatingStep} violates an obligation created by an earlier step and cannot be repaired or rewritten.`;
}

export function finalizePrimaryOutput(text: string): string {
  return enforceObligationInvalidation(text);
}

// ── Governor-enforced primary juror wrapper ───────────────────────────────────

/**
 * Drop-in wrapper for your primary model call.
 * callPrimaryJuror: async (prompt: string) => string  — inject your OpenAI / Anthropic call here.
 * 
 * Flow:
 *   1. Obligation lint (prevents poison obligations from entering)
 *   2. First model call
 *   3. Governor check → if rejected, repair prompt + second call
 *   4. Governor check → if still rejected, deterministic fallback artifact
 */
export async function callPrimaryJurorEnforced(
  userPrompt: string,
  callPrimaryJuror: (prompt: string) => Promise<string>
): Promise<string> {
  const governedPrompt = applyObligationLint(userPrompt);

  const first = ((await callPrimaryJuror(governedPrompt)) ?? "").trim();
  if (governorAccepts(first)) return first;

  const repairPrompt = forceFullArtifactRepairPrompt(userPrompt, first);
  const second = ((await callPrimaryJuror(repairPrompt)) ?? "").trim();
  if (governorAccepts(second)) return second;

  return fallbackFullPlanArtifact();
}

// ── Juror output model ────────────────────────────────────────────────────────

export interface RawJurorOutput {
  predicateId: string;
  status: PredicateStatus;
  verdictCode: string;       // REQUIRED iff status === DISPROVEN
  citedEvidenceIds: string[]; // REQUIRED iff status === DISPROVEN
}

// ── Prompt builder ────────────────────────────────────────────────────────────

export function buildJurorPrompt(options: {
  role: string;
  caseId: string;
  predicates: string[];
  evidenceIndex: Record<string, unknown>;
}): string {
  const { role, caseId, predicates, evidenceIndex } = options;
  const evJson = JSON.stringify(evidenceIndex, Object.keys(evidenceIndex).sort());
  const preds  = predicates.map((p) => `- ${p}`).join("\n");

  return `JQS JUROR TASK (v=${JUROR_CONTRACT_VERSION})

ROLE: ${role}
CASE_ID: ${caseId}

You are a juror. You do NOT execute actions. You only evaluate predicates based on the provided evidence index.

PREDICATES TO EVALUATE:
${preds}

EVIDENCE INDEX (do NOT invent IDs; cite only from this index):
${evJson}

OUTPUT FORMAT (STRICT):
Return JSON ONLY. No prose. No markdown.
Return a JSON array of objects. Each object MUST have:
- "predicate_id": string (must match one of the predicates above)
- "status": "PROVEN" | "DISPROVEN" | "UNKNOWN" | "ABSTAIN"

If status == "DISPROVEN", you MUST also include:
- "verdict_code": short machine-readable code (non-empty)
- "cited_evidence_ids": array of evidence_id strings (REQUIRED; must contain at least 1 valid ID from the evidence index)

If status != "DISPROVEN":
- "verdict_code" may be omitted or empty
- "cited_evidence_ids" may be omitted or empty

IMPORTANT ENFORCEMENT NOTE:
DISPROVEN without a non-empty verdict_code AND at least one VALID cited_evidence_id will be DOWNGRADED to UNKNOWN (ignored as a veto).

Return JSON now.
`;
}

// ── Normalization helpers ─────────────────────────────────────────────────────

function parseStatus(x: unknown): PredicateStatus {
  if (typeof x === "string") {
    const u = x.trim().toUpperCase();
    return STATUS_ALIASES[u] || "UNKNOWN";
  }
  return "UNKNOWN";
}

function parseStr(x: unknown, maxLen: number = 120): string {
  if (typeof x !== "string") return "";
  let s = x.trim();
  if (!s) return "";
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function parseCitedIds(x: unknown, maxItems: number = 32, maxLen: number = 80): string[] {
  if (!Array.isArray(x)) return [];
  const out: string[] = [];
  for (const item of x) {
    if (typeof item === "string" || typeof item === "number") {
      const s = String(item).trim();
      if (s && s.length <= maxLen) out.push(s);
    }
    if (out.length >= maxItems) break;
  }
  return out;
}

// ── Output normalization ──────────────────────────────────────────────────────

/**
 * Parse juror output text into normalized objects.
 * Fail-closed: not valid JSON array → []; bad entry → dropped/UNKNOWN.
 */
export function normalizeJurorOutput(
  rawText: string,
  allowedPredicates: string[]
): RawJurorOutput[] {
  let parsed: unknown;
  try { parsed = JSON.parse(rawText); } catch { return []; }
  if (!Array.isArray(parsed)) return [];

  const allowed = new Set(allowedPredicates);
  const out: RawJurorOutput[] = [];

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const itemObj = item as Record<string, unknown>;
    const pid = parseStr(itemObj.predicate_id, 96);
    if (!pid || !allowed.has(pid)) continue;

    out.push({
      predicateId:      pid,
      status:           parseStatus(itemObj.status),
      verdictCode:      parseStr(itemObj.verdict_code, 64),
      citedEvidenceIds: parseCitedIds(itemObj.cited_evidence_ids),
    });
  }
  return out;
}

// ── Citation enforcement ──────────────────────────────────────────────────────

export interface EnforcementDiagnostics {
  downgradedDisprovenMissingVerdictCode: number;
  downgradedDisprovenMissingCitations: number;
  downgradedDisprovenInvalidCitations: number;
  kept: number;
}

/**
 * Enforce: DISPROVEN must be grounded.
 *   - verdict_code must be non-empty
 *   - cited_evidence_ids must contain ≥1 valid existing evidence_id
 * Asymmetric trust: we are much stricter on DISPROVEN than on PROVEN.
 */
export function enforceCitationPolicy(
  normalized: RawJurorOutput[],
  registry: EvidenceRegistry
): { patched: RawJurorOutput[]; diagnostics: EnforcementDiagnostics } {
  const patched: RawJurorOutput[] = [];
  const diagnostics: EnforcementDiagnostics = {
    downgradedDisprovenMissingVerdictCode: 0,
    downgradedDisprovenMissingCitations:   0,
    downgradedDisprovenInvalidCitations:   0,
    kept: 0,
  };

  for (const r of normalized) {
    if (r.status !== "DISPROVEN") {
      patched.push(r);
      diagnostics.kept++;
      continue;
    }
    if (!r.verdictCode) {
      diagnostics.downgradedDisprovenMissingVerdictCode++;
      patched.push({ ...r, status: "UNKNOWN" });
      continue;
    }
    if (r.citedEvidenceIds.length === 0) {
      diagnostics.downgradedDisprovenMissingCitations++;
      patched.push({ ...r, status: "UNKNOWN" });
      continue;
    }
    if (!validateCitations(r.citedEvidenceIds, registry)) {
      diagnostics.downgradedDisprovenInvalidCitations++;
      patched.push({ ...r, status: "UNKNOWN" });
      continue;
    }
    patched.push(r);
    diagnostics.kept++;
  }

  return { patched, diagnostics };
}

/** Convenience: normalize + enforce in one step. */
export function processJurorResponse(
  rawText: string,
  allowedPredicates: string[],
  registry: EvidenceRegistry
): { outputs: RawJurorOutput[]; diagnostics: EnforcementDiagnostics } {
  const normalized = normalizeJurorOutput(rawText, allowedPredicates);
  const { patched, diagnostics } = enforceCitationPolicy(normalized, registry);
  return { outputs: patched, diagnostics };
}
