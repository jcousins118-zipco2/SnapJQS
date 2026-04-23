/**
 * Domain-based juror selection with ethics gating.
 * Stops "trust/legitimacy" language from auto-pulling ethics juror.
 * 
 * GOVERNOR PATCH: Role flattening - all jurors have identical vocation
 * to reduce "narrative repair" divergence.
 */

// FIXED_JURORS: Flatten juror roles - every juror has the same job
export const FIXED_JURORS: string[] = ["general_reasoner", "general_reasoner", "general_reasoner"];

// --- CONTINUATION TRIAGE OVERRIDE ---
// This runs BEFORE normal domain routing

function hasContinuationDirective(prompt: string): boolean {
  const p = prompt.toLowerCase();

  return (
    p.includes("continue without rewriting") ||
    p.includes("do not rewrite") ||
    p.includes("do not delete") ||
    p.includes("binding once stated") ||
    p.includes("steps are ordered and binding") ||
    p.includes("proceed directly to the plan") ||
    p.includes("new information (also binding)") ||
    p.includes("you may: narrow") ||
    p.includes("you may: suspend") ||
    p.includes("continuation is impossible") ||
    p.includes("state exactly which step causes impossibility")
  );
}

type DomainTag =
  | "traffic"
  | "urban"
  | "policy"
  | "engineering"
  | "medicine"
  | "law"
  | "economics"
  | "research"
  | "environment"
  | "general";

const DOMAIN_TO_JURORS: Record<DomainTag, string[]> = {
  traffic: ["traffic_planner", "systems_engineer"],
  urban: ["urban_designer", "policy_generalist"],
  policy: ["policy_generalist", "ethics_juror"],
  engineering: ["systems_engineer", "safety_engineer"],
  medicine: ["clinical_juror", "public_health"],
  law: ["legal_juror", "governance_juror"],
  economics: ["economist_juror", "policy_generalist"],
  research: ["research_librarian", "domain_scholar"],
  environment: ["environmental_juror", "systems_engineer"],
  general: ["general_reasoner"],
};

type Mode = "STRICT" | "ANALYZE";

/**
 * Ethics juror gating:
 * - "public trust / legitimacy / explain to the public" is NOT enough.
 * - Only include ethics when the prompt has explicit rights/power/surveillance/discrimination/coercion triggers.
 */
function shouldIncludeEthicsJuror(questionText: string): boolean {
  const t = questionText.toLowerCase();

  const strongTriggers = [
    "surveillance",
    "facial recognition",
    "biometric",
    "tracking",
    "location data",
    "wiretap",
    "informant",
    "undercover",
    "profiling",
    "score",
    "scoring",
    "black-box",
    "black box",
    "predictive policing",
    "stop and frisk",
    "random searches",
    "search without warrant",
    "warrant",
    "detain",
    "detention",
    "arrest quotas",
    "quota",
    "coerc",
    "discriminat",
    "race",
    "ethnic",
    "minority",
    "protected class",
    "due process",
    "civil liberties",
    "rights",
    "constitutional",
    "illegal",
    "lawful",
    "privacy",
    "consent",
    "data sharing",
  ];

  return strongTriggers.some((k) => t.includes(k));
}

/**
 * Filter-out ethics juror when it's only "trust/legibility" language.
 * Keep policy_generalist if policy domain is tagged; only gate ethics_juror.
 */
function gateEthicsJuror(
  jurors: string[],
  questionText: string,
  _mode: Mode
): string[] {
  const includeEthics = shouldIncludeEthicsJuror(questionText);
  if (includeEthics) return jurors;
  return jurors.filter((j) => j !== "ethics_juror");
}

/**
 * Lightweight keyword scan for domain detection.
 */
function triageDomains(question: string): DomainTag[] {
  const q = question.toLowerCase();
  const hits: DomainTag[] = [];

  if (q.match(/traffic|accident|road|junction|speed|collision/)) hits.push("traffic");
  if (q.match(/city|urban|public space|infrastructure/)) hits.push("urban");
  if (q.match(/policy|regulation|governance|mandate/)) hits.push("policy");
  if (q.match(/engineer|material|design|build|structural/)) hits.push("engineering");
  if (q.match(/medical|health|clinical|patient|disease/)) hits.push("medicine");
  if (q.match(/law|legal|contract|liability/)) hits.push("law");
  if (q.match(/cost|economic|budget|market/)) hits.push("economics");
  if (q.match(/study|research|paper|journal|library/)) hits.push("research");
  if (q.match(/climate|environment|emissions|ecology/)) hits.push("environment");

  return hits.length > 0 ? Array.from(new Set(hits)) : ["general"];
}

/**
 * Main entry: filter jurors BEFORE quorum runs.
 * Now with ethics gating to stop "trust" from auto-pulling ethics.
 */
export function selectJurorsForQuestion(
  question: string,
  _allJurors: string[],
  _mode: Mode = "STRICT"
): string[] {
  // GOVERNOR PATCH: Role flattening
  // Every juror has the same job to reduce "narrative repair" divergence.
  // Triple quorum will still call 3, but they'll be identical in vocation.
  
  // 🔒 HARD OVERRIDE: continuation mode still uses same fixed jurors
  if (hasContinuationDirective(question)) {
    return FIXED_JURORS;
  }

  // All other cases: return fixed uniform jurors
  return FIXED_JURORS;
}

// --- EXECUTION MODE PROMPT OVERRIDE ---

function isContinuationPrompt(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return (
    p.includes("continue without rewriting") ||
    p.includes("do not rewrite") ||
    p.includes("do not delete") ||
    p.includes("steps are ordered and binding") ||
    p.includes("binding once stated") ||
    p.includes("you may: narrow") ||
    p.includes("you may: suspend") ||
    p.includes("continuation is impossible")
  );
}

export function buildPrompt(userPrompt: string, mode: Mode): string {
  // 🔒 HARD EXECUTION OVERRIDE
  if (isContinuationPrompt(userPrompt)) {
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

  // --- existing prompt logic: return null to use default in routes.ts ---
  return "";
}

export { shouldIncludeEthicsJuror, triageDomains, isContinuationPrompt };
export type { DomainTag, Mode };
