import { createHmac, timingSafeEqual } from 'crypto';
import { canonicalDumps, CanonicalizationError } from './canonical';

export class SignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignatureError';
  }
}

function hmacSha256Hex(key: Buffer, msg: Buffer): string {
  return createHmac('sha256', key).update(msg).digest('hex');
}

export interface ReceiptSig {
  kid: string;
  sig_hex: string;
}

export function signReceipt(
  unsignedOutput: Record<string, unknown>,
  kid: string,
  key: Buffer
): ReceiptSig {
  if (typeof kid !== 'string' || !kid) {
    throw new SignatureError('kid must be a non-empty string');
  }

  if (!Buffer.isBuffer(key) || key.length === 0) {
    throw new SignatureError('key must be non-empty bytes');
  }

  let payload: Buffer;
  try {
    payload = Buffer.from(canonicalDumps(unsignedOutput), 'utf-8');
  } catch (e) {
    if (e instanceof CanonicalizationError) {
      throw new SignatureError(`Cannot sign non-canonical payload: ${e.message}`);
    }
    throw e;
  }

  const sigHex = hmacSha256Hex(key, payload);

  return {
    kid,
    sig_hex: sigHex,
  };
}

export function verifyReceipt(
  unsignedOutput: Record<string, unknown>,
  receiptSig: unknown,
  kidToKey: Map<string, Buffer>
): boolean {
  try {
    if (typeof receiptSig !== 'object' || receiptSig === null) {
      return false;
    }

    const sig = receiptSig as Record<string, unknown>;
    const kid = sig.kid;
    const sigHex = sig.sig_hex;

    if (typeof kid !== 'string' || typeof sigHex !== 'string') {
      return false;
    }

    const key = kidToKey.get(kid);
    if (!key || !Buffer.isBuffer(key)) {
      return false;
    }

    const payload = Buffer.from(canonicalDumps(unsignedOutput), 'utf-8');
    const expected = hmacSha256Hex(key, payload);

    // Constant-time comparison
    const sigBuffer = Buffer.from(sigHex, 'utf-8');
    const expectedBuffer = Buffer.from(expected, 'utf-8');
    
    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    // Fail-closed: any exception means verification failed
    return false;
  }
}
