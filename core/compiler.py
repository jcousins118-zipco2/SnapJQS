from __future__ import annotations

from dataclasses import dataclass
from typing import List, Literal


DecisionType = Literal[
    "TECH_SELECTION",
    "POLICY_DECISION",
    "COST_OPTIMIZATION",
    "SAFETY_ASSESSMENT",
    "CODE_REVIEW",
]


@dataclass(frozen=True)
class CompiledQuestion:
    decision_type: DecisionType
    decision_statement: str
    options: List[str]
    constraints: List[str]
    required_predicates: List[str]


class QuestionCompilerError(Exception):
    pass


def _clean_nonempty_str(x: object, field_name: str) -> str:
    if not isinstance(x, str):
        raise QuestionCompilerError(f"{field_name} must be a string")
    s = x.strip()
    if not s:
        raise QuestionCompilerError(f"{field_name} must be a non-empty string")
    return s


def _clean_str_list(xs: object, field_name: str) -> List[str]:
    if not isinstance(xs, list) or not xs:
        raise QuestionCompilerError(f"{field_name} must be a non-empty list of strings")
    out: List[str] = []
    for i, item in enumerate(xs):
        try:
            out.append(_clean_nonempty_str(item, f"{field_name}[{i}]"))
        except QuestionCompilerError as e:
            raise e
    # canonicalize: dedupe + sort
    return sorted(set(out))


def compile_question(
    *,
    decision_type: DecisionType,
    decision_statement: str,
    options: List[str],
    constraints: List[str],
    required_predicates: List[str],
) -> CompiledQuestion:
    """
    Deterministically compiles a human question into a JQS-ready frame.

    Notes:
    - Input lists may contain duplicates; output is always deduplicated + sorted.
    - Fail-closed: any malformed input raises QuestionCompilerError.
    """
    ds = _clean_nonempty_str(decision_statement, "decision_statement")
    opts = _clean_str_list(options, "options")
    cons = _clean_str_list(constraints, "constraints")
    preds = _clean_str_list(required_predicates, "required_predicates")

    return CompiledQuestion(
        decision_type=decision_type,
        decision_statement=ds,
        options=opts,
        constraints=cons,
        required_predicates=preds,
    )


# ---- Convenience helpers ----


def tech_selection(
    *,
    decision_statement: str,
    options: List[str],
    constraints: List[str],
) -> CompiledQuestion:
    return compile_question(
        decision_type="TECH_SELECTION",
        decision_statement=decision_statement,
        options=options,
        constraints=constraints,
        required_predicates=[
            "VIABLE_IN_CONTEXT",
            "COST_ACCEPTABLE",
            "MEETS_REGULATIONS",
        ],
    )


def code_review(
    *,
    decision_statement: str,
    options: List[str],
    constraints: List[str],
) -> CompiledQuestion:
    return compile_question(
        decision_type="CODE_REVIEW",
        decision_statement=decision_statement,
        options=options,
        constraints=constraints,
        required_predicates=[
            "CODE_COMPILES",
            "NO_UNBOUNDED_SIDE_EFFECTS",
            "NO_NETWORK_IO",
            "DETERMINISTIC_OUTPUT",
            "MATCHES_SPEC",
        ],
    )
