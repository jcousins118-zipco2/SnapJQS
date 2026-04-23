
import { createHash } from 'crypto';

export class CanonicalizationError extends Error {}

function validateCanonicalTypes(obj: unknown): void {
  if (obj === undefined || obj === null) return;
  
  if (typeof obj === 'number') {
    if (!Number.isInteger(obj)) {
      throw new CanonicalizationError("Floats are forbidden (determinism risk).");
    }
    return;
  }
  
  if (typeof obj === 'boolean' || typeof obj === 'string') return;
  
  if (Array.isArray(obj)) {
    for (const item of obj) {
      validateCanonicalTypes(item);
    }
    return;
  }
  
  if (typeof obj === 'object') {
    if (obj instanceof Set) throw new CanonicalizationError("Sets are forbidden (order non-deterministic; use sorted lists).");
    if (obj instanceof Map) throw new CanonicalizationError("Maps are forbidden.");
    if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) {
        throw new CanonicalizationError("Bytes are forbidden (use evidence blobs + digests, or encode as strings).");
    }

    const keys = Object.keys(obj as object);
    for (const k of keys) {
      validateCanonicalTypes((obj as any)[k]);
    }
    return;
  }

  throw new CanonicalizationError(`Type not allowed in canonical JSON: ${typeof obj}`);
}

function escapeString(s: string): string {
    // Replicates Python's ensure_ascii=True (escapes non-ASCII)
    // and standard JSON escaping for quotes/control chars
    const json = JSON.stringify(s);
    return json.replace(/[\u007f-\uffff]/g, (c) => {
        return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });
}

export function canonicalDumps(obj: unknown): string {
  validateCanonicalTypes(obj);
  
  return (function serialize(node: unknown): string {
    if (node === null) return 'null';
    if (typeof node === 'boolean') return node ? 'true' : 'false';
    if (typeof node === 'number') return node.toString();
    if (typeof node === 'string') return escapeString(node);
    
    if (Array.isArray(node)) {
        const parts = node.map(serialize);
        return `[${parts.join(',')}]`;
    }
    
    if (typeof node === 'object') {
        const keys = Object.keys(node as object).sort();
        const parts: string[] = [];
        
        for (const k of keys) {
            const val = (node as any)[k];
            // JSON spec ignores undefined/functions in objects
            if (val === undefined || typeof val === 'function' || typeof val === 'symbol') continue;
            parts.push(`${escapeString(k)}:${serialize(val)}`);
        }
        return `{${parts.join(',')}}`;
    }
    throw new CanonicalizationError(`Unserializable type: ${typeof node}`);
  })(obj);
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
