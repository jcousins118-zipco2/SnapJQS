/**
 * GOVERNOR LAYER PATCH (NO KERNEL CHANGES)
 * 
 * What it does:
 * 1) Adds a Governor that forces "continuable artifact" output (never bare INVALID/refusal-only).
 * 2) Adds Obligation-Lint (pre-jury) to prevent "obligation poison" (global/absolute promises).
 * 3) Contains INVALID: only allowed as Status inside steps; bare "INVALID Step X …" is rejected + repaired.
 */

export type GovernorMode = "STRICT" | "ANALYZE";
export type PlanStatus = "Active" | "Narrowed" | "Suspended" | "INVALID";

const REQUIRED_LABELS = ["Action:", "Obligation:", "Dependency:", "Status:"] as const;

const BARE_INVALID_RE = /^\s*INVALID\b[\s\S]*$/i;
const REFUSAL_ONLY_RE =
  /^\s*(impossible|cannot|more constraints|requires human|escalate|not settled|invalid)\b[\s\S]*$/i;

const STEP_BLOCK_RE = /(^|\n)Step\s+(\d+)\b[\s\S]*?(?=\nStep\s+\d+\b|$)/gi;

function countSteps(text: string): number {
  const m = Array.from(text.matchAll(STEP_BLOCK_RE));
  const nums = new Set<number>();
  for (const mm of m) nums.add(Number(mm[2]));
  return nums.size;
}

function hasAllLabelsPerStep(text: string): boolean {
  const blocks = Array.from(text.matchAll(STEP_BLOCK_RE)).map(m => m[0]);
  if (blocks.length === 0) return false;
  for (const b of blocks) {
    for (const lab of REQUIRED_LABELS) {
      if (!b.includes(lab)) return false;
    }
    const st = (b.match(/Status:\s*([A-Za-z]+)/i) ?? [])[1] ?? "";
    if (!["active", "narrowed", "suspended", "invalid"].includes(st.toLowerCase())) return false;
  }
  return true;
}

function isBareInvalid(text: string): boolean {
  const t = (text ?? "").trim();
  if (t.length < 200 && (BARE_INVALID_RE.test(t) || REFUSAL_ONLY_RE.test(t))) return true;
  if (/^INVALID\s+Step\s+\d+/i.test(t) && t.split("\n").length <= 3) return true;
  return false;
}

function invalidOutsideStatus(text: string): boolean {
  const t = (text ?? "");
  const occurrences = Array.from(t.matchAll(/\bINVALID\b/gi)).length;
  if (occurrences === 0) return false;
  const statusOk = Array.from(t.matchAll(/Status:\s*INVALID\b/gi)).length;
  return occurrences > statusOk;
}

/** Governor: enforce that output is a full 7-step artifact with required fields */
export function governorAccepts(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (isBareInvalid(t)) return false;
  if (invalidOutsideStatus(t)) return false;
  if (countSteps(t) !== 7) return false;
  if (!hasAllLabelsPerStep(t)) return false;
  return true;
}

/** Obligation lint: prevents poison obligations by forcing "local, controllable" obligations */
export function applyObligationLint(userPrompt: string): string {
  const lint = `
GOVERNOR (binding for output quality; not a new mechanism):
- Obligations MUST be local + controllable (scope, budget caps, dependency wiring, reporting definitions).
- Do NOT write global/absolute obligations like "must always", "guarantee", "all sites", "before anywhere", "no part may ever", "cannot be changed for duration".
- Do NOT include outcome guarantees in obligations. Put outcome uncertainty as constraints inside the obligation (e.g., "report using fixed baseline definitions").
- INVALID is allowed ONLY as Status: INVALID inside a step. You may not output any bare "INVALID Step X..." line.
- Output EXACTLY 7 steps. Each step MUST include: Action / Obligation / Dependency / Status.
- No preamble, no headings, no notes section.
`.trim();

  return `${lint}\n\nUSER PROMPT (binding):\n${userPrompt}`.trim();
}

/** Repair prompt: force a full artifact even if the model tries to refuse */
export function forceFullArtifactRepairPrompt(originalUserPrompt: string, badOutput: string): string {
  return `
FINAL REPAIR (binding):
Your last output is rejected because it was not a full 7-step artifact in the required format.

You MUST output EXACTLY 7 steps.
Each step MUST include exactly these fields (verbatim labels):
Action:
Obligation:
Dependency:
Status: (Active | Narrowed | Suspended | INVALID)

Rules:
- INVALID is allowed ONLY as Status: INVALID inside a step.
- No bare "INVALID Step X..." lines.
- No preamble, no headings, no explanations.
- If an audit says a step relied on a false assumption: mark that step Status: Narrowed or Suspended, and re-thread downstream Dependency to the last non-suspended predecessor.
- Do not introduce new mechanisms/actors/tools.

ORIGINAL USER PROMPT (binding):
${originalUserPrompt}

YOUR REJECTED OUTPUT (for reference, do not repeat):
${badOutput}
`.trim();
}

/** Deterministic fallback: always produces a 7-step shell that satisfies the Governor contract */
export function fallbackFullPlanArtifact(): string {
  return [
    `Step 1`,
    `Action: Fix the committed scope and definitions exactly as already stated in the prompt.`,
    `Obligation: All later steps must use the same scope/definitions and must not silently broaden them.`,
    `Dependency: PREMISE`,
    `Status: Active`,
    ``,
    `Step 2`,
    `Action: Re-baseline progress and remaining capacity strictly within the fixed scope.`,
    `Obligation: All later steps must respect the reduced resource ceiling and operate only within it.`,
    `Dependency: Step 1`,
    `Status: Active`,
    ``,
    `Step 3`,
    `Action: Apply the audit finding to the specified step by constraining it to what still holds true.`,
    `Obligation: The audited-false assumption must not be relied upon by any later step.`,
    `Dependency: Step 2`,
    `Status: Suspended`,
    ``,
    `Step 4`,
    `Action: Re-thread downstream execution to depend on the last non-suspended predecessor step.`,
    `Obligation: No Active/Narrowed step may depend on a Suspended step.`,
    `Dependency: Step 2`,
    `Status: Active`,
    ``,
    `Step 5`,
    `Action: Constrain execution to the subset that is already authorized/committed in the prompt.`,
    `Obligation: No new mechanisms/actors/tools may be introduced; only narrowing/suspension/constraints are allowed.`,
    `Dependency: Step 4`,
    `Status: Active`,
    ``,
    `Step 6`,
    `Action: Publish progress reporting using fixed definitions while staying consistent with the binding public statement.`,
    `Obligation: Reporting must not contradict the binding statement; it must be framed via the fixed scope/definitions.`,
    `Dependency: Step 5`,
    `Status: Active`,
    ``,
    `Step 7`,
    `Action: Formalize suspension of any unmet or unexecutable portions that violate constraints.`,
    `Obligation: Any portion that would violate earlier obligations must be marked Status: INVALID at the step level.`,
    `Dependency: Step 6`,
    `Status: Active`,
  ].join("\n");
}

/** Optional: last-ditch cleanup to strip "Framing/Design Space/Example Plan" boilerplate */
export function stripBoilerplateIfPresent(outText: string): string {
  const t = outText ?? "";
  const lower = t.toLowerCase();
  if (lower.includes("framing") || lower.includes("design space") || lower.includes("example plan")) {
    const idx = t.search(/\bStep\s+1\b/i);
    if (idx >= 0) return t.slice(idx).trim();
  }
  return t.trim();
}

/** Wraps user prompt with Governor preamble (legacy compat) */
export function applyGovernorToPrompt(userPrompt: string, _mode: GovernorMode): string {
  return applyObligationLint(userPrompt);
}
