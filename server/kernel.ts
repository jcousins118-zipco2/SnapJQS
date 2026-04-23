/**
 * server/kernel.ts
 *
 * SnapSpace Lite — minimal deterministic commit kernel.
 *
 * Responsibilities:
 * - Enforce monotonic turn discipline (epoch, turn must strictly increase)
 * - Enforce replay prevention (same action_hash cannot commit twice within window)
 * - Persist state durably (state.json + append-only journal with hash chain)
 *
 * Non-goals:
 * - No policy, no reasoning, no evidence interpretation
 * - No vendor logic
 *
 * Philosophy:
 * Models may reason. Systems must enforce.
 *
 * Commit rule:
 *   commit allowed iff:
 *     (epoch, turn) strictly greater than last committed (monotonicity)
 *     and action_hash not previously committed (replay prevention window)
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function canonicalJson(obj: unknown): string {
  if (obj === null) return "null";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") {
    if (!Number.isFinite(obj)) throw new Error("Non-finite number");
    return Object.is(obj, -0) ? "0" : String(obj);
  }
  if (typeof obj === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJson).join(",") + "]";
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(
      (k) => JSON.stringify(k) + ":" + canonicalJson((obj as Record<string, unknown>)[k])
    );
    return "{" + pairs.join(",") + "}";
  }
  throw new Error(`Unsupported type: ${typeof obj}`);
}

export interface KernelDecision {
  outcome: "COMMIT" | "DENY" | "FREEZE";
  reasonCode: string;
  lastEpoch: number;
  lastTurn: number;
  headHash: string;
}

export interface KernelState {
  last_epoch: number;
  last_turn: number;
  spent: string[];
  head_hash: string;
  _FROZEN?: boolean;
  _ERR?: string;
  [key: string]: unknown;
}

export interface KernelOptions {
  stateDir?: string;
  spentWindow?: number;
  corruptionPolicy?: "freeze" | "raise" | "truncate";
}

export interface CommitOptions {
  epoch: number;
  turn: number;
  actionHash: string;
  context?: Record<string, unknown>;
}

export class SnapSpaceLiteKernel {
  private stateDir: string;
  private spentWindow: number;
  private corruptionPolicy: "freeze" | "raise" | "truncate";
  private statePath: string;
  private journalPath: string;
  private state: KernelState;

  constructor(options: KernelOptions = {}) {
    this.stateDir = options.stateDir || "snapspace_state";
    this.spentWindow = options.spentWindow || 2048;
    this.corruptionPolicy = options.corruptionPolicy || "freeze";

    if (this.spentWindow <= 0) {
      throw new Error("spentWindow must be positive");
    }

    this.statePath = path.join(this.stateDir, "state.json");
    this.journalPath = path.join(this.stateDir, "journal.log");

    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }

    this.state = this.loadState();
  }

  private defaultState(): KernelState {
    return {
      last_epoch: -1,
      last_turn: -1,
      spent: [],
      head_hash: "0".repeat(64),
    };
  }

  private loadState(): KernelState {
    if (!fs.existsSync(this.statePath)) {
      const st = this.defaultState();
      this.atomicWriteJson(this.statePath, st);
      return st;
    }

    try {
      const content = fs.readFileSync(this.statePath, "utf-8");
      const st = JSON.parse(content) as KernelState;

      if (typeof st !== "object" || st === null) {
        throw new Error("state not object");
      }
      if (typeof st.last_epoch !== "number") {
        throw new Error("state.last_epoch not number");
      }
      if (typeof st.last_turn !== "number") {
        throw new Error("state.last_turn not number");
      }
      if (!Array.isArray(st.spent)) {
        throw new Error("state.spent not array");
      }
      if (typeof st.head_hash !== "string" || st.head_hash.length !== 64) {
        throw new Error("state.head_hash invalid");
      }

      return st;
    } catch (e) {
      if (this.corruptionPolicy === "raise") {
        throw e;
      }
      if (this.corruptionPolicy === "truncate") {
        const st = this.defaultState();
        this.atomicWriteJson(this.statePath, st);
        return st;
      }
      return {
        ...this.defaultState(),
        _FROZEN: true,
        _ERR: String(e),
      };
    }
  }

  private atomicWriteJson(filePath: string, obj: Record<string, unknown>): void {
    const tmp = filePath + ".tmp";
    const data = canonicalJson(obj);
    fs.writeFileSync(tmp, data, "utf-8");
    fs.renameSync(tmp, filePath);
  }

  private appendJournal(record: Record<string, unknown>): string {
    const prevHead = this.state.head_hash;
    const recJson = canonicalJson(record);
    const material = prevHead + recJson;
    const newHead = sha256Hex(material);

    const line = canonicalJson({
      prev_head: prevHead,
      record: record,
      head: newHead,
    }) + "\n";

    fs.appendFileSync(this.journalPath, line, "utf-8");

    return newHead;
  }

  commit(options: CommitOptions): KernelDecision {
    const { epoch, turn, actionHash, context } = options;

    if (this.state._FROZEN) {
      return {
        outcome: "FREEZE",
        reasonCode: "KERNEL_FROZEN",
        lastEpoch: this.state.last_epoch,
        lastTurn: this.state.last_turn,
        headHash: this.state.head_hash,
      };
    }

    if (typeof epoch !== "number" || typeof turn !== "number") {
      return {
        outcome: "DENY",
        reasonCode: "MALFORMED_TURN",
        lastEpoch: this.state.last_epoch,
        lastTurn: this.state.last_turn,
        headHash: this.state.head_hash,
      };
    }

    if (typeof actionHash !== "string" || actionHash.length !== 64) {
      return {
        outcome: "DENY",
        reasonCode: "MALFORMED_ACTION_HASH",
        lastEpoch: this.state.last_epoch,
        lastTurn: this.state.last_turn,
        headHash: this.state.head_hash,
      };
    }

    const lastEpoch = this.state.last_epoch;
    const lastTurn = this.state.last_turn;

    if (epoch < lastEpoch || (epoch === lastEpoch && turn <= lastTurn)) {
      return {
        outcome: "DENY",
        reasonCode: "ROLLBACK_OR_REPLAY_TURN",
        lastEpoch,
        lastTurn,
        headHash: this.state.head_hash,
      };
    }

    if (this.state.spent.includes(actionHash)) {
      return {
        outcome: "DENY",
        reasonCode: "REPLAY_ACTION_HASH",
        lastEpoch,
        lastTurn,
        headHash: this.state.head_hash,
      };
    }

    const record = {
      epoch,
      turn,
      action_hash: actionHash,
      context: context || {},
    };
    const newHead = this.appendJournal(record);

    const spent2 = [...this.state.spent, actionHash].slice(-this.spentWindow);

    const newState: KernelState = {
      last_epoch: epoch,
      last_turn: turn,
      spent: spent2,
      head_hash: newHead,
    };

    this.atomicWriteJson(this.statePath, newState as unknown as Record<string, unknown>);
    this.state = newState;

    return {
      outcome: "COMMIT",
      reasonCode: "OK",
      lastEpoch: epoch,
      lastTurn: turn,
      headHash: newHead,
    };
  }

  getState(): { lastEpoch: number; lastTurn: number; headHash: string; frozen: boolean } {
    return {
      lastEpoch: this.state.last_epoch,
      lastTurn: this.state.last_turn,
      headHash: this.state.head_hash,
      frozen: !!this.state._FROZEN,
    };
  }
}

export function actionHashOfObj(actionObj: Record<string, unknown>): string {
  const s = canonicalJson(actionObj);
  return sha256Hex(s);
}

/* ============================
KERNEL PATCH: RENEGOTIATION MODE
Minimal, explicit, fail-closed
============================ */

export type KernelMode = "EXECUTION" | "RENEGOTIATION";

let kernelMode: KernelMode = "EXECUTION";

let renegotiationContext: {
  reason: string;
  affectedSteps: number[];
  enteredAt: number;
} | null = null;

/* ---- Public API ---- */

export function enterRenegotiation(reason: string, affectedSteps: number[]) {
  if (kernelMode !== "EXECUTION") {
    throw new Error("Kernel already not in EXECUTION mode");
  }
  kernelMode = "RENEGOTIATION";
  renegotiationContext = {
    reason,
    affectedSteps,
    enteredAt: Date.now(),
  };
}

export function exitRenegotiation() {
  if (kernelMode !== "RENEGOTIATION") {
    throw new Error("Kernel not in RENEGOTIATION mode");
  }
  kernelMode = "EXECUTION";
  renegotiationContext = null;
}

/* ---- Obligation Check Hook ---- */

export function checkObligationViolation(
  violatingStep: number,
  obligationFromStep: number
):
  | { verdict: "OK" }
  | { verdict: "INVALID"; reason: string }
  | { verdict: "CONFLICT"; reason: string } {

  if (kernelMode === "EXECUTION") {
    return {
      verdict: "INVALID",
      reason: `Step ${violatingStep} violates obligation from Step ${obligationFromStep}`,
    };
  }

  // RENEGOTIATION MODE
  return {
    verdict: "CONFLICT",
    reason: `Step ${violatingStep} conflicts with obligation from Step ${obligationFromStep} during renegotiation`,
  };
}

/* ---- Introspection ---- */

export function getKernelMode(): KernelMode {
  return kernelMode;
}

export function getRenegotiationContext() {
  return renegotiationContext;
}
