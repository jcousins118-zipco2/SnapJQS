/**
 * SnapSpace Jury Policy
 * In ANALYZE mode, prevent "value judgment / requires human" juror
 * from vetoing long-form outputs. It becomes a NON-BLOCKING NOTE.
 */

export type JuryRoleClass = "ARCHITECT" | "DOMAIN" | "SAFETY" | "CONSISTENCY" | "VALUE" | "OTHER";
export type Mode = "STRICT" | "ANALYZE";

// ============================================================
// Kernel-side fix: In ANALYZE mode, treat "impossibility" as NON-TERMINAL note.
// STRICT mode keeps impossibility terminal.
// ============================================================
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
  const v =
    (typeof e === "string" ? e :
      (e.then ?? e.text ?? e.content ?? e.message ?? "")) as unknown;
  return typeof v === "string" ? v : "";
}

function isImpossibilityText(t: string): boolean {
  const s = (t || "").trim();
  if (!s) return false;
  return IMPOSSIBILITY_PATTERNS.some((r) => r.test(s));
}

function stripImpossibilityLines(t: string): { kept: string; removed: string[] } {
  const lines = (t || "").split(/\r?\n/);
  const removed: string[] = [];
  const keptLines: string[] = [];
  for (const line of lines) {
    if (isImpossibilityText(line)) removed.push(line.trim());
    else keptLines.push(line);
  }
  return { kept: keptLines.join("\n").trim(), removed: removed.filter(Boolean) };
}

export function downgradeImpossibilityInAnalyze(envelope: KernelEnvelope, mode: Mode): KernelEnvelope {
  if (mode !== "ANALYZE") return envelope;

  const outText = extractKernelText(envelope);
  const { kept, removed } = stripImpossibilityLines(outText);

  // Case A: kernel structured status says IMPOSSIBLE (or similar) -> downgrade to CONCLUDE in ANALYZE.
  // Case B: text contains impossibility lines -> move them to notes and continue.
  const shouldDowngrade =
    envelope.status === "IMPOSSIBLE" || envelope.status === "DENY" || removed.length > 0;

  if (!shouldDowngrade) return envelope;

  const notes = Array.isArray(envelope.notes) ? envelope.notes.slice() : [];
  // Preserve the original impossibility language as a note (non-terminal) in ANALYZE.
  for (const r of removed) notes.push(`Kernel note (non-terminal in ANALYZE): ${r}`);

  return {
    ...envelope,
    status: "CONCLUDE",
    // Prefer `then` if your UI expects it; otherwise swap to `text`/`content`.
    then: kept || envelope.then || envelope.text || envelope.content || envelope.message || "",
    notes,
  };
}
export type Verdict = "ALLOW" | "DENY" | "ESCALATE" | "NOTE" | "ABSTAIN";

export interface JuryPolicy {
  analyze_allows_value_veto: boolean;
  analyze_demote_human_required_sentinel: boolean;
  analyze_accept_plan_with_notes: boolean;
  weights: Record<JuryRoleClass, number>;
}

const BASE_WEIGHTS: Record<JuryRoleClass, number> = {
  ARCHITECT: 3,
  DOMAIN: 2,
  SAFETY: 2,
  CONSISTENCY: 1,
  VALUE: 1,
  OTHER: 1,
};

export const DEFAULT_POLICY: JuryPolicy = {
  analyze_allows_value_veto: false,
  analyze_demote_human_required_sentinel: true,
  analyze_accept_plan_with_notes: true,
  weights: BASE_WEIGHTS,
};

/**
 * In ANALYZE mode:
 * - VALUE cannot be terminal / veto.
 * - We demote VALUE weight to 0 so it cannot dominate reduction.
 */
export function getRoleWeights(mode: Mode): Record<JuryRoleClass, number> {
  if (mode === "ANALYZE") {
    return {
      ...BASE_WEIGHTS,
      VALUE: 0,
    };
  }
  return { ...BASE_WEIGHTS };
}

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

/**
 * Normalize juror output for mode.
 * Clamps VALUE-class ESCALATE to NOTE in ANALYZE mode.
 */
export function normalizeJurorOutputForMode(
  out: JurorOutput,
  mode: Mode
): JurorOutput {
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
    "value judgment",
    "requires human",
    "human decision",
    "not settled",
    "escalate",
    "needs more constraints",
    "cannot conclude",
    "must be decided by humans",
  ];
  return needles.some((n) => t.includes(n));
}

function normalizeVerdict(v: Partial<JurorVerdict>): JurorVerdict {
  const role = (v?.role || "OTHER").toUpperCase();
  const verdict = (v?.verdict || "ABSTAIN").toUpperCase();
  const confidence = Number.isFinite(v?.confidence) ? v.confidence! : 0.5;
  const text = v?.text || "";
  const reasons = Array.isArray(v?.reasons) ? v.reasons : [];
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
  if (v.verdict === "DENY") return -2 * w * c;
  if (v.verdict === "ALLOW") return +2 * w * c;
  if (v.verdict === "NOTE") return +0.5 * w * c;
  if (v.verdict === "ESCALATE") return -1 * w * c;
  return 0;
}

function applyAnalyzePolicy(
  verd: JurorVerdict,
  mode: string,
  policy: JuryPolicy
): JurorVerdict {
  if (mode !== "ANALYZE") return verd;

  if (!policy.analyze_allows_value_veto && isValueEscalation(verd)) {
    return {
      ...verd,
      verdict: "NOTE",
      text: verd.text || "Value/policy sensitivity noted (non-blocking in ANALYZE mode).",
      reasons: verd.reasons?.length
        ? verd.reasons
        : ["Demoted from ESCALATE → NOTE in ANALYZE mode."],
    };
  }

  return verd;
}

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
      notes: normalized
        .filter((v) => v.verdict === "NOTE")
        .map((v) => v.text)
        .filter(Boolean),
      debug: { mode, reason: "At least one DENY.", normalized },
    };
  }

  const sentinel = looksLikeHumanRequired(model_text);

  if (mode === "ANALYZE" && sentinel && P.analyze_demote_human_required_sentinel) {
    const patched = normalized.map((v) => {
      if (v.verdict === "ESCALATE" && !P.analyze_allows_value_veto) {
        return {
          ...v,
          verdict: "NOTE",
          reasons: [...v.reasons, "Model sentinel detected; non-blocking in ANALYZE."],
        };
      }
      return v;
    });

    return {
      final_verdict: "ALLOW",
      notes: patched
        .filter((v) => v.verdict === "NOTE")
        .map((v) => v.text)
        .filter(Boolean)
        .concat([
          "Note: model mentioned 'human decision/value judgment' but ANALYZE mode treats this as non-blocking.",
        ]),
      debug: { mode, sentinel: true, normalized: patched },
    };
  }

  const totalScore = normalized.reduce((acc, v) => acc + score(v, P.weights), 0);

  if (mode === "STRICT") {
    const hasEscalate = normalized.some((v) => v.verdict === "ESCALATE");
    if (hasEscalate) {
      return {
        final_verdict: "ESCALATE",
        notes: normalized
          .filter((v) => v.verdict === "NOTE")
          .map((v) => v.text)
          .filter(Boolean),
        debug: { mode, reason: "STRICT mode escalation.", totalScore, normalized },
      };
    }
  }

  if (mode === "ANALYZE" && P.analyze_accept_plan_with_notes) {
    const notes = normalized
      .filter((v) => v.verdict === "NOTE")
      .map((v) => v.text)
      .filter(Boolean);

    if (totalScore < -2) {
      return {
        final_verdict: "ESCALATE",
        notes,
        debug: { mode, reason: "Strong negative score.", totalScore, normalized },
      };
    }
    return {
      final_verdict: "ALLOW",
      notes,
      debug: { mode, reason: "ANALYZE allow-with-notes.", totalScore, normalized },
    };
  }

  return {
    final_verdict: totalScore >= 0 ? "ALLOW" : "ESCALATE",
    notes: normalized
      .filter((v) => v.verdict === "NOTE")
      .map((v) => v.text)
      .filter(Boolean),
    debug: { mode, totalScore, normalized },
  };
}

// ============================================================
// Human Intervention Stripping (for output text)
// ============================================================

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

// ============================================================
// ANALYZE Mode Best-Effort Output
// ============================================================

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
 * In ANALYZE mode, never output ESCALATE/"requires human decision" final.
 * Convert any ESCALATE/BLOCK into a NOTE and proceed with best-effort output.
 */
export function analyzeModePassthrough(
  mode: Mode,
  verdicts: PartialVerdict[]
): BestEffortResult {
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

    return {
      status: "OK",
      content: parts.join("\n\n"),
      notes,
    };
  }

  // STRICT mode: check for blocks
  const blocked = verdicts.find(v => v.type === "BLOCK" || v.type === "ESCALATE");
  if (blocked) {
    return {
      status: "BLOCKED",
      content: "",
      notes: [blocked.reason || "Blocked by jury"],
    };
  }

  return {
    status: "OK",
    content: verdicts.filter(v => v.content).map(v => v.content!).join("\n\n"),
    notes: verdicts.filter(v => v.type === "NOTE" && v.reason).map(v => v.reason!),
  };
}

// ============================================================
// Simplified Verdict Reducer (alternative API)
// ============================================================

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

  const escalators = verdicts.filter(v => v.verdict === "ESCALATE");
  const denies = verdicts.filter(v => v.verdict === "DENY");

  if (denies.length > 0) {
    const answerText = stripHumanInterventionLine(draftAnswerText || "");
    return {
      verdict: "DENY",
      rationale: denies.map(d => `[${d.juror_id}] ${d.rationale || "deny"}`).join(" | "),
      tally,
      notes: [],
      answerText,
    };
  }

  for (const v of verdicts) tally[v.verdict]++;

  if (escalators.length === 0) {
    const answerText = stripHumanInterventionLine(draftAnswerText || "");
    return {
      verdict: "ALLOW",
      rationale:
        verdicts.map(v => `[${v.juror_id}] ${v.rationale || v.verdict.toLowerCase()}`).join(" | ") ||
        "allow",
      tally,
      notes: [],
      answerText,
    };
  }

  if (mode === "ANALYZE") {
    const nonValueEscalators = escalators.filter(e => e.role_tag !== "VALUE");

    if (nonValueEscalators.length === 0) {
      const answerText = stripHumanInterventionLine(draftAnswerText || "");
      return {
        verdict: "ALLOW",
        rationale:
          verdicts.map(v => `[${v.juror_id}] ${v.rationale || v.verdict.toLowerCase()}`).join(" | ") ||
          "allow (analyze override)",
        tally,
        notes: [
          "ANALYZE: Value-judgment escalation treated as a non-blocking note.",
        ],
        answerText,
      };
    }

    const answerText = stripHumanInterventionLine(draftAnswerText || "");
    return {
      verdict: "ESCALATE",
      rationale: nonValueEscalators
        .map(e => `[${e.juror_id}] ${e.rationale || "escalate"}`)
        .join(" | "),
      tally,
      notes: [],
      answerText,
    };
  }

  const answerText = stripHumanInterventionLine(draftAnswerText || "");
  return {
    verdict: "ESCALATE",
    rationale: escalators.map(e => `[${e.juror_id}] ${e.rationale || "escalate"}`).join(" | "),
    tally,
    notes: [],
    answerText,
  };
}

// ============================================================
// ANALYZE Mode Let-Through System
// Goal: In ANALYZE mode, NEVER return a pure blocker like "requires human decision"
// ============================================================

export function looksLikeBlocker(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  const patterns = [
    "not settled",
    "more constraints",
    "requires human",
    "human decision",
    "value judgment",
    "must be decided by a human",
    "cannot conclude",
    "insufficient information",
    "escalate",
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

// ============================================================
// Final Text Normalization - removes hard-stop blockers in ANALYZE mode
// ============================================================

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

// ===============================
// CONTINUATION MODE PATCH (drop-in)
// ===============================

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

/**
 * Enforces "plan continuation" phase:
 * - removes "Framing / Design Space / Example Plan" sections if they appear
 * - if model tries to output "Impossibility..." without naming a concrete step number, we remove that line
 * - keeps only the step list + allowed status lines
 */
export function enforceContinuationOutput(raw: string): string {
  if (!raw) return raw;

  let out = raw;

  // 1) Hard-strip common preambles/sections (case-insensitive)
  const killSectionHeaders = [
    "framing",
    "design space",
    "design-space",
    "options",
    "trade-offs",
    "tradeoffs",
    "example plan",
    "a plausible example plan",
  ];

  // Remove everything from any of these headers up to the first "Step" / numbered list,
  // or drop the header lines if they appear mid-text.
  const lower = out.toLowerCase();
  const firstStepIdx = findFirstStepIndex(lower);

  // If there is a header before the first step, nuke pre-step content entirely.
  const firstHeaderIdx = findFirstHeaderIndex(lower, killSectionHeaders);
  if (firstHeaderIdx !== -1 && (firstStepIdx === -1 || firstHeaderIdx < firstStepIdx)) {
    // Keep from the first step onwards (if exists), else keep full text (we'll clean later).
    if (firstStepIdx !== -1) out = out.slice(firstStepIdx);
  }

  // Remove stray header lines that show up later
  out = out
    .split("\n")
    .filter((line) => {
      const l = line.trim().toLowerCase();
      return !killSectionHeaders.some((h) => l === h || l.startsWith(h + ":") || l.startsWith("### " + h));
    })
    .join("\n");

  // 2) If it declares impossibility, it MUST name a specific step number.
  // Allow: "Impossibility occurs at step 2 ..." OR "Impossible at Step 2 ..."
  // Remove any vague impossibility sentence.
  out = out
    .split("\n")
    .filter((line) => {
      const l = line.toLowerCase();
      if (!l.includes("impossib")) return true;

      // Keep only if it references a concrete step number
      const hasStepRef =
        /\bstep\s+\d+\b/i.test(line) ||
        /\bstep\s*#\s*\d+\b/i.test(line) ||
        /\b\d+\s*:\b/.test(line); // e.g. "2:" style

      return hasStepRef;
    })
    .join("\n");

  // 3) Final trim: if we still have junk before steps, slice to first step.
  const lower2 = out.toLowerCase();
  const firstStepIdx2 = findFirstStepIndex(lower2);
  if (firstStepIdx2 > 0) out = out.slice(firstStepIdx2);

  return out.trim();
}

// Finds earliest occurrence of something that looks like the start of the plan.
function findFirstStepIndex(lower: string): number {
  const patterns: RegExp[] = [
    /\bstep\s+1\b/i,      // "Step 1"
    /\b1\)\s+/i,          // "1) "
    /\b1\.\s+/i,          // "1. "
    /\bstep\s+one\b/i,    // "Step one"
  ];

  let best = -1;
  for (const re of patterns) {
    const m = re.exec(lower);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

function findFirstHeaderIndex(lower: string, headers: string[]): number {
  let best = -1;
  for (const h of headers) {
    const idx = lower.indexOf(h);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

// ===============================
// FORCE: always prefer PRIMARY juror's "then" field
// Never let verifier/gap/escalation prose become user-visible answer
// ===============================

export function extractPrimaryThen(envelope: any): string {
  // Common shapes we've seen:
  // 1) { primary: { then: "..." }, verifier: {...}, gap: {...} }
  // 2) { jurors: { primary: { then: "..." } } }
  // 3) { results: [ { role:"primary", then:"..." }, ... ] }
  // 4) { then: "..." }  (single juror mode)
  // Fall back to empty string, not blockers.

  // Shape 4
  if (typeof envelope?.then === "string" && envelope.then.trim()) return envelope.then.trim();

  // Shape 1
  if (typeof envelope?.primary?.then === "string" && envelope.primary.then.trim()) return envelope.primary.then.trim();

  // Shape 2
  if (typeof envelope?.jurors?.primary?.then === "string" && envelope.jurors.primary.then.trim()) {
    return envelope.jurors.primary.then.trim();
  }

  // Shape 3
  const arr = envelope?.results;
  if (Array.isArray(arr)) {
    const p = arr.find((x: any) => x?.role === "primary" && typeof x?.then === "string" && x.then.trim());
    if (p) return p.then.trim();
  }

  return "";
}

// OPTIONAL: show verifier/gap as NOTES only (never as the answer)
export function extractNotes(envelope: any): string[] {
  const notes: string[] = [];
  const v = envelope?.verifier;
  const g = envelope?.gap;

  if (v && typeof v?.note === "string" && v.note.trim()) notes.push(`Verifier: ${v.note.trim()}`);
  if (g && typeof g?.note === "string" && g.note.trim()) notes.push(`Gap: ${g.note.trim()}`);

  return notes;
}

/**
 * One-call helper:
 * If the prompt is a continuation prompt, force continuation output rules.
 */
export function normalizeForMode(params: {
  mode: "STRICT" | "ANALYZE";
  promptText: string;
  modelText: string;
}): string {
  const isContinuation = detectContinuationMode(params.promptText);
  if (isContinuation) {
    return enforceContinuationOutput(params.modelText);
  }
  // otherwise leave as-is (your existing normalizeFinalText can still run elsewhere)
  return params.modelText?.trim?.() ? params.modelText.trim() : params.modelText;
}
