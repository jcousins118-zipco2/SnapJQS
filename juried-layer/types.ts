/**
 * juried-layer/types.ts
 * 
 * Shared types extracted from the JQS core (decision.ts + evidence.ts).
 * These are the only external dependencies that contract.ts needs.
 * Drop this file alongside the other juried-layer files.
 */

// ── From decision.ts ─────────────────────────────────────────────────────────

export enum Status {
  PROVEN    = "PROVEN",
  DISPROVEN = "DISPROVEN",
  UNKNOWN   = "UNKNOWN",
  ABSTAIN   = "ABSTAIN",
}

export enum Verdict {
  ALLOW    = "ALLOW",
  BLOCK    = "BLOCK",
  ESCALATE = "ESCALATE",
}

export type PredicateStatus = "PROVEN" | "DISPROVEN" | "UNKNOWN" | "ABSTAIN";

export const STATUS_ALIASES: Record<string, PredicateStatus> = {
  PROVEN:   "PROVEN",
  TRUE:     "PROVEN",
  YES:      "PROVEN",
  PASS:     "PROVEN",
  OK:       "PROVEN",
  DISPROVEN:"DISPROVEN",
  FALSE:    "DISPROVEN",
  NO:       "DISPROVEN",
  FAIL:     "DISPROVEN",
  VETO:     "DISPROVEN",
  REJECT:   "DISPROVEN",
  UNKNOWN:  "UNKNOWN",
  UNSURE:   "UNKNOWN",
  IDK:      "UNKNOWN",
  "N/A":    "UNKNOWN",
  NA:       "UNKNOWN",
  ABSTAIN:  "ABSTAIN",
};

// ── From evidence.ts ─────────────────────────────────────────────────────────

export type EvidenceRecord = {
  evidence_id: string;
  label: string;
  payload_hash?: string;
  registered_at?: number;
};

export type EvidenceRegistry = Record<string, EvidenceRecord>;

/**
 * Returns true iff every cited ID exists in the registry.
 */
export function validateCitations(
  citedIds: string[],
  registry: EvidenceRegistry
): boolean {
  if (!citedIds || citedIds.length === 0) return false;
  return citedIds.every((id) => id in registry);
}
