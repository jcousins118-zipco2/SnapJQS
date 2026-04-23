#!/usr/bin/env npx tsx
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

function canonicalize(obj: unknown): string {
  if (obj === null) return "null";
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (typeof obj === "number") {
    if (!Number.isFinite(obj)) throw new Error("Non-finite number");
    return Object.is(obj, -0) ? "0" : String(obj);
  }
  if (typeof obj === "string") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalize).join(",") + "]";
  }
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(
      (k) => JSON.stringify(k) + ":" + canonicalize((obj as Record<string, unknown>)[k])
    );
    return "{" + pairs.join(",") + "}";
  }
  throw new Error(`Unsupported type: ${typeof obj}`);
}

function loadJson(filePath: string): unknown {
  const content = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(content);
}

function decodeKey(spec: unknown): Buffer {
  if (typeof spec === "string") {
    return Buffer.from(spec, "utf-8");
  }
  if (typeof spec === "object" && spec !== null) {
    const s = spec as Record<string, unknown>;
    const enc = String(s.encoding || "").toLowerCase().trim();
    const val = String(s.value || "");
    if (enc === "utf8") return Buffer.from(val, "utf-8");
    if (enc === "hex") return Buffer.from(val, "hex");
    throw new Error(`Unknown key encoding: ${enc}`);
  }
  throw new Error("Key spec must be string or {encoding, value}");
}

function verifyReceipt(
  unsignedOutput: Record<string, unknown>,
  receiptSig: { kid?: string; sig_hex?: string },
  kidToKey: Map<string, Buffer>
): boolean {
  const kid = receiptSig.kid;
  const sigHex = receiptSig.sig_hex;

  if (!kid || !sigHex) return false;

  const key = kidToKey.get(kid);
  if (!key) return false;

  const canon = canonicalize(unsignedOutput);
  const expected = crypto.createHmac("sha256", key).update(canon).digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(sigHex, "hex")
  );
}

function main(): number {
  const args = process.argv.slice(2);

  if (args.length !== 3) {
    console.log("Usage: npx tsx tools/verify-receipt.ts unsigned.json receipt_sig.json keys.json");
    console.log("");
    console.log("Example keys.json:");
    console.log('  {"jqs-k1": {"encoding": "utf8", "value": "dev-secret-change-me"}}');
    return 2;
  }

  const [unsignedPath, sigPath, keysPath] = args;

  try {
    const unsignedOutput = loadJson(unsignedPath) as Record<string, unknown>;
    const receiptSig = loadJson(sigPath) as { kid?: string; sig_hex?: string };
    const keysRaw = loadJson(keysPath) as Record<string, unknown>;

    const kidToKey = new Map<string, Buffer>();
    for (const [kid, spec] of Object.entries(keysRaw)) {
      kidToKey.set(kid, decodeKey(spec));
    }

    const ok = verifyReceipt(unsignedOutput, receiptSig, kidToKey);

    if (ok) {
      console.log("VERIFIED: signature valid");
      return 0;
    } else {
      console.log("FAILED: signature invalid (or unknown kid / non-canonical payload)");
      return 2;
    }
  } catch (e) {
    console.log(`ERROR: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
}

process.exit(main());
