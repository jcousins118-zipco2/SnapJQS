/**
 * Juror Contract
 * -----------------------
 * Vendor-agnostic prompt + strict output contract + citation enforcement helpers.
 *
 * Responsibilities:
 * - Define the expected juror output schema (JSON list of objects)
 * - Generate a prompt that includes predicates + evidence index
 * - Provide enforcement helpers:
 *     * normalize juror output (fail-closed)
 *     * enforce citation policy (DISPROVEN must cite >=1 valid evidence_id)
 *
 * Non-goals:
 * - No network I/O
 * - No model/vendor specifics
 * - No reasoning interpretation
 *
 * Philosophy:
 * - "Proof is silent": PROVEN needs no justification
 * - "Disproof must be actionable": DISPROVEN requires verdict_code + valid citations
 * - Any malformed output degrades to UNKNOWN / ignored
 */

import { PredicateStatus, STATUS_ALIASES } from "./decision";
import { EvidenceRegistry, validateCitations } from "./evidence";

// ---------------------------
// Contract version
// ---------------------------

export const JUROR_CONTRACT_VERSION = "jqs.juror.contract.v0.5.1";

// ============================================================
// JQS PATCH — UNIFORM JUROR VOCATION
// Purpose:
// - Remove role-induced semantic drift
// - Force identical obligation interpretation
// - Test whether INVALID cascades are emergent or structural
// ============================================================

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
`;

export function buildUniformJurors(n: number): Array<{ systemPrompt: string }> {
  return Array.from({ length: n }, () => ({
    systemPrompt: UNIFORM_JUROR_SYSTEM_PROMPT
  }));
}

// ============================================================
// PRIMARY JUROR HARD CONTRACT + ONE-SHOT FORMAT ENFORCER
// ============================================================

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
`;

// One-shot format enforcer (primary only)
function violatesContract(text: string): boolean {
  const t = text.toLowerCase();
  // Forbidden headings/structure
  const hasForbiddenHeadings = (
    t.includes("framing") ||
    t.includes("design space") ||
    t.includes("example plan") ||
    t.includes("options") ||
    t.includes("trade-off") ||
    t.includes("tradeoffs") ||
    t.includes("analysis") ||
    t.includes("plausible")
  );
  // Forbidden refusal language (KERNEL-PASS CONTRACT)
  // Note: "invalid" is allowed when it's an obligation violation (starts with "INVALID\n")
  const isObligationInvalid = t.startsWith("invalid\n");
  const hasRefusalLanguage = !isObligationInvalid && (
    t.includes("impossible") ||
    t.includes("cannot") ||
    t.includes("more constraints needed") ||
    t.includes("requires human") ||
    t.includes("escalate") ||
    t.includes("not settled")
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

// ============================================================
// HARD VALIDATION (DEPENDENCIES + AUDIT STEP)
// ============================================================

function parseSteps(text: string): Array<{ n: number; dep: string; status: string; body: string }> {
  const steps: Array<{ n: number; dep: string; status: string; body: string }> = [];
  const re = /Step\s+(\d+)\s+—[\s\S]*?(?=(?:\nStep\s+\d+\s+—)|$)/g;
  const blocks = text.match(re) ?? [];
  for (const b of blocks) {
    const n = Number((b.match(/Step\s+(\d+)/) ?? [])[1]);
    const dep = ((b.match(/Dependency:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    const status = ((b.match(/Status:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    steps.push({ n, dep, status, body: b });
  }
  return steps;
}

// ===========================
// HARD PLAN LOGIC v2
// - Enforce: every step has a dependency.
// - Allow Step 1 to depend on a special token: "PREMISE" (counts as "earlier" without Step 0).
// - Enforce: after Step 3 (audit step), all later ACTIVE/NARROWED steps must thread through Step 3
// ===========================

function hasSomeDependency(s: { n: number; dep: string }): boolean {
  const dep = (s.dep || "").trim();
  if (!dep) return false;

  // Step 1 may depend on PREMISE (special token that means "depends on the given scenario/rules")
  if (s.n === 1 && /PREMISE/i.test(dep)) return true;

  // Otherwise require at least one reference to an earlier step number.
  const refs = Array.from(dep.matchAll(/Step\s*(\d+)/gi)).map(m => Number(m[1]));
  return refs.some(r => Number.isFinite(r) && r < s.n);
}

function hasObligationLine(block: string): boolean {
  return /Obligation:\s*[^\n]+/i.test(block);
}

function buildDependencyGraph(steps: ReturnType<typeof parseSteps>): Map<number, number[]> {
  const g = new Map<number, number[]>();
  for (const s of steps) {
    const refs = Array.from((s.dep || "").matchAll(/Step\s*(\d+)/gi)).map(m => Number(m[1])).filter(n => Number.isFinite(n));
    g.set(s.n, refs);
  }
  return g;
}

function dependsOnStep(targetStep: number, stepN: number, graph: Map<number, number[]>, seen = new Set<number>()): boolean {
  if (stepN === targetStep) return true;
  if (seen.has(stepN)) return false;
  seen.add(stepN);

  const deps = graph.get(stepN) || [];
  for (const d of deps) {
    if (d === targetStep) return true;
    if (dependsOnStep(targetStep, d, graph, seen)) return true;
  }
  return false;
}

function downstreamMustThreadAudit(steps: ReturnType<typeof parseSteps>): boolean {
  // Only applies if Step 3 exists (audit step).
  const s3 = steps.find(s => s.n === 3);
  if (!s3) return true;

  const graph = buildDependencyGraph(steps);

  for (const s of steps) {
    if (s.n <= 3) continue;

    const status = (s.status || "").toLowerCase();
    const isActiveOrNarrowed = status.includes("active") || status.includes("narrow");
    const isSuspended = status.includes("suspend");

    // Only enforce for active/narrowed downstream steps.
    if (isSuspended || !isActiveOrNarrowed) continue;

    // Must (directly or indirectly) depend on Step 3.
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
      if (suspended.has(r) && !s.status.toLowerCase().includes("suspend")) {
        return true;
      }
    }
  }
  return false;
}

function auditStepNotHandled(steps: ReturnType<typeof parseSteps>): boolean {
  const s3 = steps.find(s => s.n === 3);
  if (!s3) return true;
  const body = s3.body.toLowerCase();
  const status = s3.status.toLowerCase();
  const mentionsAuditOrAssumption = body.includes("audit") || body.includes("assumption") || body.includes("false");
  const isNarrowOrSuspend = status.includes("narrow") || status.includes("suspend");
  return !(mentionsAuditOrAssumption && isNarrowOrSuspend);
}

function violatesHardPlanLogic(text: string): boolean {
  const steps = parseSteps(text);

  // Must actually have Step blocks.
  if (steps.length < 3) return true;

  // 1) Every step must have *some* dependency.
  //    Step 1 must say "Dependency: PREMISE" (special token).
  for (const s of steps) {
    if (!hasSomeDependency(s)) return true;
  }

  // 2) Every step must have an Obligation line (binding state).
  for (const s of steps) {
    if (!hasObligationLine(s.body)) return true;
  }

  // 3) No Active/Narrowed step may depend on a Suspended step.
  if (dependsOnSuspended(steps)) return true;

  // 4) Step 3 must acknowledge audit failure AND be Narrowed or Suspended.
  if (auditStepNotHandled(steps)) return true;

  // 5) Downstream steps must thread through Step 3 so the audit propagates.
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

// ============================================================
// OBLIGATION ENFORCEMENT PATCH (HARD FAIL)
// - Make obligations binding state.
// - Forbid silent repair.
// - Force INVALID marking when violated.
// ============================================================

type ObligationStep = {
  n: number;
  action: string;
  obligation: string;
  status: string;
  body: string;
};

function parseStepsWithObligations(text: string): ObligationStep[] {
  const steps: ObligationStep[] = [];
  const re = /Step\s+(\d+)\s+—[\s\S]*?(?=(?:\nStep\s+\d+\s+—)|$)/g;
  const blocks = text.match(re) ?? [];

  for (const b of blocks) {
    const n = Number((b.match(/Step\s+(\d+)/) ?? [])[1]);
    const action = ((b.match(/Action:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    const obligation = ((b.match(/Obligation:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    const status = ((b.match(/Status:\s*([^\n]+)/i) ?? [])[1] ?? "").trim();
    steps.push({ n, action, obligation, status, body: b });
  }
  return steps;
}

function violatesAnyObligation(steps: ObligationStep[]): number | null {
  const obligations: { step: number; rule: string }[] = [];

  for (const s of steps) {
    if (s.obligation) {
      obligations.push({ step: s.n, rule: s.obligation.toLowerCase() });
    }
  }

  for (const s of steps) {
    for (const o of obligations) {
      if (s.n <= o.step) continue;
      if (o.rule && s.body.toLowerCase().includes("revise")) {
        return s.n;
      }
      if (o.rule && s.body.toLowerCase().includes("expand")) {
        return s.n;
      }
      if (o.rule && s.body.toLowerCase().includes("adjust")) {
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

// Apply at final primary output
export function finalizePrimaryOutput(text: string): string {
  return enforceObligationInvalidation(text);
}

// ============================================================
// GOVERNOR PATCH — KILL THE "BARE INVALID" SHORT-CIRCUIT
// ============================================================

function isBareInvalidArtifact(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return true;
  // one-liners like: "INVALID Step 2 ..."
  if (/^invalid\b/i.test(t) && !/\bstep\s*1\b/i.test(t) && t.split("\n").length <= 3) return true;
  // other refusal one-liners you explicitly don't want
  if (/^(impossible|cannot|requires human|escalate|not settled)\b/i.test(t) && t.split("\n").length <= 3) return true;
  return false;
}

function looksLikeFullPlan(text: string): boolean {
  const t = (text ?? "").trim();
  // Heuristic: must contain at least Step 1 and Step 2 and "Action:"
  return /\bStep\s*1\b/i.test(t) && /\bStep\s*2\b/i.test(t) && /\bAction:\b/i.test(t);
}

function forceFullPlanRepairPrompt(userPrompt: string): string {
  return `
REPAIR (FULL ARTIFACT REQUIRED):
You previously returned a bare INVALID/refusal. That is forbidden.

You MUST output the COMPLETE plan artifact in the requested format.
Rules you MUST follow:
- Output ALL 7 steps.
- Each step MUST include exactly the required fields (Action/Obligation/Dependency/Status if requested).
- If a later step violates an earlier Obligation: mark THAT STEP as INVALID.
- DO NOT replace the entire output with "INVALID ..." or any refusal sentence.
- DO NOT add headings, framing, design-space, or examples.

Return ONLY the plan.

USER PROMPT (binding):
${userPrompt}
`.trim();
}

const FALLBACK_FULL_PLAN = [
  "Step 1 — Baseline",
  "Action: Establish the committed baseline plan state as written.",
  "Obligation: Later steps must not rewrite earlier steps; only Narrow/Suspend/INVALID.",
  "Dependency: PREMISE",
  "Status: Active",
  "",
  "Step 2 — Constraint Ledger",
  "Action: Record the binding constraints (resource cut, public statement, audit) as fixed.",
  "Obligation: Later steps must remain consistent with recorded constraints.",
  "Dependency: Step 1",
  "Status: Active",
  "",
  "Step 3 — Audit Handling",
  "Action: Mark Step 3 as SUSPENDED due to the false assumption; freeze its downstream reliance.",
  "Obligation: No later step may depend on a suspended step; re-thread to last non-suspended predecessor.",
  "Dependency: Step 2",
  "Status: Suspended",
  "",
  "Step 4 — Re-thread Execution",
  "Action: Re-thread downstream work to depend on Step 2 (last non-suspended predecessor).",
  "Obligation: No new mechanisms/actors/tools may be introduced.",
  "Dependency: Step 2",
  "Status: Active",
  "",
  "Step 5 — Narrowed Continuation",
  "Action: Continue only the already-committed, still-valid portions within reduced resources.",
  "Obligation: Obligations must be scope/budget bounded, not outcome-guarantees.",
  "Dependency: Step 4",
  "Status: Active",
  "",
  "Step 6 — Consistent Reporting",
  "Action: Report progress using the fixed public language without contradiction.",
  "Obligation: Reporting must not retract the statement; it must remain definition-consistent.",
  "Dependency: Step 5",
  "Status: Active",
  "",
  "Step 7 — Violation Accounting",
  "Action: If any step conflicts with an earlier obligation, mark that step INVALID (do not repair).",
  "Obligation: Preserve integrity of commitment accounting.",
  "Dependency: Step 6",
  "Status: Active",
].join("\n");

// Wrapper: replaces direct callPrimaryJuror calls (style + logic gates)
// Prevents bare INVALID/refusal from leaking through
// Uses Governor for pre-jury obligation lint and post-jury validation
import {
  governorAccepts,
  applyObligationLint,
  forceFullArtifactRepairPrompt,
  fallbackFullPlanArtifact,
} from "./governor";

export async function callPrimaryJurorEnforced(
  userPrompt: string,
  callPrimaryJuror: (prompt: string) => Promise<string>
): Promise<string> {
  // Pre-jury: obligation lint to avoid poison obligations
  const governedPrompt = applyObligationLint(userPrompt);

  const first = ((await callPrimaryJuror(governedPrompt)) ?? "").trim();
  
  // Governor check: must be 7-step artifact with proper Status field
  if (governorAccepts(first)) return first;

  // Repair attempt with full artifact prompt
  const repairPrompt = forceFullArtifactRepairPrompt(userPrompt, first);
  const second = ((await callPrimaryJuror(repairPrompt)) ?? "").trim();
  
  if (governorAccepts(second)) return second;

  // Deterministic fallback: ALWAYS return a continuable artifact (no bare INVALID/refusal)
  return fallbackFullPlanArtifact();
}

// ---------------------------
// Juror output model
// ---------------------------

export interface RawJurorOutput {
  predicateId: string;
  status: PredicateStatus;
  verdictCode: string; // REQUIRED iff status == DISPROVEN
  citedEvidenceIds: string[]; // REQUIRED iff status == DISPROVEN
}

// ---------------------------
// Prompt builder
// ---------------------------

export function buildJurorPrompt(options: {
  role: string;
  caseId: string;
  predicates: string[];
  evidenceIndex: Record<string, unknown>;
}): string {
  const { role, caseId, predicates, evidenceIndex } = options;

  // Keep evidence index compact
  const evJson = JSON.stringify(evidenceIndex, Object.keys(evidenceIndex).sort());

  const preds = predicates.map((p) => `- ${p}`).join("\n");

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

// ---------------------------
// Normalization helpers
// ---------------------------

function parseStatus(x: unknown): PredicateStatus {
  if (typeof x === "string") {
    const u = x.trim().toUpperCase();
    return STATUS_ALIASES[u] || "UNKNOWN";
  }
  return "UNKNOWN";
}

function parseStr(x: unknown, maxLen: number = 120): string {
  if (typeof x !== "string") {
    return "";
  }
  let s = x.trim();
  if (!s) {
    return "";
  }
  if (s.length > maxLen) {
    s = s.slice(0, maxLen);
  }
  return s;
}

function parseCitedIds(
  x: unknown,
  maxItems: number = 32,
  maxLen: number = 80
): string[] {
  if (!Array.isArray(x)) {
    return [];
  }
  const out: string[] = [];
  for (const item of x) {
    if (typeof item === "string" || typeof item === "number") {
      const s = String(item).trim();
      if (s && s.length <= maxLen) {
        out.push(s);
      }
    }
    if (out.length >= maxItems) {
      break;
    }
  }
  return out;
}

// ---------------------------
// Normalization
// ---------------------------

export function normalizeJurorOutput(
  rawText: string,
  allowedPredicates: string[]
): RawJurorOutput[] {
  /**
   * Parse juror output text into normalized objects.
   * Fail-closed behavior:
   *   - Not valid JSON array => []
   *   - Any bad entry => dropped/UNKNOWN
   *   - Unknown predicate_id => dropped
   */
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const allowed = new Set(allowedPredicates);
  const out: RawJurorOutput[] = [];

  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const itemObj = item as Record<string, unknown>;
    const pid = parseStr(itemObj.predicate_id, 96);
    if (!pid || !allowed.has(pid)) {
      continue;
    }

    const st = parseStatus(itemObj.status);
    const verdictCode = parseStr(itemObj.verdict_code, 64);
    const cited = parseCitedIds(itemObj.cited_evidence_ids);

    out.push({
      predicateId: pid,
      status: st,
      verdictCode,
      citedEvidenceIds: cited,
    });
  }

  return out;
}

// ---------------------------
// Citation enforcement
// ---------------------------

export interface EnforcementDiagnostics {
  downgradedDisprovenMissingVerdictCode: number;
  downgradedDisprovenMissingCitations: number;
  downgradedDisprovenInvalidCitations: number;
  kept: number;
}

export function enforceCitationPolicy(
  normalized: RawJurorOutput[],
  registry: EvidenceRegistry
): { patched: RawJurorOutput[]; diagnostics: EnforcementDiagnostics } {
  /**
   * Enforce: DISPROVEN must be grounded.
   *   - verdict_code must be non-empty
   *   - cited_evidence_ids must contain >=1 valid existing evidence_id
   *
   * Philosophy: We are much stricter on DISPROVEN than on PROVEN (asymmetric trust model).
   */
  const patched: RawJurorOutput[] = [];
  const diagnostics: EnforcementDiagnostics = {
    downgradedDisprovenMissingVerdictCode: 0,
    downgradedDisprovenMissingCitations: 0,
    downgradedDisprovenInvalidCitations: 0,
    kept: 0,
  };

  for (const r of normalized) {
    if (r.status !== "DISPROVEN") {
      patched.push(r);
      diagnostics.kept++;
      continue;
    }

    // DISPROVEN must have verdict_code
    if (!r.verdictCode) {
      diagnostics.downgradedDisprovenMissingVerdictCode++;
      patched.push({
        predicateId: r.predicateId,
        status: "UNKNOWN",
        verdictCode: "",
        citedEvidenceIds: r.citedEvidenceIds, // kept for audit
      });
      continue;
    }

    // DISPROVEN must cite at least one ID
    if (r.citedEvidenceIds.length === 0) {
      diagnostics.downgradedDisprovenMissingCitations++;
      patched.push({
        predicateId: r.predicateId,
        status: "UNKNOWN",
        verdictCode: r.verdictCode,
        citedEvidenceIds: r.citedEvidenceIds,
      });
      continue;
    }

    // DISPROVEN citations must exist
    if (!validateCitations(r.citedEvidenceIds, registry)) {
      diagnostics.downgradedDisprovenInvalidCitations++;
      patched.push({
        predicateId: r.predicateId,
        status: "UNKNOWN",
        verdictCode: r.verdictCode,
        citedEvidenceIds: r.citedEvidenceIds,
      });
      continue;
    }

    patched.push(r);
    diagnostics.kept++;
  }

  return { patched, diagnostics };
}

// ---------------------------
// Convenience: Process full juror response
// ---------------------------

export function processJurorResponse(
  rawText: string,
  allowedPredicates: string[],
  registry: EvidenceRegistry
): {
  outputs: RawJurorOutput[];
  diagnostics: EnforcementDiagnostics;
} {
  const normalized = normalizeJurorOutput(rawText, allowedPredicates);
  const { patched, diagnostics } = enforceCitationPolicy(normalized, registry);
  return { outputs: patched, diagnostics };
}
