# prompt_compiler.py
# Drop-in: converts any user question into a quorum-friendly "IF → THEN" case,
# and generates (1) primary juror prompt + (2) cheap verifier prompts.

import re
from dataclasses import dataclass
from typing import Dict, List


@dataclass(frozen=True)
class QuorumCase:
    if_text: str
    primary_prompt: str
    verifier_prompt: str
    gap_prompt: str
    conflict_prompt: str


_MUST_RE = re.compile(r"\b(must|must not|may|may not|should|should not|authorized to)\b", re.I)


def _ensure_if_form(q: str) -> str:
    q = (q or "").strip()
    if not q:
        return "If no question is provided, what follows?"

    # If already an IF-form question, keep it.
    if re.match(r"^\s*if\b", q, flags=re.I):
        # Ensure it ends like a question
        if not q.rstrip().endswith("?"):
            q = q.rstrip().rstrip(".") + "?"
        return q

    # Otherwise wrap as IF
    q2 = q.rstrip().rstrip("?").rstrip(".")
    return f"If {q2}, what follows?"


def _extract_constraints(if_text: str) -> List[str]:
    # Cheap heuristic: pull fragments around modality words
    tokens = re.split(r"[,;]\s*|\band\b\s+", if_text, flags=re.I)
    out: List[str] = []
    for t in tokens:
        if _MUST_RE.search(t):
            cleaned = t.strip().rstrip("?").rstrip(".")
            if cleaned and cleaned.lower() not in ("if", "what follows"):
                out.append(cleaned)
    return out[:10]  # cap


def compile_for_quorum(user_question: str) -> QuorumCase:
    if_text = _ensure_if_form(user_question)
    constraints = _extract_constraints(if_text)

    # Primary juror: do NOT restate; derive; produce a longer helpful answer when authorized.
    primary = (
        "ROLE: Primary Juror (Deriver)\n"
        "TASK: Given the IF statement, derive concrete implications.\n"
        "RULES:\n"
        "- DO NOT paraphrase the IF.\n"
        "- DO NOT restate the objective as the conclusion.\n"
        "- Only use constraints explicitly present in the IF.\n"
        "- If the IF is underdetermined, ask for ONE minimum missing constraint.\n"
        "- Otherwise, output a concrete plan/selection/sequence consistent with the IF.\n"
        "\n"
        "OUTPUT FORMAT (exact):\n"
        "Status: SETTLED | NOT_SETTLED\n"
        "Conclusion: <one sentence>\n"
        "Implications:\n"
        "- <3–7 bullets; concrete actions/sequencing/exclusions>\n"
        "Plain-language public version:\n"
        "- <2–4 bullets; no jargon>\n"
        "\n"
        f"IF:\n{if_text}\n"
    )

    # Cheap verifier: PASS/FAIL whether Primary executed constraints vs restated
    verifier = (
        "ROLE: Verifier Juror (Cheap)\n"
        "TASK: Judge whether the Primary answer EXECUTES the IF (derives actions/tradeoffs)\n"
        "or merely RESTATES it.\n"
        "Reply with exactly:\n"
        "Vote: PASS | FAIL\n"
        "Reason: <max 12 words>\n"
        "\n"
        "IF:\n"
        f"{if_text}\n"
        + (
            "\nExtracted constraints:\n- " + "\n- ".join(constraints) + "\n"
            if constraints
            else ""
        )
    )

    # Gap juror: decide if one missing constraint is required; keep it ultra-short
    gap = (
        "ROLE: Gap Juror (Ultra-cheap)\n"
        "TASK: Is the IF sufficiently specified to derive a concrete plan?\n"
        "Reply with exactly one of:\n"
        "OK\n"
        "NEED_DETAIL: <ask for ONE missing constraint>\n"
        "\n"
        f"IF:\n{if_text}\n"
    )

    # Conflict juror: ultra-cheap contradiction / impossibility detector
    conflict = (
        "ROLE: Conflict Juror (Ultra-cheap)\n"
        "TASK: Decide if the IF contains mutually incompatible constraints.\n"
        "Reply with exactly one of:\n"
        "NO_CONFLICT\n"
        "CONFLICT: <max 12 words naming the two conflicting constraints>\n"
        "\n"
        f"IF:\n{if_text}\n"
        + (
            "\nExtracted constraints:\n- " + "\n- ".join(constraints) + "\n"
            if constraints
            else ""
        )
    )

    return QuorumCase(
        if_text=if_text,
        primary_prompt=primary,
        verifier_prompt=verifier,
        gap_prompt=gap,
        conflict_prompt=conflict,
    )


# --- minimal usage example ---
if __name__ == "__main__":
    q = "A city must reduce traffic accidents while preserving public trust."
    case = compile_for_quorum(q)
    print(case.if_text)
    print("\n--- primary ---\n", case.primary_prompt[:600], "...\n")
    print("\n--- verifier ---\n", case.verifier_prompt)
    print("\n--- gap ---\n", case.gap_prompt)
    print("\n--- conflict ---\n", case.conflict_prompt)
