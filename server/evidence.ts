/**
 * Evidence Registry
 * -----------------
 * Deterministic, content-addressed registry for evidence artifacts.
 *
 * Responsibilities:
 * - Accept evidence blobs + metadata
 * - Produce stable evidence_id (content hash)
 * - Maintain an immutable manifest
 * - Export a juror-safe index (no payloads by default)
 *
 * Non-goals:
 * - No network I/O
 * - No trust assumptions
 * - No execution or interpretation
 *
 * Philosophy:
 * Evidence is *referenced*, not *believed*.
 * Jurors must cite evidence IDs; invented IDs are rejected upstream.
 */

import { createHash } from "crypto";

// ---------------------------
// Helpers
// ---------------------------

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort(), undefined)
    .replace(/,/g, ",")
    .replace(/:/g, ":");
}

function stableCanonicalJson(obj: unknown): string {
  // Recursive stable JSON serialization
  function serialize(node: unknown): string {
    if (node === null) return "null";
    if (typeof node === "boolean") return node ? "true" : "false";
    if (typeof node === "number") return node.toString();
    if (typeof node === "string") return JSON.stringify(node);

    if (Array.isArray(node)) {
      return "[" + node.map(serialize).join(",") + "]";
    }

    if (typeof node === "object") {
      const keys = Object.keys(node as object).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const val = (node as Record<string, unknown>)[k];
        if (val === undefined) continue;
        parts.push(JSON.stringify(k) + ":" + serialize(val));
      }
      return "{" + parts.join(",") + "}";
    }

    throw new Error(`Cannot serialize type: ${typeof node}`);
  }
  return serialize(obj);
}

// ---------------------------
// Evidence Types
// ---------------------------

export enum EvidenceType {
  TEXT = "TEXT",
  JSON = "JSON",
  BINARY = "BINARY",
  SNAPSHOT = "SNAPSHOT",
  LOG = "LOG",
}

// ---------------------------
// Evidence Record
// ---------------------------

export interface EvidenceRecord {
  evidenceId: string;
  evidenceType: EvidenceType;
  payloadSha256: string;
  meta: Record<string, unknown>;
  createdTs: number;
}

// ---------------------------
// Evidence Registry
// ---------------------------

export interface EvidenceRegistryOptions {
  allowPayloadShare?: boolean;
  maxPayloadBytes?: number;
  allowedTypes?: EvidenceType[];
}

export class EvidenceRegistry {
  private allowPayloadShare: boolean;
  private maxPayloadBytes: number;
  private allowedTypes: Set<EvidenceType>;

  private records: Map<string, EvidenceRecord> = new Map();
  private payloads: Map<string, Buffer> = new Map();

  constructor(options: EvidenceRegistryOptions = {}) {
    const {
      allowPayloadShare = false,
      maxPayloadBytes = 200_000,
      allowedTypes,
    } = options;

    if (maxPayloadBytes <= 0) {
      throw new Error("maxPayloadBytes must be positive");
    }

    this.allowPayloadShare = allowPayloadShare;
    this.maxPayloadBytes = maxPayloadBytes;
    this.allowedTypes = allowedTypes
      ? new Set(allowedTypes)
      : new Set(Object.values(EvidenceType));
  }

  // -----------------------
  // Registration
  // -----------------------

  register(options: {
    evidenceType: EvidenceType;
    payload: Buffer;
    meta?: Record<string, unknown>;
  }): EvidenceRecord {
    const { evidenceType, payload, meta = {} } = options;

    if (!this.allowedTypes.has(evidenceType)) {
      throw new Error(`Evidence type not allowed: ${evidenceType}`);
    }

    if (!Buffer.isBuffer(payload)) {
      throw new TypeError("payload must be a Buffer");
    }

    if (payload.length > this.maxPayloadBytes) {
      throw new Error("payload exceeds maxPayloadBytes");
    }

    const payloadHash = sha256Hex(payload);
    const createdTs = Math.floor(Date.now() / 1000);

    const material = {
      type: evidenceType,
      payload_sha256: payloadHash,
      meta,
      created_ts: createdTs,
    };

    const manifestJson = stableCanonicalJson(material);
    const manifestHash = sha256Hex(Buffer.from(manifestJson, "utf-8"));
    const evidenceId = "ev_" + manifestHash.slice(0, 20);

    const record: EvidenceRecord = {
      evidenceId,
      evidenceType,
      payloadSha256: payloadHash,
      meta,
      createdTs,
    };

    // Idempotent insert
    this.records.set(evidenceId, record);

    if (this.allowPayloadShare) {
      this.payloads.set(evidenceId, payload);
    }

    return record;
  }

  // -----------------------
  // Accessors
  // -----------------------

  get(evidenceId: string): EvidenceRecord | undefined {
    return this.records.get(evidenceId);
  }

  has(evidenceId: string): boolean {
    return this.records.has(evidenceId);
  }

  getPayload(evidenceId: string): Buffer | undefined {
    if (!this.allowPayloadShare) {
      return undefined;
    }
    return this.payloads.get(evidenceId);
  }

  // -----------------------
  // Manifest / Root Hash
  // -----------------------

  manifest(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    const sortedIds = Array.from(this.records.keys()).sort();

    for (const eid of sortedIds) {
      const rec = this.records.get(eid)!;
      out[eid] = {
        type: rec.evidenceType,
        payload_sha256: rec.payloadSha256,
        meta: rec.meta,
        created_ts: rec.createdTs,
      };
    }

    return out;
  }

  rootHash(): string {
    const manifestJson = stableCanonicalJson(this.manifest());
    return sha256Hex(Buffer.from(manifestJson, "utf-8"));
  }

  // -----------------------
  // Juror Index Export
  // -----------------------

  exportIndex(): {
    rootHash: string;
    evidence: Record<string, Record<string, unknown>>;
    payloadsShared: boolean;
  } {
    return {
      rootHash: this.rootHash(),
      evidence: this.manifest(),
      payloadsShared: this.allowPayloadShare,
    };
  }

  // -----------------------
  // Serialization
  // -----------------------

  toJSON(): {
    records: Record<string, EvidenceRecord>;
    allowPayloadShare: boolean;
  } {
    const recordsObj: Record<string, EvidenceRecord> = {};
    for (const [id, rec] of this.records) {
      recordsObj[id] = rec;
    }
    return {
      records: recordsObj,
      allowPayloadShare: this.allowPayloadShare,
    };
  }
}

// ---------------------------
// Citation Validation
// ---------------------------

export function validateCitations(
  citedIds: string[],
  registry: EvidenceRegistry
): boolean {
  for (const eid of citedIds) {
    if (typeof eid !== "string") {
      return false;
    }
    if (!registry.has(eid)) {
      return false;
    }
  }
  return true;
}

// ---------------------------
// Global Registry Instance
// ---------------------------

export const globalRegistry = new EvidenceRegistry({
  allowPayloadShare: true,
  maxPayloadBytes: 500_000,
});
