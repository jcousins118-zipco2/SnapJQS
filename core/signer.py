"""
HMAC-SHA256 receipt signing and verification.
"""

from __future__ import annotations
import hmac
import hashlib
import time
from typing import Any, Dict, Optional

from .canonical import canonical_json


def sign_receipt(
    unsigned_output: Dict[str, Any],
    kid: str,
    key: bytes,
) -> Dict[str, Any]:
    """
    Sign an unsigned receipt payload with HMAC-SHA256.
    
    Returns a receipt signature object containing:
    - kid: Key identifier
    - alg: Algorithm (HMAC-SHA256)
    - ts: Timestamp (ISO format)
    - sig: HMAC signature (hex)
    """
    ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    canonical = canonical_json(unsigned_output)
    
    sig = hmac.new(key, canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    
    return {
        "kid": kid,
        "alg": "HMAC-SHA256",
        "ts": ts,
        "sig": sig,
    }


def verify_receipt(
    unsigned_output: Dict[str, Any],
    receipt_sig: Dict[str, Any],
    kid_to_key: Dict[str, bytes],
) -> bool:
    """
    Verify a receipt signature.
    
    Returns True if signature is valid, False otherwise.
    Uses timing-safe comparison to prevent timing attacks.
    """
    kid = receipt_sig.get("kid")
    if not kid or kid not in kid_to_key:
        return False
    
    key = kid_to_key[kid]
    canonical = canonical_json(unsigned_output)
    
    expected_sig = hmac.new(key, canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    actual_sig = receipt_sig.get("sig", "")
    
    return hmac.compare_digest(expected_sig, actual_sig)
