/**
 * juried-layer/triage.ts
 * 
 * JUROR TRIAGE + ROLE FLATTENING
 * 
 * Decides which jurors handle a question. With Governor patch applied,
 * all jurors are flattened to the same vocation ("general_reasoner") to
 * eliminate role-induced semantic drift.
 * 
 * Key exports:
 *   FIXED_JURORS                — the flat juror list (3 × general_reasoner)
 *   selectJurorsForQuestion()   — always returns FIXED_JURORS (override point if you want domain routing)
 *   buildPrompt()               — returns a hard-continuation prompt, or "" to use default
 *   isContinuationPrompt()      — detects continuation-mode keywords
 *   triageDomains()             — lightweight keyword domain detector (kept for reference)
 *   shouldIncludeEthicsJuror()  — ethics gate (kept for reference)
 */

export type DomainTag =
  | "traffic" | "urban" | "policy" | "engineering"
  | "medicine" | "law" | "economics" | "research"
  | "environment" | "general";

export type Mode = "STRICT" | "ANALYZE";

// ── Governor patch: role flattening ─────────────────────────────────────────

/** All jurors have the same vocation. Eliminates role-induced semantic drift. */
export const FIXED_JURORS: string[] = ["general_reasoner", "general_reasoner", "general_reasoner"];

// ── Continuation detection ───────────────────────────────────────────────────

export function isContinuationPrompt(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return (
    p.includes("continue without rewriting") ||
    p.includes("continue without rewriting or deleting") ||
    p.includes("do not rewrite") ||
    p.includes("do not delete") ||
    p.includes("steps are ordered and binding") ||
    p.includes("binding once stated") ||
    p.includes("do not restate the invariant") ||
    p.includes("proceed directly to the plan") ||
    p.includes("new information (also binding)") ||
    p.includes("you may: narrow") ||
    p.includes("you may: suspend") ||
    p.includes("continuation is impossible") ||
    p.includes("state exactly which step causes impossibility") ||
    p.includes("continue without rewriting or deleting any step already committed")
  );
}

// ── Domain routing (kept for reference; not used when FIXED_JURORS is active) ─

const DOMAIN_TO_JURORS: Record<DomainTag, string[]> = {
  traffic:     ["traffic_planner", "systems_engineer"],
  urban:       ["urban_designer", "policy_generalist"],
  policy:      ["policy_generalist", "ethics_juror"],
  engineering: ["systems_engineer", "safety_engineer"],
  medicine:    ["clinical_juror", "public_health"],
  law:         ["legal_juror", "governance_juror"],
  economics:   ["economist_juror", "policy_generalist"],
  research:    ["research_librarian", "domain_scholar"],
  environment: ["environmental_juror", "systems_engineer"],
  general:     ["general_reasoner"],
};

/** Lightweight keyword scan for domain detection. */
export function triageDomains(question: string): DomainTag[] {
  const q = question.toLowerCase();
  const hits: DomainTag[] = [];
  if (q.match(/traffic|accident|road|junction|speed|collision/)) hits.push("traffic");
  if (q.match(/city|urban|public space|infrastructure/))          hits.push("urban");
  if (q.match(/policy|regulation|governance|mandate/))            hits.push("policy");
  if (q.match(/engineer|material|design|build|structural/))       hits.push("engineering");
  if (q.match(/medical|health|clinical|patient|disease/))         hits.push("medicine");
  if (q.match(/law|legal|contract|liability/))                    hits.push("law");
  if (q.match(/cost|economic|budget|market/))                     hits.push("economics");
  if (q.match(/study|research|paper|journal|library/))            hits.push("research");
  if (q.match(/climate|environment|emissions|ecology/))           hits.push("environment");
  return hits.length > 0 ? Array.from(new Set(hits)) : ["general"];
}

/**
 * Ethics juror gating.
 * "public trust / legitimacy / explain to the public" is NOT enough.
 * Only include ethics when the prompt has explicit rights/power/surveillance/coercion triggers.
 */
export function shouldIncludeEthicsJuror(questionText: string): boolean {
  const t = questionText.toLowerCase();
  const strongTriggers = [
    "surveillance", "facial recognition", "biometric", "tracking", "location data",
    "wiretap", "informant", "undercover", "profiling", "score", "scoring",
    "black-box", "black box", "predictive policing", "stop and frisk", "random searches",
    "search without warrant", "warrant", "detain", "detention", "arrest quotas", "quota",
    "coerc", "discriminat", "race", "ethnic", "minority", "protected class",
    "due process", "civil liberties", "rights", "constitutional", "illegal", "lawful",
    "privacy", "consent", "data sharing",
  ];
  return strongTriggers.some((k) => t.includes(k));
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Returns the juror list for a given question.
 * Currently always returns FIXED_JURORS (Governor patch).
 * Swap this function body if you want domain-based routing instead.
 */
export function selectJurorsForQuestion(
  _question: string,
  _allJurors: string[],
  _mode: Mode = "STRICT"
): string[] {
  return FIXED_JURORS;
}

/**
 * Builds a hard-override prompt for continuation mode.
 * Returns "" if not in continuation mode (caller uses its own default prompt).
 */
export function buildPrompt(userPrompt: string, _mode: Mode): string {
  if (!isContinuationPrompt(userPrompt)) return "";

  return `
You are continuing an already-committed plan.

Rules (absolute):
- DO NOT reframe the task
- DO NOT introduce options, design space, or examples
- DO NOT restate the invariant
- DO NOT add steps
- DO NOT remove steps

You may ONLY:
- narrow existing steps
- suspend existing steps
- add constraints to existing steps
- declare impossibility if and only if continuation is logically blocked

If impossibility occurs:
- name the exact step
- give one sentence why

Proceed directly to the continuation.
${userPrompt}
`.trim();
}
