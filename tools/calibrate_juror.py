# tools/calibrate_juror.py
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from core.contract import build_juror_prompt
from core.evidence import EvidenceRegistry, EvidenceType
from core.predicates import default_predicates, PredicateSpec
# Assuming core.contract also contains normalization or adjusting to what's available
# In the previous setup we had server/contract.ts, now we have core/contract.py
# If normalize_juror_output is missing, we'll need to define it or adjust.
# Given the user's snippet, I'll add a minimal juror_interface if needed or assume it's there.

@dataclass(frozen=True)
class RawJurorOutput:
    predicate_id: str
    status: Any # Status enum or string
    verdict_code: Optional[str] = None
    cited_evidence_ids: List[str] = None

def normalize_juror_output(raw_text: str) -> List[RawJurorOutput]:
    import re
    from core.contract import Status # assuming it exists or defining locally
    # Local Status if not in core.contract
    try:
        from core.contract import Status
    except ImportError:
        from enum import Enum
        class Status(Enum):
            PROVEN = "PROVEN"
            DISPROVEN = "DISPROVEN"
            UNKNOWN = "UNKNOWN"

    raw_text = raw_text.strip()
    json_match = re.search(r"\[[\s\S]*\]", raw_text)
    if not json_match:
        return []
    try:
        data = json.loads(json_match.group())
        return [RawJurorOutput(
            predicate_id=item.get("predicate_id"),
            status=Status(item.get("status", "UNKNOWN")),
            verdict_code=item.get("verdict_code"),
            cited_evidence_ids=item.get("cited_evidence_ids", [])
        ) for item in data]
    except:
        return []

@dataclass(frozen=True)
class LabeledCase:
    """
    One calibration case:
    - evidence payload(s)
    - expected per-predicate status for the juror (not the quorum)
    """
    case_id: str
    label: Dict[str, str]  # predicate_id -> "PROVEN|DISPROVEN|UNKNOWN"
    notes: str = ""


def _read_multiline(prompt: str) -> str:
    print(prompt)
    print("(Paste JSON array. Type END on its own line to finish.)")
    lines: List[str] = []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line.strip() == "END":
            break
        lines.append(line)
    return "\n".join(lines).strip()


def _load_cases(path: str) -> List[LabeledCase]:
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    out: List[LabeledCase] = []
    if not isinstance(raw, list):
        raise ValueError("cases JSON must be a list")
    for item in raw:
        if not isinstance(item, dict):
            continue
        cid = str(item.get("case_id", "")).strip() or "case"
        lab = item.get("label", {})
        if not isinstance(lab, dict):
            continue
        label = {str(k): str(v).strip().upper() for k, v in lab.items()}
        notes = str(item.get("notes", "") or "")
        out.append(LabeledCase(case_id=cid, label=label, notes=notes))
    return out


def _score_case(
    *,
    preds: List[PredicateSpec],
    expected: Dict[str, str],
    actual: List[RawJurorOutput],
) -> Tuple[int, int, Dict[str, Dict[str, int]]]:
    """
    Returns:
      correct, total, per_pred_counts:
        per_pred_counts[predicate_id] = {"TP":..,"TN":..,"FP":..,"FN":..,"UNK":..}
    Where we treat:
      expected PROVEN as positive class for TPR
      expected DISPROVEN as negative class for TNR
      expected UNKNOWN contributes to UNK accounting only (not TPR/TNR)
    """
    actual_map: Dict[str, str] = {a.predicate_id: a.status.value for a in actual}

    correct = 0
    total = 0
    per: Dict[str, Dict[str, int]] = {}

    for p in preds:
        pid = p.predicate_id
        exp = expected.get(pid, "UNKNOWN").strip().upper()
        got = actual_map.get(pid, "UNKNOWN").strip().upper()

        per.setdefault(pid, {"TP": 0, "TN": 0, "FP": 0, "FN": 0, "UNK": 0})

        # correctness (simple)
        total += 1
        if got == exp:
            correct += 1

        # calibration accounting
        if exp == "UNKNOWN":
            per[pid]["UNK"] += 1
            continue

        # define: PROVEN = "positive", DISPROVEN = "negative"
        if exp == "PROVEN":
            if got == "PROVEN":
                per[pid]["TP"] += 1
            elif got == "DISPROVEN":
                per[pid]["FN"] += 1
            else:
                per[pid]["UNK"] += 1
        elif exp == "DISPROVEN":
            if got == "DISPROVEN":
                per[pid]["TN"] += 1
            elif got == "PROVEN":
                per[pid]["FP"] += 1
            else:
                per[pid]["UNK"] += 1

    return correct, total, per


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python tools/calibrate_juror.py tests/calibration_cases.json")
        raise SystemExit(2)

    cases_path = sys.argv[1]
    cases = _load_cases(cases_path)
    preds = default_predicates()

    # Build a registry once (same evidence IDs across cases is fine for calibration discipline).
    reg = EvidenceRegistry(allow_payload_share=False)
    ev1 = reg.register(
        evidence_type=EvidenceType.TEXT,
        payload=b"Calibration evidence A: replay timeline log excerpt (demo).",
        meta={"name": "calib_replay", "source": "calibration"},
    )
    ev2 = reg.register(
        evidence_type=EvidenceType.TEXT,
        payload=b"Calibration evidence B: rollback trace excerpt (demo).",
        meta={"name": "calib_rollback", "source": "calibration"},
    )
    evidence_index = reg.export_index()

    print("\n=== JQS Juror Calibration (manual paste) ===")
    print("Evidence IDs you may cite:")
    print(" -", ev1.evidence_id, ev1.meta.get("name"))
    print(" -", ev2.evidence_id, ev2.meta.get("name"))
    print()

    total_correct = 0
    total_items = 0
    agg: Dict[str, Dict[str, int]] = {}

    for i, c in enumerate(cases, 1):
        print(f"\n=== CASE {i}/{len(cases)}: {c.case_id} ===")
        if c.notes:
            print("Notes:", c.notes)

        prompt = build_juror_prompt(
            role="CALIBRATION_JUROR",
            case_id=c.case_id,
            predicates=preds,
            evidence_index=evidence_index,
        )
        print("\n--- Paste this into the juror (LLM) ---\n")
        print(prompt)

        raw = _read_multiline("\n--- Paste juror JSON output here ---")
        normalized = normalize_juror_output(raw)  # should return List[RawJurorOutput]

        correct, total, per = _score_case(preds=preds, expected=c.label, actual=normalized)
        total_correct += correct
        total_items += total

        # aggregate
        for pid, counts in per.items():
            agg.setdefault(pid, {"TP": 0, "TN": 0, "FP": 0, "FN": 0, "UNK": 0})
            for k, v in counts.items():
                agg[pid][k] += v

        print(f"\nCase accuracy: {correct}/{total}")

    print("\n=== SUMMARY ===")
    print(f"Overall accuracy: {total_correct}/{total_items} = {round(100.0*total_correct/max(1,total_items), 1)}%")
    print("\nPer-predicate calibration:")
    for pid, cts in agg.items():
        tp, tn, fp, fn, unk = cts["TP"], cts["TN"], cts["FP"], cts["FN"], cts["UNK"]
        tpr = (tp / max(1, (tp + fn)))  # PROVEN detection
        tnr = (tn / max(1, (tn + fp)))  # DISPROVEN detection
        print(f"- {pid}: TPR={round(100*tpr,1)}%  TNR={round(100*tnr,1)}%  UNKNOWN={unk}")

    print("\nNOTE:")
    print("- This tool is OFFLINE calibration only. It MUST NOT be used in the runtime gate.")
    print("- If your juror starts hallucinating disproofs, you should see UNKNOWN rise or TNR wobble.")
    print("Done.")


if __name__ == "__main__":
    main()
