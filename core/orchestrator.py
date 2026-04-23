"""
JQS Session Orchestrator with SnapSpace Lite Kernel integration.

Coordinates:
- Evidence registry
- Juror contract enforcement
- Decision logic
- Receipt signing
- Kernel commit (optional)
"""

from __future__ import annotations
import os
import json
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .evidence import EvidenceRegistry
from .contract import parse_juror_output, Status
from .decision import decide, merge_predicates, Verdict, Decision
from .signer import sign_receipt
from .kernel import SnapSpaceLiteKernel, Attempt, action_hash_of_obj, KernelDecision, KernelOutcome


@dataclass
class JurorInput:
    juror_id: str
    raw_text: str


@dataclass
class KernelResult:
    outcome: str
    reason_code: str
    last_epoch: int
    last_turn: int
    head_hash: str


@dataclass
class SessionResult:
    verdict: Verdict
    blocking_predicates: List[str]
    predicate_results: Dict[str, Status]
    diagnostics: Dict[str, Any]
    unsigned_output: Dict[str, Any]
    receipt: Dict[str, Any]
    kernel: Optional[KernelResult] = None


def append_audit(path: str, entry: Dict[str, Any]) -> None:
    """Append entry to audit log."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")


def run_session(
    case_id: str,
    required_predicates: List[str],
    juror_inputs: List[JurorInput],
    evidence_registry: EvidenceRegistry,
    signer_kid: str,
    signer_key: bytes,
    audit_log_path: str = "audit/jqs_audit.jsonl",
    force_escalate: bool = False,
    kernel: Optional[SnapSpaceLiteKernel] = None,
    attempt: Optional[Attempt] = None,
    action: Optional[Dict[str, Any]] = None,
) -> SessionResult:
    """
    Run a complete JQS session.
    
    1. Parse juror outputs
    2. Enforce citation requirements
    3. Merge predicate results
    4. Compute verdict
    5. If kernel enabled and ALLOW, attempt commit
    6. Sign receipt
    """
    session_ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    evidence_index = evidence_registry.export_index()
    evidence_ids = list(evidence_index.get("evidence", {}).keys())
    
    append_audit(audit_log_path, {
        "ts": session_ts,
        "case_id": case_id,
        "event": "session_start",
        "required_predicates": required_predicates,
        "evidence_root": evidence_registry.root_hash(),
        "kernel_enabled": kernel is not None,
    })
    
    juror_results: List[Dict[str, Status]] = []
    diagnostics = {
        "jurors_total": len(juror_inputs),
        "jurors_parsed": 0,
        "jurors_empty": 0,
        "citation_enforcement": True,
        "kernel_enabled": kernel is not None,
    }
    
    for ji in juror_inputs:
        parsed = parse_juror_output(
            juror_id=ji.juror_id,
            raw_text=ji.raw_text,
            required_predicates=required_predicates,
            evidence_ids=evidence_ids,
            enforce_citations=True,
        )
        
        if parsed.empty:
            diagnostics["jurors_empty"] += 1
        else:
            diagnostics["jurors_parsed"] += 1
        
        juror_results.append(parsed.predicates)
        
        append_audit(audit_log_path, {
            "ts": session_ts,
            "case_id": case_id,
            "event": "juror_parsed",
            "juror_id": ji.juror_id,
            "predicates": {k: v.value for k, v in parsed.predicates.items()},
            "empty": parsed.empty,
            "error": parsed.parse_error,
        })
    
    merged = merge_predicates(juror_results, required_predicates)
    
    decision = decide(
        required_predicates=required_predicates,
        predicate_results=merged,
        force_escalate=force_escalate,
    )
    
    kernel_result: Optional[KernelResult] = None
    
    if kernel and attempt and action:
        if decision.verdict == Verdict.ALLOW:
            action_hash = action_hash_of_obj(action)
            kd = kernel.commit(
                epoch=attempt.epoch,
                turn=attempt.turn,
                action_hash=action_hash,
                context={"case_id": case_id, "action": action},
            )
            
            kernel_result = KernelResult(
                outcome=kd.outcome.value,
                reason_code=kd.reason_code.value,
                last_epoch=kd.last_epoch,
                last_turn=kd.last_turn,
                head_hash=kd.head_hash,
            )
            
            append_audit(audit_log_path, {
                "ts": session_ts,
                "case_id": case_id,
                "event": "kernel_commit_attempt",
                "epoch": attempt.epoch,
                "turn": attempt.turn,
                "action_hash": action_hash,
                "kernel_decision": {
                    "outcome": kd.outcome.value,
                    "reason_code": kd.reason_code.value,
                },
            })
            
            if kd.outcome != KernelOutcome.COMMIT:
                decision = Decision(
                    verdict=Verdict.BLOCK,
                    blocking_predicates=[f"KERNEL_{kd.reason_code.value}"],
                    predicate_results=decision.predicate_results,
                )
        else:
            state = kernel.get_state()
            kernel_result = KernelResult(
                outcome="SKIPPED",
                reason_code="JQS_NOT_ALLOW",
                last_epoch=state["last_epoch"],
                last_turn=state["last_turn"],
                head_hash=state["head_hash"],
            )
    
    unsigned_output = {
        "schema_version": "jqs.output.v0.7",
        "case_id": case_id,
        "verdict": decision.verdict.value,
        "blocking_predicates": decision.blocking_predicates,
        "predicate_results": {k: v.value for k, v in decision.predicate_results.items()},
        "evidence_registry_root": evidence_registry.root_hash(),
        "diagnostics": diagnostics,
    }
    
    if kernel_result:
        unsigned_output["kernel"] = {
            "outcome": kernel_result.outcome,
            "reason_code": kernel_result.reason_code,
            "last_epoch": kernel_result.last_epoch,
            "last_turn": kernel_result.last_turn,
            "head_hash": kernel_result.head_hash,
        }
    
    receipt = sign_receipt(unsigned_output, signer_kid, signer_key)
    
    append_audit(audit_log_path, {
        "ts": session_ts,
        "case_id": case_id,
        "event": "final_decision",
        "verdict": decision.verdict.value,
        "blocking_predicates": decision.blocking_predicates,
    })
    
    return SessionResult(
        verdict=decision.verdict,
        blocking_predicates=decision.blocking_predicates,
        predicate_results=decision.predicate_results,
        diagnostics=diagnostics,
        unsigned_output=unsigned_output,
        receipt=receipt,
        kernel=kernel_result,
    )
