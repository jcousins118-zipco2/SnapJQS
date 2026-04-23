"""
Canonical JSON processing for JQS.

Provides deterministic JSON serialization and SHA-256 hashing.
"""

from __future__ import annotations
import json
import hashlib
from typing import Any


def canonical_json(obj: Any) -> str:
    """
    Deterministic JSON serialization.
    
    - Keys sorted alphabetically
    - No extra whitespace
    - ASCII-only output
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_hex(data: bytes) -> str:
    """Compute SHA-256 hash and return hex string."""
    return hashlib.sha256(data).hexdigest()


def hash_json(obj: Any) -> str:
    """Compute SHA-256 hash of canonical JSON representation."""
    return sha256_hex(canonical_json(obj).encode("utf-8"))
