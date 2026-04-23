# core/predicates.py
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Sequence


@dataclass(frozen=True)
class PredicateSpec:
    """
    A predicate is a YES/NO/UNKNOWN question the jurors must evaluate.

    IMPORTANT:
    - Predicates must be crisp and testable.
    - Runtime logic must remain deterministic and fail-closed.
    """
    predicate_id: str
    title: str
    criteria: List[str]  # bullet criteria shown to jurors (human readable, but crisp)
    required: bool = True
    disproof_requires_citation: bool = True  # asymmetric trust: DISPROVEN must cite registry evidence


def default_predicates() -> List[PredicateSpec]:
    """
    Default "pilot" predicate set:
    - Focused on preventing the worst failure: hallucinated veto / invented evidence.
    - Keep minimal, expand later.
    """
    return [
        PredicateSpec(
            predicate_id="REPLAY_SAFE",
            title="No replay / duplicate commit risk",
            criteria=[
                "If you see any evidence of replay, duplication, or non-monotonic attempt state: DISPROVEN.",
                "If evidence is missing/insufficient to conclude: UNKNOWN (do not guess).",
            ],
            required=True,
            disproof_requires_citation=True,
        ),
        PredicateSpec(
            predicate_id="ROLLBACK_SAFE",
            title="No rollback / time-travel risk",
            criteria=[
                "If you see evidence of rollback or ambiguous timeline progression: DISPROVEN.",
                "If you cannot confirm from the provided evidence: UNKNOWN.",
            ],
            required=True,
            disproof_requires_citation=True,
        ),
        PredicateSpec(
            predicate_id="CITATION_GATING_WORKS",
            title="Citation gating is enforced",
            criteria=[
                "DISPROVEN must cite at least one valid evidence_id from the registry.",
                "If you cannot cite real evidence_id(s), you MUST return UNKNOWN (not DISPROVEN).",
            ],
            required=True,
            disproof_requires_citation=True,
        ),
    ]


def required_predicate_ids(preds: Sequence[PredicateSpec]) -> List[str]:
    return [p.predicate_id for p in preds if p.required]


def predicate_index(preds: Sequence[PredicateSpec]) -> Dict[str, PredicateSpec]:
    return {p.predicate_id: p for p in preds}
