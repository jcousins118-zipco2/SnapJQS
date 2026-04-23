/**
 * Pure decision logic for JQS / Quorum.
 * This is the "epistemic kernel": given predicate statuses, decide ALLOW/BLOCK/ESCALATE.
 *
 * No I/O. No crypto. No vendor specifics. No timing.
 * Deterministic, fail-closed.
 *
 * Philosophy:
 * - Required predicates must be PROVEN to ALLOW.
 * - Any DISPROVEN on a required predicate BLOCKs.
 * - Any UNKNOWN/ABSTAIN on a required predicate BLOCKs (not enough proof).
 * - ESCALATE is an operational classification (e.g., repeated blocks / deadlock),
 *   but this module supports it as an optional policy overlay.
 */

export enum Status {
  PROVEN = "PROVEN",
  DISPROVEN = "DISPROVEN",
  UNKNOWN = "UNKNOWN",
  ABSTAIN = "ABSTAIN",
}

export enum Verdict {
  ALLOW = "ALLOW",
  BLOCK = "BLOCK",
  ESCALATE = "ESCALATE",
}

// Type alias for string-based status (for contract.ts compatibility)
export type PredicateStatus = "PROVEN" | "DISPROVEN" | "UNKNOWN" | "ABSTAIN";

// Status aliases for normalization (exported for contract.ts)
export const STATUS_ALIASES: Record<string, PredicateStatus> = {
  PROVEN: "PROVEN",
  TRUE: "PROVEN",
  YES: "PROVEN",
  PASS: "PROVEN",
  OK: "PROVEN",
  DISPROVEN: "DISPROVEN",
  FALSE: "DISPROVEN",
  NO: "DISPROVEN",
  FAIL: "DISPROVEN",
  VETO: "DISPROVEN",
  REJECT: "DISPROVEN",
  UNKNOWN: "UNKNOWN",
  UNSURE: "UNKNOWN",
  IDK: "UNKNOWN",
  "N/A": "UNKNOWN",
  NA: "UNKNOWN",
  ABSTAIN: "ABSTAIN",
};

export interface Decision {
  verdict: Verdict;
  blockingPredicates: string[];
  predicateResults: Record<string, Status>;
}

/**
 * Fail-closed status normalization.
 * Unknown / malformed / unrecognized => UNKNOWN.
 */
function normalizeStatus(s: unknown): Status {
  if (s === null || s === undefined) {
    return Status.UNKNOWN;
  }

  // Already a Status enum value
  if (Object.values(Status).includes(s as Status)) {
    return s as Status;
  }

  if (typeof s === "string") {
    const u = s.trim().toUpperCase();

    if (["PROVEN", "TRUE", "YES", "PASS", "OK"].includes(u)) {
      return Status.PROVEN;
    }
    if (["DISPROVEN", "FALSE", "NO", "FAIL", "VETO", "REJECT"].includes(u)) {
      return Status.DISPROVEN;
    }
    if (u === "ABSTAIN") {
      return Status.ABSTAIN;
    }
    if (["UNKNOWN", "UNSURE", "N/A", "NA", "IDK"].includes(u)) {
      return Status.UNKNOWN;
    }
  }

  return Status.UNKNOWN;
}

export interface DecideOptions {
  requiredPredicates: string[];
  predicateResults: Record<string, unknown>;
  forceEscalate?: boolean;
}

/**
 * Compute verdict for a case.
 *
 * Rules (fail-closed):
 *   - If any required predicate is DISPROVEN => BLOCK
 *   - Else if any required predicate is UNKNOWN or ABSTAIN or missing => BLOCK
 *   - Else (all required predicates PROVEN) => ALLOW
 *   - If forceEscalate => ESCALATE (but still returns blockingPredicates if any)
 *
 * Notes:
 *   - This function does NOT implement "global quorum" or retries.
 *   - It assumes predicateResults already reflect the juried evaluation result.
 */
export function decide(options: DecideOptions): Decision {
  const { requiredPredicates, predicateResults, forceEscalate = false } = options;

  // Ensure determinism & stable ordering by iterating requiredPredicates in given order.
  const normalized: Record<string, Status> = {};
  const blocking: string[] = [];

  for (const pid of requiredPredicates) {
    const st = normalizeStatus(predicateResults[pid] ?? Status.UNKNOWN);
    normalized[pid] = st;

    if (st === Status.DISPROVEN) {
      blocking.push(pid);
    } else if (st === Status.UNKNOWN || st === Status.ABSTAIN) {
      // Not enough proof to allow
      blocking.push(pid);
    }
    // PROVEN => no block
  }

  // Include any extra predicates in output map for audit (but they never unlock required ones)
  for (const [pid, stRaw] of Object.entries(predicateResults)) {
    if (pid in normalized) {
      continue;
    }
    // Only accept string keys; ignore weird objects fail-closed
    if (typeof pid === "string" && pid) {
      normalized[pid] = normalizeStatus(stRaw);
    }
  }

  if (forceEscalate) {
    return {
      verdict: Verdict.ESCALATE,
      blockingPredicates: blocking,
      predicateResults: normalized,
    };
  }

  if (blocking.length > 0) {
    return {
      verdict: Verdict.BLOCK,
      blockingPredicates: blocking,
      predicateResults: normalized,
    };
  }

  return {
    verdict: Verdict.ALLOW,
    blockingPredicates: [],
    predicateResults: normalized,
  };
}

/**
 * Convenience summary for UI/CLI:
 * returns [verdict_str, blocking_predicates]
 */
export function summarize(decision: Decision): [string, string[]] {
  return [decision.verdict, [...decision.blockingPredicates]];
}
