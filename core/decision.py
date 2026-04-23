"""
JQS decision logic - ALLOW/BLOCK/ESCALATE verdict computation.
"""

from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List

from .contract import Status


class Verdict(Enum):
    ALLOW = "ALLOW"
    BLOCK = "BLOCK"
    ESCALATE = "ESCALATE"


@dataclass
class Decision:
    verdict: Verdict
    blocking_predicates: List[str]
    predicate_results: Dict[str, Status]


def decide(
    required_predicates: List[str],
    predicate_results: Dict[str, Status],
    force_escalate: bool = False,
) -> Decision:
    """
    Compute verdict from predicate results.
    
    - ALLOW: All predicates PROVEN
    - BLOCK: Any predicate REFUTED
    - ESCALATE: Any predicate UNKNOWN (or force_escalate=True)
    """
    if force_escalate:
        return Decision(
            verdict=Verdict.ESCALATE,
            blocking_predicates=["FORCE_ESCALATE"],
            predicate_results=predicate_results,
        )
    
    blocking: List[str] = []
    has_unknown = False
    
    for pred in required_predicates:
        status = predicate_results.get(pred, Status.UNKNOWN)
        
        if status == Status.REFUTED:
            blocking.append(pred)
        elif status == Status.UNKNOWN:
            has_unknown = True
            blocking.append(pred)
    
    if any(predicate_results.get(p) == Status.REFUTED for p in required_predicates):
        return Decision(
            verdict=Verdict.BLOCK,
            blocking_predicates=blocking,
            predicate_results=predicate_results,
        )
    
    if has_unknown:
        return Decision(
            verdict=Verdict.ESCALATE,
            blocking_predicates=blocking,
            predicate_results=predicate_results,
        )
    
    return Decision(
        verdict=Verdict.ALLOW,
        blocking_predicates=[],
        predicate_results=predicate_results,
    )


def merge_predicates(
    juror_results: List[Dict[str, Status]],
    required_predicates: List[str],
) -> Dict[str, Status]:
    """
    Merge predicate results from multiple jurors.
    
    Conservative merge:
    - REFUTED if any juror says REFUTED
    - PROVEN only if all jurors say PROVEN
    - UNKNOWN otherwise
    """
    merged: Dict[str, Status] = {}
    
    for pred in required_predicates:
        statuses = [jr.get(pred, Status.UNKNOWN) for jr in juror_results]
        
        if any(s == Status.REFUTED for s in statuses):
            merged[pred] = Status.REFUTED
        elif all(s == Status.PROVEN for s in statuses):
            merged[pred] = Status.PROVEN
        else:
            merged[pred] = Status.UNKNOWN
    
    return merged
