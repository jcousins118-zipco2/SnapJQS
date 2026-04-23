"""
Content-addressed evidence registry.
"""

from __future__ import annotations
import hashlib
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional, List

from .canonical import canonical_json, sha256_hex


class EvidenceType(Enum):
    TEXT = "TEXT"
    BINARY = "BINARY"
    JSON = "JSON"
    URL = "URL"


@dataclass
class Evidence:
    evidence_id: str
    evidence_type: EvidenceType
    content_hash: str
    meta: Dict[str, Any] = field(default_factory=dict)
    payload: Optional[bytes] = None


class EvidenceRegistry:
    """
    Content-addressed evidence registry.
    
    Evidence is identified by SHA-256 hash of its content.
    Supports optional payload sharing for verification.
    """

    def __init__(self, allow_payload_share: bool = False):
        self.allow_payload_share = allow_payload_share
        self._evidence: Dict[str, Evidence] = {}
        self._payloads: Dict[str, bytes] = {}

    def register(
        self,
        evidence_type: EvidenceType,
        payload: bytes,
        meta: Optional[Dict[str, Any]] = None,
    ) -> Evidence:
        """Register evidence and return Evidence object."""
        content_hash = sha256_hex(payload)
        evidence_id = f"ev:{content_hash[:16]}"
        
        ev = Evidence(
            evidence_id=evidence_id,
            evidence_type=evidence_type,
            content_hash=content_hash,
            meta=meta or {},
            payload=payload if self.allow_payload_share else None,
        )
        
        self._evidence[evidence_id] = ev
        self._payloads[evidence_id] = payload
        
        return ev

    def get(self, evidence_id: str) -> Optional[Evidence]:
        return self._evidence.get(evidence_id)

    def get_payload(self, evidence_id: str) -> Optional[bytes]:
        return self._payloads.get(evidence_id)

    def root_hash(self) -> str:
        """Compute Merkle-like root hash of all evidence."""
        if not self._evidence:
            return sha256_hex(b"{}")
        
        hashes = sorted(ev.content_hash for ev in self._evidence.values())
        combined = "|".join(hashes)
        return sha256_hex(combined.encode("utf-8"))

    def export_index(self) -> Dict[str, Any]:
        """Export evidence index for juror prompts."""
        return {
            "root_hash": self.root_hash(),
            "evidence": {
                eid: {
                    "type": ev.evidence_type.value,
                    "content_hash": ev.content_hash,
                    "meta": ev.meta,
                }
                for eid, ev in self._evidence.items()
            },
        }
