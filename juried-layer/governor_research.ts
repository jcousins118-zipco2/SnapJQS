/**
 * juried-layer/governor_research.ts
 * 
 * RESEARCH GOVERNOR
 * 
 * Dedicated path for "Research Synthesis" mode.
 * ALWAYS returns a 5-section structured artifact — never a refusal.
 * Auto-repairs once if the model drifts; then produces a deterministic fallback.
 * 
 * Trigger conditions (handled upstream in your router):
 *   - mode === "RESEARCH"
 *   - question starts with "Role: Research"
 *   - question starts with "Research Topic"
 * 
 * Usage:
 *   const text = await runResearchGovernor({ topic, addDetail, mode, callModel });
 * 
 * Five output sections (bullet-point only):
 *   Source List | Evidence Map | Synthesis Summary | Gaps & Uncertainties | Confidence Assessment
 */

export type ResearchGovernorMode = "STRICT" | "ANALYZE";

export type ResearchArtifact = {
  source_list: string;
  evidence_map: string;
  synthesis_summary: string;
  gaps_uncertainties: string;
  confidence_assessment: string;
};

const REFUSAL_PHRASES = [
  "requires human",
  "value judgment",
  "more constraints",
  "not settled",
  "cannot",
  "impossible",
  "invalid",
  "escalate",
  "could not be verified",
  "reasoning could not be verified",
];

function containsRefusal(text: string): boolean {
  const t = (text || "").toLowerCase();
  return REFUSAL_PHRASES.some(p => t.includes(p));
}

function looksLikeResearchArtifact(text: string): boolean {
  const t = (text || "").toLowerCase();
  const hasSources = t.includes("source list") || t.includes("sources");
  const hasMap     = t.includes("evidence map") || (t.includes("claims") && t.includes("sources"));
  const hasSynth   = t.includes("synthesis summary") || t.includes("synthesis");
  const hasGaps    = t.includes("gaps") || t.includes("uncertaint");
  const hasConf    = t.includes("confidence") || t.includes("confidence assessment");
  return hasSources && hasMap && hasSynth && hasGaps && hasConf;
}

function coerceToBullets(sectionBody: string): string {
  const lines = (sectionBody || "").split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return "- (none found)";
  const alreadyBullets = lines.every(l => l.startsWith("- ") || l.startsWith("• ") || l.match(/^\d+\)/));
  if (alreadyBullets) {
    return lines.map(l => {
      if (l.startsWith("• ")) return "- " + l.slice(2);
      if (l.startsWith("- ")) return l;
      return "- " + l;
    }).join("\n");
  }
  return lines.map(l => "- " + l.replace(/^[-•]\s+/, "")).join("\n");
}

/** Parse raw model text into the five required sections. */
function splitSections(text: string): Partial<ResearchArtifact> {
  const t = text || "";
  const grab = (label: RegExp) => {
    const m = t.match(label);
    if (!m || m.index == null) return null;
    const start = m.index + m[0].length;
    const rest  = t.slice(start);
    const next  = rest.search(/\n\s*(source list|sources|evidence map|synthesis summary|gaps|uncertainties|confidence)/i);
    return (next === -1 ? rest : rest.slice(0, next)).trim();
  };

  const source_list          = grab(/\n?\s*(source list|sources)\s*[:\-]\s*/i);
  const evidence_map         = grab(/\n?\s*(evidence map|claims\s*↔\s*sources|claims\s*map)\s*[:\-]\s*/i);
  const synthesis_summary    = grab(/\n?\s*(synthesis summary|synthesis)\s*[:\-]\s*/i);
  const gaps_uncertainties   = grab(/\n?\s*(gaps\s*&\s*uncertainties|gaps|uncertainties)\s*[:\-]\s*/i);
  const confidence_assessment= grab(/\n?\s*(confidence assessment|confidence)\s*[:\-]\s*/i);

  const out: Partial<ResearchArtifact> = {};
  if (source_list           != null) out.source_list           = coerceToBullets(source_list);
  if (evidence_map          != null) out.evidence_map          = coerceToBullets(evidence_map);
  if (synthesis_summary     != null) out.synthesis_summary     = coerceToBullets(synthesis_summary);
  if (gaps_uncertainties    != null) out.gaps_uncertainties    = coerceToBullets(gaps_uncertainties);
  if (confidence_assessment != null) out.confidence_assessment = coerceToBullets(confidence_assessment);
  return out;
}

export { splitSections };

/** Build the primary research prompt. add_detail is merged explicitly into the prompt. */
export function buildResearchGovernorPrompt(args: {
  topic: string;
  addDetail?: string;
  mode: ResearchGovernorMode;
}): string {
  const { topic, addDetail, mode } = args;

  const detailBlock = (addDetail && addDetail.trim())
    ? `\n\nADDITIONAL DETAILS (binding, may override):\n${addDetail.trim()}\n`
    : "";

  return `
ROLE: Research synthesis agent with evidence discipline.
MODE: ${mode}

TASK:
Conduct a structured literature review and evidence synthesis on the exact topic below.

TOPIC (binding):
${topic.trim()}
${detailBlock}

HARD CONSTRAINTS (binding):
- Do NOT invent sources or citations.
- If you cannot retrieve sources, you MUST still produce the full artifact:
  - In Source List: write "- Unable to retrieve sources in this environment." and list what would be searched (as keywords only).
  - In other sections: synthesize only from the provided content (if any) and explicitly mark gaps.
- Do NOT refuse. Do NOT output: "impossible", "cannot", "requires human", "more constraints", "invalid", "not settled", or any refusal equivalents.
- No framing. No examples. No meta commentary.

REQUIRED OUTPUT (exact sections, in this order):
Source List:
Evidence Map:
Synthesis Summary:
Gaps & Uncertainties:
Confidence Assessment:

FORMAT RULES:
- Each section must be bullet points only.
- No extra text outside the five sections.
`.trim();
}

/** Repair prompt sent if the first attempt fails the artifact check. */
export function buildResearchRepairPrompt(args: {
  previousOutput: string;
  topic: string;
  addDetail?: string;
  mode: ResearchGovernorMode;
}): string {
  return `
REPAIR (FINAL ATTEMPT):
Your previous output failed the research artifact contract (missing sections, refusal language, or drift).

You MUST output ONLY the five required sections, bullet points only, no extra text.

Do NOT invent sources or citations.
If you cannot retrieve sources, say so inside Source List and proceed.

TOPIC:
${args.topic.trim()}

ADDITIONAL DETAILS:
${(args.addDetail || "").trim() || "(none)"}

PREVIOUS OUTPUT (do not repeat):
${(args.previousOutput || "").slice(0, 2000)}
`.trim();
}

/** Deterministic fallback when both model attempts fail. */
export function formatResearchFallback(topic: string): string {
  return [
    "Source List:",
    "- Unable to retrieve sources in this environment.",
    `- Suggested search keywords derived from topic: ${topic.slice(0, 120)}`,
    "",
    "Evidence Map:",
    "- (no sources available to map in this environment)",
    "",
    "Synthesis Summary:",
    "- With no retrieved sources, synthesis is limited to outlining the search space and explicitly tracking gaps.",
    "",
    "Gaps & Uncertainties:",
    "- No primary literature retrieved; claims cannot be grounded to papers here.",
    "- Need: concrete case studies, formal methods links, and operator-in-the-loop design evidence.",
    "",
    "Confidence Assessment:",
    "- Low: no retrieved sources available for verification; output is a constrained scaffold only.",
  ].join("\n");
}

/**
 * Main entry point.
 * callModel: async (prompt: string) => string  — inject your OpenAI / Anthropic / etc. call here.
 */
export async function runResearchGovernor(args: {
  topic: string;
  addDetail?: string;
  mode: ResearchGovernorMode;
  callModel: (prompt: string) => Promise<string>;
}): Promise<string> {
  const prompt = buildResearchGovernorPrompt(args);
  const first  = (await args.callModel(prompt)) ?? "";

  if (!containsRefusal(first) && looksLikeResearchArtifact(first)) return first;

  const repair  = buildResearchRepairPrompt({
    previousOutput: first,
    topic:          args.topic,
    addDetail:      args.addDetail,
    mode:           args.mode,
  });
  const second = (await args.callModel(repair)) ?? "";

  if (!containsRefusal(second) && looksLikeResearchArtifact(second)) return second;

  return formatResearchFallback(args.topic);
}
