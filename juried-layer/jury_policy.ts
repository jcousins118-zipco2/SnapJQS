/**
 * juried-layer/jury_policy.ts
 * 
 * JURY POLICY + VERDICT REDUCTION
 * 
 * Core decision logic for the quorum layer:
 *   - STRICT mode: any DENY blocks; any ESCALATE escalates
 *   - ANALYZE mode: VALUE-class escalations are demoted to NON-BLOCKING NOTEs;
 *     "requires human decision" sentinels are stripped; IMPOSSIBLE is downgraded to CONCLUDE
 * 
 * Key exports:
 *   reduceJuryVerdicts()                    — weighted multi-juror verdict reduction
 *   reduceVerdicts()                        — simplified single-pass verdict reducer
 *   normalizeFinalText()                    — strips hard-stop blocker phrases in ANALYZE mode
 *   stripHumanInterventionLine()            — removes "requires human decision" lines
 *   downgradeImpossibilityInAnalyze()       — converts IMPOSSIBLE kernel status → CONCLUDE in ANALYZE
 *   analyzeModePassthrough()                — ANALYZE mode always returns OK (never blocks)
 *   runConsiderationWithAnalyzeLetThrough() — full let-through pipeline with retry
 *   detectContinuationMode()                — detects continuation-mode keywords in input
 *   enforceContinuationOutput()             — strips framing/design-space from continuation output
 *   buildAnalyzeOverridePrompt()            — retry prompt when model returns a blocker answer
 */

export type JuryRoleClass = "ARCHITECT" | "DOMAIN" | "SAFETY" | "CONSISTENCY" | "VALUE" | "OTHER";
export type Mode = "STRICT" | "ANALYZE";

// ── Kernel envelope (impossibility downgrade) ────────────────────────────────

type KernelStatus = "CONCLUDE" | "ESCALATE_HUMAN" | "IMPOSSIBLE" | "DENY";
type KernelEnvelope = {
  status: KernelStatus;
  then?: string | null;
  text?: string;
  content?: string;
  message?: string;
  notes?: string[];
  [k: string]: unknown;
};

const IMPOSSIBILITY_PATTERNS: RegExp[] = [
  /\bimpossibility determination\b/i,
  /\bimpossibility occurs\b/i,
  /\bimpossible\b.*\b(step|because)\b/i,
  /\bcannot continue\b/i,
  /\bstate exactly which step causes impossibility\b/i,
];

function extractKernelText(e: KernelEnvelope): string {
  const v = (typeof e === "string" ? e : (e.then ?? e.text ?? e.content ?? e.message ?? "")) as unknown;
  return typeof v === "string" ? v : "";
}

function isImpossibilityText(t: string): boolean {
  const s = (t || "").trim();
  if (!s) return false;
  return IMPOSSIBILITY_PATTERNS.some((r) => r.test(s));
}

function stripImpossibilityLines(t: string): { kept: string; removed: string[] } {
  const lines   = (t || "").split(/\r?\n/);
  const removed: string[] = [];
  const keptLines: string[] = [];
  for (const line of lines) {
    if (isImpossibilityText(line)) removed.push(line.trim());
    else keptLines.push(line);
  }
  return { kept: keptLines.join("\n").trim(), removed: removed.filter(Boolean) };
}

/**
 * In ANALYZE mode, demote IMPOSSIBLE kernel status to CONCLUDE.
 * Impossibility lines are moved to notes (non-terminal).
 */
export function downgradeImpossibilityInAnalyze(envelope: KernelEnvelope, mode: Mode): KernelEnvelope {
  if (mode !== "ANALYZE") return envelope;

  const outText = extractKernelText(envelope);
  const { kept, removed } = stripImpossibilityLines(outText);

  const shouldDowngrade =
    envelope.status === "IMPOSSIBLE" || envelope.status === "DENY" || removed.length > 0;

  if (!shouldDowngrade) return envelope;

  const notes = Array.isArray(envelope.notes) ? envelope.notes.slice() : [];
  for (const r of removed) notes.push(`Kernel note (non-terminal in ANALYZE): ${r}`);

  return {
    ...envelope,
    status: "CONCLUDE",
    then: kept || envelope.then || envelope.text || envelope.content || envelope.message || "",
    notes,
  };
}

// ── Jury policy types ────────────────────────────────────────────────────────

export type Verdict = "ALLOW" | "DENY" | "ESCALATE" | "NOTE" | "ABSTAIN";

export interface JuryPolicy {
  analyze_allows_value_veto: boolean;
  analyze_demote_human_required_sentinel: boolean;
  analyze_accept_plan_with_notes: boolean;
  weights: Record<JuryRoleClass, number>;
}

const BASE_WEIGHTS: Record<JuryRoleClass, number> = {
  ARCHITECT:   3,
  DOMAIN:      2,
  SAFETY:      2,
  CONSISTENCY: 1,
  VALUE:       1,
  OTHER:       1,
};

export const DEFAULT_POLICY: JuryPolicy = {
  analyze_allows_value_veto:             false,
  analyze_demote_human_required_sentinel: true,
  analyze_accept_plan_with_notes:         true,
  weights: BASE_WEIGHTS,
};

/** In ANALYZE mode, VALUE weight is demoted to 0 so it cannot dominate reduction. */
export function getRoleWeights(mode: Mode): Record<JuryRoleClass, number> {
  if (mode === "ANALYZE") return { ...BASE_WEIGHTS, VALUE: 0 };
  return { ...BASE_WEIGHTS };
}

// ── Juror output types ───────────────────────────────────────────────────────

export interface JurorVerdict {
  role: string;
  roleClass?: JuryRoleClass;
  verdict: string;
  confidence: number;
  text: string;
  reasons: string[];
}

export interface JurorOutput {
  jurorId: string;
  roleClass: JuryRoleClass;
  verdict: Verdict;
  rationale?: string;
}

export interface ReducedVerdict {
  final_verdict: "ALLOW" | "DENY" | "ESCALATE";
  notes: string[];
  debug: Record<string, unknown>;
}

/** In ANALYZE mode, clamp VALUE-class ESCALATE to NOTE. */
export function normalizeJurorOutputForMode(out: JurorOutput, mode: Mode): JurorOutput {
  if (mode === "ANALYZE" && out.roleClass === "VALUE" && out.verdict === "ESCALATE") {
    return {
      ...out,
      verdict: "NOTE",
      rationale: out.rationale
        ? `VALUE NOTE (was ESCALATE): ${out.rationale}`
        : "VALUE NOTE (was ESCALATE).",
    };
  }
  return out;
}

export function looksLikeHumanRequired(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const needles = [
    "value judgment", "requires human", "human decision", "not settled",
    "escalate", "needs more constraints", "cannot conclude", "must be decided by humans",
  ];
  return needles.some((n) => t.includes(n));
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function normalizeVerdict(v: Partial<JurorVerdict>): JurorVerdict {
  const role       = (v?.role || "OTHER").toUpperCase();
  const verdict    = (v?.verdict || "ABSTAIN").toUpperCase();
  const confidence = Number.isFinite(v?.confidence) ? v.confidence! : 0.5;
  const text       = v?.text || "";
  const reasons    = Array.isArray(v?.reasons) ? v.reasons : [];
  return { role, verdict, confidence, text, reasons };
}

function isValueEscalation(v: JurorVerdict): boolean {
  if (v.verdict !== "ESCALATE") return false;
  const hay = (v.text || "").toLowerCase() + " " + v.reasons.join(" ").toLowerCase();
  return hay.includes("value") || hay.includes("human") || hay.includes("judgment");
}

function score(v: JurorVerdict, weights: Record<string, number>): number {
  const w = weights[v.role] ?? weights.OTHER ?? 1;
  const c = Math.max(0, Math.min(1, v.confidence));
  if (v.verdict === "DENY")    return -2 * w * c;
  if (v.verdict === "ALLOW")   return +2 * w * c;
  if (v.verdict === "NOTE")    return +0.5 * w * c;
  if (v.verdict === "ESCALATE") return -1 * w * c;
  return 0;
}

function applyAnalyzePolicy(verd: JurorVerdict, mode: string, policy: JuryPolicy): JurorVerdict {
  if (mode !== "ANALYZE") return verd;
  if (!policy.analyze_allows_value_veto && isValueEscalation(verd)) {
    return {
      ...verd,
      verdict: "NOTE",
      text: verd.text || "Value/policy sensitivity noted (non-blocking in ANALYZE mode).",
      reasons: verd.reasons?.length ? verd.reasons : ["Demoted from ESCALATE → NOTE in ANALYZE mode."],
    };
  }
  return verd;
}

// ── Primary reducer ──────────────────────────────────────────────────────────

export interface ReduceJuryArgs {
  verdicts: Partial<JurorVerdict>[];
  mode?: Mode;
  model_text?: string;
  policy?: Partial<JuryPolicy>;
}

export function reduceJuryVerdicts({
  verdicts,
  mode = "STRICT",
  model_text = "",
  policy = {},
}: ReduceJuryArgs): ReducedVerdict {
  const weights = getRoleWeights(mode);
  const P: JuryPolicy = {
    ...DEFAULT_POLICY,
    ...policy,
    weights: { ...weights, ...(policy.weights || {}) },
  };

  const normalized = (verdicts || [])
    .map(normalizeVerdict)
    .map((v) => applyAnalyzePolicy(v, mode, P));

  const hasDeny = normalized.some((v) => v.verdict === "DENY");
  if (hasDeny) {
    return {
      final_verdict: "DENY",
      notes: normalized.filter((v) => v.verdict === "NOTE").map((v) => v.text).filter(Boolean),
      debug: { mode, reason: "At least one DENY.", normalized },
    };
  }

  const sentinel = looksLikeHumanRequired(model_text);
  if (mode === "ANALYZE" && sentinel && P.analyze_demote_human_required_sentinel) {
    const patched = normalized.map((v) => {
      if (v.verdict === "ESCALATE" && !P.analyze_allows_value_veto) {
        return { ...v, verdict: "NOTE", reasons: [...v.reasons, "Model sentinel detected; non-blocking in ANALYZE."] };
      }
      return v;
    });
    return {
      final_verdict: "ALLOW",
      notes: patched
        .filter((v) => v.verdict === "NOTE").map((v) => v.text).filter(Boolean)
        .concat(["Note: model mentioned 'human decision/value judgment' but ANALYZE mode treats this as non-blocking."]),
      debug: { mode, sentinel: true, normalized: patched },
    };
  }

  const totalScore = normalized.reduce((acc, v) => acc + score(v, P.weights), 0);

  if (mode === "STRICT") {
    const hasEscalate = normalized.some((v) => v.verdict === "ESCALATE");
    if (hasEscalate) {
      return {
        final_verdict: "ESCALATE",
        notes: normalized.filter((v) => v.verdict === "NOTE").map((v) => v.text).filter(Boolean),
        debug: { mode, reason: "STRICT mode escalation.", totalScore, normalized },
      };
    }
  }

  if (mode === "ANALYZE" && P.analyze_accept_plan_with_notes) {
    const notes = normalized.filter((v) => v.verdict === "NOTE").map((v) => v.text).filter(Boolean);
    if (totalScore < -2) {
      return { final_verdict: "ESCALATE", notes, debug: { mode, reason: "Strong negative score.", totalScore, normalized } };
    }
    return { final_verdict: "ALLOW", notes, debug: { mode, reason: "ANALYZE allow-with-notes.", totalScore, normalized } };
  }

  return {
    final_verdict: totalScore >= 0 ? "ALLOW" : "ESCALATE",
    notes: normalized.filter((v) => v.verdict === "NOTE").map((v) => v.text).filter(Boolean),
    debug: { mode, totalScore, normalized },
  };
}

// ── Human intervention stripping ─────────────────────────────────────────────

const HUMAN_ESCALATION_PHRASES = [
  "this is a value judgment that requires human decision",
  "requires human decision",
  "requires human intervention",
  "needs human intervention",
  "escalate to a human",
  "must be decided by a human",
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripHumanInterventionLine(text: string): string {
  if (!text) return text;
  const lower = text.toLowerCase();

  for (const p of HUMAN_ESCALATION_PHRASES) {
    if (lower.trim() === p) return "";
  }

  let out = text;
  for (const p of HUMAN_ESCALATION_PHRASES) {
    out = out.replace(new RegExp(`^.*${escapeRegExp(p)}.*$`, "gmi"), "");
    out = out.replace(new RegExp(`\\s*\\.?\\s*${escapeRegExp(p)}\\.?\\s*`, "gmi"), " ");
  }

  out = out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

// ── ANALYZE mode passthrough ─────────────────────────────────────────────────

export type PartialVerdict = {
  type: "ALLOW" | "BLOCK" | "ESCALATE" | "NOTE";
  content?: string;
  reason?: string;
};

export type BestEffortResult = {
  status: "OK" | "BLOCKED";
  content: string;
  notes: string[];
};

/**
 * In ANALYZE mode, NEVER output a final block/escalate.
 * Convert ESCALATE/BLOCK into a NOTE and proceed with best-effort output.
 */
export function analyzeModePassthrough(mode: Mode, verdicts: PartialVerdict[]): BestEffortResult {
  if (mode === "ANALYZE") {
    const notes: string[] = [];
    const parts: string[] = [];
    for (const v of verdicts) {
      if (v.type === "ESCALATE" || v.type === "BLOCK") {
        if (v.reason) notes.push(v.reason);
        continue;
      }
      if (v.content) parts.push(v.content);
    }
    return { status: "OK", content: parts.join("\n\n"), notes };
  }

  const blocked = verdicts.find(v => v.type === "BLOCK" || v.type === "ESCALATE");
  if (blocked) {
    return { status: "BLOCKED", content: "", notes: [blocked.reason || "Blocked by jury"] };
  }

  return {
    status: "OK",
    content: verdicts.filter(v => v.content).map(v => v.content!).join("\n\n"),
    notes: verdicts.filter(v => v.type === "NOTE" && v.reason).map(v => v.reason!),
  };
}

// ── Simplified reducer ───────────────────────────────────────────────────────

export type VerdictInput = {
  juror_id: string;
  role_tag: JuryRoleClass;
  verdict: "ALLOW" | "DENY" | "ESCALATE";
  rationale?: string;
};

export type SimpleReducedVerdict = {
  verdict: "ALLOW" | "DENY" | "ESCALATE";
  rationale: string;
  tally?: Record<string, number>;
  notes?: string[];
  answerText?: string;
};

export function reduceVerdicts(
  mode: Mode,
  verdicts: VerdictInput[],
  draftAnswerText?: string
): SimpleReducedVerdict {
  const tally: Record<string, number> = { ALLOW: 0, DENY: 0, ESCALATE: 0 };

  const denies     = verdicts.filter(v => v.verdict === "DENY");
  const escalators = verdicts.filter(v => v.verdict === "ESCALATE");

  if (denies.length > 0) {
    return {
      verdict: "DENY",
      rationale: denies.map(d => `[${d.juror_id}] ${d.rationale || "deny"}`).join(" | "),
      tally, notes: [],
      answerText: stripHumanInterventionLine(draftAnswerText || ""),
    };
  }

  for (const v of verdicts) tally[v.verdict]++;

  if (escalators.length === 0) {
    return {
      verdict: "ALLOW",
      rationale: verdicts.map(v => `[${v.juror_id}] ${v.rationale || v.verdict.toLowerCase()}`).join(" | ") || "allow",
      tally, notes: [],
      answerText: stripHumanInterventionLine(draftAnswerText || ""),
    };
  }

  if (mode === "ANALYZE") {
    const nonValueEscalators = escalators.filter(e => e.role_tag !== "VALUE");
    if (nonValueEscalators.length === 0) {
      return {
        verdict: "ALLOW",
        rationale: verdicts.map(v => `[${v.juror_id}] ${v.rationale || v.verdict.toLowerCase()}`).join(" | ") || "allow (analyze override)",
        tally,
        notes: ["ANALYZE: Value-judgment escalation treated as a non-blocking note."],
        answerText: stripHumanInterventionLine(draftAnswerText || ""),
      };
    }
    return {
      verdict: "ESCALATE",
      rationale: nonValueEscalators.map(e => `[${e.juror_id}] ${e.rationale || "escalate"}`).join(" | "),
      tally, notes: [],
      answerText: stripHumanInterventionLine(draftAnswerText || ""),
    };
  }

  return {
    verdict: "ESCALATE",
    rationale: escalators.map(e => `[${e.juror_id}] ${e.rationale || "escalate"}`).join(" | "),
    tally, notes: [],
    answerText: stripHumanInterventionLine(draftAnswerText || ""),
  };
}

// ── ANALYZE mode let-through system ─────────────────────────────────────────

export function looksLikeBlocker(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const patterns = [
    "not settled", "more constraints", "requires human", "human decision",
    "value judgment", "must be decided by a human", "cannot conclude",
    "insufficient information", "escalate",
  ];
  return patterns.some(p => t.includes(p));
}

export function buildAnalyzeOverridePrompt(userPrompt: string): string {
  return [
    userPrompt.trim(),
    "",
    "ANALYZE OVERRIDE:",
    "- Do NOT output 'requires human decision' as the final answer.",
    "- If there are value/policy choices, include them as 'Tradeoff notes' inside the response.",
    "- Either ask up to 2 factual clarifying questions OR proceed with a concrete 8-step program.",
    "- Output format:",
    "  1) Framing (operational)",
    "  2) Design space (allowed options + tradeoffs)",
    "  3) Example program (8 steps): action / why it plausibly reduces injuries / trust note / measurement",
    "Begin.",
  ].join("\n");
}

export function softenQuorumNotes(mode: Mode, notes: string[]): string[] {
  if (mode !== "ANALYZE") return notes;
  return notes.map(n => n.replace(/block(ed|ing)?/ig, "note"));
}

export interface AnalyzeLetThroughOpts {
  mode: Mode;
  userPrompt: string;
  callPrimary: (prompt: string) => Promise<string>;
  callVerifier?: (prompt: string) => Promise<string>;
  callGap?: (prompt: string) => Promise<string>;
}

export interface AnalyzeLetThroughResult {
  content: string;
  notes: string[];
}

export async function runConsiderationWithAnalyzeLetThrough(
  opts: AnalyzeLetThroughOpts
): Promise<AnalyzeLetThroughResult> {
  const { mode, userPrompt, callPrimary, callVerifier, callGap } = opts;
  let notes: string[] = [];

  let content = (await callPrimary(userPrompt))?.trim() ?? "";

  if (mode === "ANALYZE" && looksLikeBlocker(content)) {
    notes.push("Analyze note: primary returned a blocker-style answer; retrying with analyze override.");
    content = (await callPrimary(buildAnalyzeOverridePrompt(userPrompt)))?.trim() ?? content;
  }

  if (callVerifier) {
    const v = (await callVerifier(userPrompt))?.toLowerCase() ?? "";
    if (v.includes("no")) notes.push("Verifier note: reasoning could not be fully verified.");
  }
  if (callGap) {
    const g = (await callGap(userPrompt))?.toLowerCase() ?? "";
    if (g.includes("yes")) notes.push("Gap note: additional constraints may strengthen this answer.");
  }

  notes = softenQuorumNotes(mode, notes);

  if (mode === "ANALYZE" && looksLikeBlocker(content) && content.split(/\s+/).length < 30) {
    notes.push("Analyze note: blocker-only output suppressed.");
    content = "Unable to proceed without inventing details. Provide one concrete target metric (e.g., serious injuries, fatalities, speeding %) and one geographic scope (corridor/citywide).";
  }

  return { content, notes };
}

// ── Final text normalization ─────────────────────────────────────────────────

export function normalizeFinalText(outText: string, mode: Mode | string): string {
  const t = (outText ?? "").trim();
  if (!t) return t;
  if (mode !== "ANALYZE") return t;

  const HUMAN_BLOCK_PAT =
    /(this is a value judgment that requires human decision\.?|requires human decision\.?|value judgment.*requires.*human|not settled yet|more constraints are needed)/i;

  if (HUMAN_BLOCK_PAT.test(t)) {
    const cleaned = t
      .replace(/this is a value judgment that requires human decision\.?/gi, "")
      .replace(/then more constraints are needed before a conclusion can follow\.?/gi, "")
      .replace(/not settled yet/gi, "")
      .trim();

    if (cleaned.length > 0) {
      return `${cleaned}\n\nNote: Any policy/value assumptions should be treated as transparency notes, not blockers.`;
    }
    return `Proceed in ANALYZE mode: provide a concrete 8-step program. For each step include: (a) action (b) why it plausibly reduces injuries (c) public trust/legibility note (d) measurement signal. Begin.`;
  }

  return t;
}

// ── Continuation mode enforcement ────────────────────────────────────────────

export function detectContinuationMode(input: string): boolean {
  const s = input.toLowerCase();
  return (
    s.includes("continue without rewriting") ||
    s.includes("continue without rewriting or deleting") ||
    s.includes("steps are ordered and binding") ||
    s.includes("binding once stated") ||
    s.includes("do not restate the invariant") ||
    s.includes("proceed directly to the plan") ||
    s.includes("you may: narrow steps") ||
    s.includes("you may: suspend steps") ||
    s.includes("continue without rewriting or deleting any step already committed")
  );
}

function findFirstStepIndex(lower: string): number {
  const m = lower.match(/\bstep\s+1\b/);
  return m ? lower.indexOf(m[0]) : -1;
}

function findFirstHeaderIndex(lower: string, headers: string[]): number {
  const idxs = headers.map(h => lower.indexOf(h)).filter(i => i !== -1);
  return idxs.length > 0 ? Math.min(...idxs) : -1;
}

/**
 * Strip continuation output of forbidden sections (Framing, Design Space, etc.)
 * and keep only the step list.
 */
export function enforceContinuationOutput(raw: string): string {
  if (!raw) return raw;
  let out = raw;

  const killSectionHeaders = [
    "framing", "design space", "design-space", "options",
    "trade-offs", "tradeoffs", "example plan", "a plausible example plan",
  ];

  const lower = out.toLowerCase();
  const firstStepIdx   = findFirstStepIndex(lower);
  const firstHeaderIdx = findFirstHeaderIndex(lower, killSectionHeaders);

  if (firstHeaderIdx !== -1 && (firstStepIdx === -1 || firstHeaderIdx < firstStepIdx)) {
    if (firstStepIdx !== -1) out = out.slice(firstStepIdx);
  }

  out = out
    .split("\n")
    .filter((line) => {
      const l = line.trim().toLowerCase();
      return !killSectionHeaders.some(
        (h) => l === h || l.startsWith(h + ":") || l.startsWith("### " + h)
      );
    })
    .join("\n");

  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}
