#!/usr/bin/env python3
"""
tools/verify_receipt.py

Independent receipt verifier (Replit/laptop safe).

Purpose:
- Verifies a JQS receipt_sig (kid + sig_hex) against an unsigned_output payload,
  using the same canonicalization rules as the kernel.

Inputs:
- unsigned_output JSON file (the exact dict that was signed)
- receipt_sig JSON file ({"kid": "...", "sig_hex": "..."})
- keys JSON file mapping kid -> key (as hex OR utf8 string)

Example keys file (keys.json):
{
  "jqs-k1": {"encoding": "utf8", "value": "dev-secret-change-me"}
}
or:
{
  "jqs-k1": {"encoding": "hex", "value": "6465762d7365637265742d6368616e67652d6d65"}
}

Usage:
  python tools/verify_receipt.py unsigned.json receipt_sig.json keys.json

Exit codes:
  0 = verified
  2 = failed verification / bad inputs
"""

from __future__ import annotations

import hashlib
import hmac
import json
import sys
from typing import Any, Dict, Mapping


def canonicalize(obj: Any) -> str:
    """
    RFC 8785-style canonical JSON serialization.
    - Sorted object keys
    - No whitespace
    - Minimal escaping
    """
    if obj is None:
        return "null"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, int):
        return str(obj)
    if isinstance(obj, float):
        if not (obj == obj):  # NaN check
            raise ValueError("NaN not allowed")
        if obj == float("inf") or obj == float("-inf"):
            raise ValueError("Infinity not allowed")
        # Handle -0
        if obj == 0.0:
            return "0"
        return repr(obj) if "e" in repr(obj).lower() else str(obj)
    if isinstance(obj, str):
        return json.dumps(obj, ensure_ascii=False)
    if isinstance(obj, list):
        return "[" + ",".join(canonicalize(v) for v in obj) + "]"
    if isinstance(obj, dict):
        pairs = []
        for k in sorted(obj.keys()):
            pairs.append(json.dumps(k, ensure_ascii=False) + ":" + canonicalize(obj[k]))
        return "{" + ",".join(pairs) + "}"
    raise TypeError(f"Unsupported type: {type(obj)}")


def load_json(path: str) -> Any:
    """Load JSON from file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def decode_key(spec: Any) -> bytes:
    """
    Key spec forms:
      - {"encoding":"utf8","value":"..."}
      - {"encoding":"hex","value":"..."}
      - OR a plain string (treated as utf8) for convenience
    """
    if isinstance(spec, str):
        return spec.encode("utf-8")

    if not isinstance(spec, dict):
        raise ValueError("Key spec must be a dict or string")

    enc = spec.get("encoding")
    val = spec.get("value")

    if not isinstance(enc, str) or not isinstance(val, str):
        raise ValueError("Key spec requires 'encoding' and 'value' strings")

    enc_u = enc.strip().lower()
    if enc_u == "utf8":
        return val.encode("utf-8")
    if enc_u == "hex":
        return bytes.fromhex(val.strip())
    raise ValueError(f"Unknown key encoding: {enc}")


def load_keys(keys_path: str) -> Mapping[str, bytes]:
    """Load keys from JSON file."""
    raw = load_json(keys_path)
    if not isinstance(raw, dict):
        raise ValueError("keys.json must be an object mapping kid -> key spec")

    out: Dict[str, bytes] = {}
    for kid, spec in raw.items():
        if not isinstance(kid, str) or not kid:
            continue
        out[kid] = decode_key(spec)
    return out


def verify_receipt(
    unsigned_output: Dict[str, Any],
    receipt_sig: Dict[str, Any],
    kid_to_key: Mapping[str, bytes],
) -> bool:
    """Verify receipt signature."""
    kid = receipt_sig.get("kid")
    sig_hex = receipt_sig.get("sig_hex")

    if not kid or not sig_hex:
        return False

    key = kid_to_key.get(kid)
    if not key:
        return False

    canon = canonicalize(unsigned_output)
    expected = hmac.new(key, canon.encode("utf-8"), hashlib.sha256).hexdigest()

    # Constant-time comparison
    return hmac.compare_digest(expected, sig_hex)


def main(argv: list) -> int:
    if len(argv) != 4:
        print("Usage: python tools/verify_receipt.py unsigned.json receipt_sig.json keys.json")
        print()
        print("Example keys.json:")
        print('  {"jqs-k1": {"encoding": "utf8", "value": "dev-secret-change-me"}}')
        return 2

    unsigned_path, sig_path, keys_path = argv[1], argv[2], argv[3]

    try:
        unsigned_output = load_json(unsigned_path)
        receipt_sig = load_json(sig_path)
        kid_to_key = load_keys(keys_path)

        if not isinstance(unsigned_output, dict):
            print("FAIL: unsigned.json must be a JSON object")
            return 2
        if not isinstance(receipt_sig, dict):
            print("FAIL: receipt_sig.json must be a JSON object")
            return 2

        ok = verify_receipt(
            unsigned_output=unsigned_output,
            receipt_sig=receipt_sig,
            kid_to_key=kid_to_key,
        )

        if ok:
            print("VERIFIED: signature valid")
            return 0

        print("FAILED: signature invalid (or unknown kid / non-canonical payload)")
        return 2

    except Exception as e:
        print(f"ERROR: {e}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
