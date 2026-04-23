/**
 * JQS Session Orchestrator
 * --------------------------------
 * Coordinates juror inputs, enforces contracts, decides verdict,
 * and produces a signed receipt + audit log.
 *
 * No vendor APIs here.
 * Jurors can be:
 *   - manual (paste JSON)
 *   - scripted
 *   - stubbed
 *
 * Philosophy:
 * - Silence is not permission
 * - Hallucinated vetoes are downgraded
 * - Decision is deterministic given inputs
 */

import * as fs from "fs";
import * as path from "path";
import { 
  RawJurorOutput, 
  normalizeJurorOutput, 
  enforceCitationPolicy,
  EnforcementDiagnostics 
} from "./contract";
import { Status, Verdict, decide } from "./decision";
import { EvidenceRegistry } from "./evidence";
import { signReceipt } from "./signer";
import { SnapSpaceLiteKernel, KernelDecision, actionHashOfObj } from "./kernel";

// ---------------------------
// Data models
// ---------------------------

export interface JurorInput {
  jurorId: string;
  rawText: string; // raw JSON pasted or produced by juror
}

export interface SessionDiagnostics {
  jurorsTotal: number;
  jurorsParsed: number;
  jurorsEmpty: number;
  citationEnforcement: EnforcementDiagnostics;
  kernelEnabled?: boolean;
}

export interface KernelResult {
  outcome: string;
  reasonCode: string;
  lastEpoch: number;
  lastTurn: number;
  headHash: string;
}

export interface Attempt {
  epoch: number;
  turn: number;
}

export interface SessionResult {
  verdict: Verdict;
  blockingPredicates: string[];
  predicateResults: Record<string, Status>;
  diagnostics: SessionDiagnostics;
  unsignedOutput: Record<string, unknown>;
  receipt: Record<string, unknown>;
  kernel?: KernelResult;
}

// ---------------------------
// Audit logging
// ---------------------------

function appendAudit(auditPath: string, record: Record<string, unknown>): void {
  try {
    const dir = path.dirname(auditPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(record, Object.keys(record).sort()) + "\n";
    fs.appendFileSync(auditPath, line, { encoding: "utf-8" });
  } catch {
    // Best-effort only. Never affect verdict.
  }
}

// ---------------------------
// Merge logic
// ---------------------------

function mergePredicates(
  allOutputs: RawJurorOutput[],
  requiredPredicates: string[]
): Record<string, Status> {
  /**
   * Merge juror outputs into final predicate_results.
   *
   * Rules (fail-closed):
   * - Any DISPROVEN wins immediately
   * - Else if any UNKNOWN/ABSTAIN present → UNKNOWN
   * - Else PROVEN
   */
  const results: Record<string, Status> = {};

  for (const pid of requiredPredicates) {
    const statuses = allOutputs
      .filter((r) => r.predicateId === pid)
      .map((r) => r.status);

    if (statuses.length === 0) {
      results[pid] = Status.UNKNOWN;
      continue;
    }

    if (statuses.some((s) => s === "DISPROVEN")) {
      results[pid] = Status.DISPROVEN;
    } else if (statuses.some((s) => s === "UNKNOWN" || s === "ABSTAIN")) {
      results[pid] = Status.UNKNOWN;
    } else {
      results[pid] = Status.PROVEN;
    }
  }

  return results;
}

// ---------------------------
// Session runner
// ---------------------------

export interface RunSessionOptions {
  caseId: string;
  requiredPredicates: string[];
  jurorInputs: JurorInput[];
  evidenceRegistry: EvidenceRegistry;
  signerKid: string;
  signerKey: Buffer;
  auditLogPath?: string;
  forceEscalate?: boolean;
  kernel?: SnapSpaceLiteKernel;
  attempt?: Attempt;
  action?: Record<string, unknown>;
}

export function runSession(options: RunSessionOptions): SessionResult {
  const {
    caseId,
    requiredPredicates,
    jurorInputs,
    evidenceRegistry,
    signerKid,
    signerKey,
    auditLogPath = "audit/jqs_audit.jsonl",
    forceEscalate = false,
    kernel,
    attempt,
    action,
  } = options;

  const sessionTs = Math.floor(Date.now() / 1000);
  const diagnostics: SessionDiagnostics = {
    jurorsTotal: jurorInputs.length,
    jurorsParsed: 0,
    jurorsEmpty: 0,
    citationEnforcement: {
      downgradedDisprovenMissingVerdictCode: 0,
      downgradedDisprovenMissingCitations: 0,
      downgradedDisprovenInvalidCitations: 0,
      kept: 0,
    },
    kernelEnabled: !!kernel,
  };

  const allNormalized: RawJurorOutput[] = [];

  // --- Parse & normalize juror outputs ---
  for (const ji of jurorInputs) {
    const norm = normalizeJurorOutput(ji.rawText, requiredPredicates);
    
    if (norm.length === 0) {
      diagnostics.jurorsEmpty++;
    } else {
      diagnostics.jurorsParsed++;
    }
    
    allNormalized.push(...norm);

    appendAudit(auditLogPath, {
      ts: sessionTs,
      case_id: caseId,
      event: "juror_raw",
      juror_id: ji.jurorId,
      raw_text: ji.rawText,
    });
  }

  // --- Enforce citation policy ---
  const { patched: enforced, diagnostics: citeDiag } = enforceCitationPolicy(
    allNormalized,
    evidenceRegistry
  );
  diagnostics.citationEnforcement = citeDiag;

  appendAudit(auditLogPath, {
    ts: sessionTs,
    case_id: caseId,
    event: "after_citation_enforcement",
    outputs: enforced,
    diagnostics: citeDiag,
  });

  // --- Merge predicate statuses ---
  const predicateResults = mergePredicates(enforced, requiredPredicates);

  // --- Decide ---
  let decision = decide({
    requiredPredicates,
    predicateResults,
    forceEscalate,
  });

  // --- Kernel commit (if enabled) ---
  let kernelResult: KernelResult | undefined;

  if (kernel && attempt && action) {
    if (decision.verdict === "ALLOW") {
      const actionHash = actionHashOfObj(action);
      const kd = kernel.commit({
        epoch: attempt.epoch,
        turn: attempt.turn,
        actionHash,
        context: { case_id: caseId, action },
      });

      kernelResult = {
        outcome: kd.outcome,
        reasonCode: kd.reasonCode,
        lastEpoch: kd.lastEpoch,
        lastTurn: kd.lastTurn,
        headHash: kd.headHash,
      };

      appendAudit(auditLogPath, {
        ts: sessionTs,
        case_id: caseId,
        event: "kernel_commit_attempt",
        epoch: attempt.epoch,
        turn: attempt.turn,
        action_hash: actionHash,
        kernel_decision: kernelResult,
      });

      if (kd.outcome !== "COMMIT") {
        decision = {
          verdict: "BLOCK",
          blockingPredicates: [`KERNEL_${kd.reasonCode}`],
          predicateResults: decision.predicateResults,
        };
      }
    } else {
      const state = kernel.getState();
      kernelResult = {
        outcome: "SKIPPED",
        reasonCode: "JQS_NOT_ALLOW",
        lastEpoch: state.lastEpoch,
        lastTurn: state.lastTurn,
        headHash: state.headHash,
      };
    }
  }

  // --- Build receipt payload ---
  const unsignedReceipt: Record<string, unknown> = {
    schema_version: "jqs.output.v0.7",
    case_id: caseId,
    verdict: decision.verdict,
    blocking_predicates: decision.blockingPredicates,
    predicate_results: decision.predicateResults,
    evidence_registry_root: evidenceRegistry.rootHash(),
    diagnostics: {
      jurors_total: diagnostics.jurorsTotal,
      jurors_parsed: diagnostics.jurorsParsed,
      jurors_empty: diagnostics.jurorsEmpty,
      citation_enforcement: diagnostics.citationEnforcement,
      kernel_enabled: diagnostics.kernelEnabled,
    },
  };

  if (kernelResult) {
    unsignedReceipt.kernel = kernelResult;
  }

  const receipt = signReceipt(unsignedReceipt, signerKid, signerKey);

  appendAudit(auditLogPath, {
    ts: sessionTs,
    case_id: caseId,
    event: "final_decision",
    unsigned: unsignedReceipt,
    receipt,
  });

  return {
    verdict: decision.verdict as Verdict,
    blockingPredicates: decision.blockingPredicates,
    predicateResults: decision.predicateResults as Record<string, Status>,
    diagnostics,
    unsignedOutput: unsignedReceipt,
    receipt,
    kernel: kernelResult,
  };
}

// ---------------------------
// In-memory session for API use
// ---------------------------

export function runSessionInMemory(options: Omit<RunSessionOptions, 'auditLogPath'>): SessionResult {
  /**
   * Run session without file-based audit logging.
   * Useful for API/test scenarios.
   */
  return runSession({
    ...options,
    auditLogPath: "/dev/null", // Discard audit logs
  });
}
