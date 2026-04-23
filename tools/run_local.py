# tools/run_local.py
#
# Kernel-enabled harness for JQS + SnapSpace Lite (Replit).
#
# Runs:
# - Evidence registry
# - Manual juror paste
# - JQS decision + receipt
# - OPTIONAL SnapSpace kernel commit (exactly-once, monotonic, replay-proof)
#
# Output shows:
# - JQS verdict
# - Kernel outcome: COMMIT / DENY / FREEZE
# - Signed receipt
# - Saved artifacts + audit log

from __future__ import annotations

import os
import sys
import json
from typing import List

sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from core.evidence import EvidenceRegistry, EvidenceType
from core.contract import build_juror_prompt
from core.orchestrator import run_session, JurorInput
from core.signer import verify_receipt
from core.kernel import SnapSpaceLiteKernel, Attempt


def _read_multiline(prompt: str) -> str:
    print(prompt)
    print("(Paste JSON. Type END on its own line to finish.)")
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


def main() -> None:
    case_id = "demo_case"
    required_predicates = ["REPLAY_SAFE", "ROLLBACK_SAFE", "CITATION_GATING_WORKS"]

    signer_kid = "jqs-k1"
    signer_key = b"dev-secret-change-me"  # demo only

    audit_path = os.path.join("audit", "jqs_audit.jsonl")

    # --- Kernel on ---
    kernel = SnapSpaceLiteKernel(state_dir="snapspace_state", spent_window=2048)

    # You control the timeline (monotonic). Start at 0/0 and increment each run.
    print("\n=== Kernel Attempt ===")
    epoch = int(input("epoch (int, e.g. 0): ").strip() or "0")
    turn = int(input("turn  (int, e.g. 0 then 1 then 2...): ").strip() or "0")

    # Define the irreversible action we want to gate.
    # Keep it boring, deterministic, and minimal.
    action = {
        "action_type": "DEMO_COMMIT",
        "case_id": case_id,
        "epoch": epoch,
        "turn": turn,
    }

    # --- Evidence ---
    reg = EvidenceRegistry(allow_payload_share=False)
    ev1 = reg.register(
        evidence_type=EvidenceType.TEXT,
        payload=b"Replay protection check (demo evidence).",
        meta={"name": "replay_log", "source": "demo"},
    )
    ev2 = reg.register(
        evidence_type=EvidenceType.TEXT,
        payload=b"Rollback protection check (demo evidence).",
        meta={"name": "rollback_log", "source": "demo"},
    )
    evidence_index = reg.export_index()

    print("\n=== Evidence Registered ===")
    print("Evidence root hash:", evidence_index["root_hash"])
    print("Evidence IDs:")
    print(" -", ev1.evidence_id, ev1.meta.get("name"))
    print(" -", ev2.evidence_id, ev2.meta.get("name"))

    # --- Prompt ---
    from core.predicates import default_predicates
    prompt = build_juror_prompt(
        role="GENERAL_JUROR",
        case_id=case_id,
        predicates=default_predicates(),
        evidence_index=evidence_index,
    )
    print("\n=== Juror Prompt (paste into LLM juror) ===\n")
    print(prompt)

    # --- Collect juror outputs ---
    jurors: List[JurorInput] = []
    print("\n=== Paste Juror Outputs ===")
    print("Provide one or more jurors. Leave juror ID empty to finish.\n")

    while True:
        juror_id = input("Juror ID (e.g. gpt, gemini, human1) [enter to finish]: ").strip()
        if not juror_id:
            break
        raw = _read_multiline(f"\nPaste output for juror '{juror_id}':")
        jurors.append(JurorInput(juror_id=juror_id, raw_text=raw))
        print()

    if not jurors:
        print("\nNo juror outputs provided. Exiting.")
        return

    # --- Run session with kernel commit ---
    from core.predicates import required_predicate_ids, default_predicates
    preds = default_predicates()
    res = run_session(
        case_id=case_id,
        required_predicates=required_predicate_ids(preds),
        juror_inputs=jurors,
        evidence_registry=reg,
        signer_kid=signer_kid,
        signer_key=signer_key,
        audit_log_path=audit_path,
        force_escalate=False,
        kernel=kernel,
        attempt=Attempt(epoch=epoch, turn=turn),
        action=action,
    )

    print("\n=== JQS Result ===")
    print("Verdict:", res.verdict.value)
    print("Blocking predicates:", res.blocking_predicates)
    print("Predicate results:")
    for k, v in res.predicate_results.items():
        print(f" - {k}: {v.value}")

    print("\n=== Kernel Result ===")
    if res.kernel:
        print(f"Outcome: {res.kernel.outcome}")
        print(f"Reason:  {res.kernel.reason_code}")
        print(f"Epoch:   {res.kernel.last_epoch}")
        print(f"Turn:    {res.kernel.last_turn}")
        print(f"Head:    {res.kernel.head_hash[:16]}...")
    else:
        print("(Kernel not enabled)")

    # Reconstruct unsigned payload the same way as orchestrator did
    unsigned_payload = res.unsigned_output

    print("\n=== Signed Receipt ===")
    print("Unsigned payload:", json.dumps(unsigned_payload, indent=2, sort_keys=True))
    print("receipt_sig:", res.receipt)

    ok = verify_receipt(
        unsigned_output=unsigned_payload,
        receipt_sig=res.receipt,
        kid_to_key={signer_kid: signer_key},
    )
    print("\nReceipt verifies:", ok)

    # Save artifacts
    os.makedirs("out", exist_ok=True)
    unsigned_path = os.path.join("out", "unsigned.json")
    sig_path = os.path.join("out", "receipt_sig.json")
    with open(unsigned_path, "w", encoding="utf-8") as f:
        json.dump(unsigned_payload, f, sort_keys=True, indent=2)
    with open(sig_path, "w", encoding="utf-8") as f:
        json.dump(res.receipt, f, sort_keys=True, indent=2)

    print("\nSaved artifacts:")
    print(" -", unsigned_path)
    print(" -", sig_path)
    print("Audit log:", audit_path)
    print("Kernel state dir: snapspace_state/")
    print("Done.")


if __name__ == "__main__":
    main()
