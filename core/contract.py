# core/contract.py
from __future__ import annotations

import json
from enum import Enum
from typing import Any, Dict, List, Sequence

from core.predicates import PredicateSpec

class Status(Enum):
    PROVEN = "PROVEN"
    DISPROVEN = "DISPROVEN"
    UNKNOWN = "UNKNOWN"


def _json_dumps(obj: Any) -> str:
    # Keep boring + stable; your canonicalizer in kernel is stronger,
    # but prompts just need consistent display.
    return json.dumps(obj, sort_keys=True, ensure_ascii=True, indent=2)


def build_juror_prompt(
    *,
    role: str,
    case_id: str,
    predicates: Sequence[PredicateSpec],
    evidence_index: Dict[str, Any],
) -> str:
    """
    Vendor-agnostic juror contract prompt.

    Key principles:
    - UNKNOWN is valid and preferred over guessing.
    - DISPROVEN is asymmetric: must include verdict_code + ≥1 valid cited_evidence_id.
    - Do NOT invent evidence IDs. Invented IDs will downgrade your DISPROVEN to UNKNOWN.
    """
    # Present evidence IDs list to reduce mistakes
    ev_ids: List[str] = []
    try:
        ev_ids = list(evidence_index.get("evidence", {}).keys())
        ev_ids.sort()
    except Exception:
        ev_ids = []

    pred_lines: List[str] = []
    for p in predicates:
        pred_lines.append(f"- {p.predicate_id}: {p.title}")
        for c in p.criteria:
            pred_lines.append(f"  - {c}")

    return "\n".join(
        [
            f"ROLE: {role}",
            f"CASE_ID: {case_id}",
            "",
            "You are one juror in a Juried Quorum System (JQS).",
            "Your job is to return ONLY a JSON array (no extra text).",
            "",
            "ABSOLUTE RULES:",
            "1) If you are not sure, return UNKNOWN. Do NOT guess.",
            "2) If you return DISPROVEN, you MUST provide:",
            "   - verdict_code (short machine code)",
            "   - cited_evidence_ids: at least one evidence_id that exists in the registry",
            "3) You MUST NOT invent evidence IDs. If you cite an ID not in the registry,",
            "   your DISPROVEN will be downgraded to UNKNOWN and treated as no veto.",
            "",
            "OUTPUT FORMAT (JSON array):",
            "[",
            '  {"predicate_id":"...", "status":"PROVEN|DISPROVEN|UNKNOWN", '
            '"verdict_code":"(required iff DISPROVEN)", '
            '"cited_evidence_ids":["ev_..."] (required iff DISPROVEN)}',
            "]",
            "",
            "PREDICATES:",
            *pred_lines,
            "",
            "EVIDENCE REGISTRY (IDs you may cite):",
            _json_dumps(ev_ids),
            "",
            "EVIDENCE INDEX (metadata only; payloads may be withheld):",
            _json_dumps(evidence_index),
            "",
            "REMINDER:",
            "- UNKNOWN is acceptable and safe.",
            "- DISPROVEN without real citations will not count.",
        ]
    )
