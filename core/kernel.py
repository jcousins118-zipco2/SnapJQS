"""
SnapSpace Lite Kernel - Monotonic commit gate with replay prevention.

Enforces:
1. Monotonic (epoch, turn) - must strictly increase
2. Replay prevention - same action_hash cannot commit twice
3. Durable journal - hash-chained append-only log
"""

from __future__ import annotations
import os
import json
import hashlib
from dataclasses import dataclass, field, asdict
from typing import Dict, Any, Optional, List
from enum import Enum


class KernelOutcome(Enum):
    COMMIT = "COMMIT"
    DENY = "DENY"
    FREEZE = "FREEZE"


class ReasonCode(Enum):
    OK = "OK"
    ROLLBACK_OR_REPLAY_TURN = "ROLLBACK_OR_REPLAY_TURN"
    REPLAY_ACTION_HASH = "REPLAY_ACTION_HASH"
    FROZEN = "FROZEN"
    CORRUPT_STATE = "CORRUPT_STATE"


GENESIS_HASH = "0" * 64


@dataclass
class KernelState:
    last_epoch: int = -1
    last_turn: int = -1
    head_hash: str = GENESIS_HASH
    frozen: bool = False
    spent_hashes: List[str] = field(default_factory=list)


@dataclass
class KernelDecision:
    outcome: KernelOutcome
    reason_code: ReasonCode
    last_epoch: int
    last_turn: int
    head_hash: str


@dataclass
class Attempt:
    epoch: int
    turn: int


def canonical_json(obj: Any) -> str:
    """Deterministic JSON serialization."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def action_hash_of_obj(action: Dict[str, Any]) -> str:
    """Compute deterministic hash of an action object."""
    return sha256_hex(canonical_json(action).encode("utf-8"))


class SnapSpaceLiteKernel:
    """
    SnapSpace Lite commit kernel.
    
    - Ensures monotonic (epoch, turn)
    - Prevents replay of action_hash within spent_window
    - Maintains hash-chained journal for auditability
    """

    def __init__(self, state_dir: str = "snapspace_state", spent_window: int = 1024):
        self.state_dir = state_dir
        self.spent_window = spent_window
        self.state_file = os.path.join(state_dir, "kernel_state.json")
        self.journal_file = os.path.join(state_dir, "journal.jsonl")

        os.makedirs(state_dir, exist_ok=True)
        self.state = self._load_state()

    def _load_state(self) -> KernelState:
        if os.path.exists(self.state_file):
            try:
                with open(self.state_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                return KernelState(
                    last_epoch=data.get("last_epoch", -1),
                    last_turn=data.get("last_turn", -1),
                    head_hash=data.get("head_hash", GENESIS_HASH),
                    frozen=data.get("frozen", False),
                    spent_hashes=data.get("spent_hashes", []),
                )
            except (json.JSONDecodeError, IOError):
                return KernelState(frozen=True)
        return KernelState()

    def _save_state(self) -> None:
        with open(self.state_file, "w", encoding="utf-8") as f:
            json.dump({
                "last_epoch": self.state.last_epoch,
                "last_turn": self.state.last_turn,
                "head_hash": self.state.head_hash,
                "frozen": self.state.frozen,
                "spent_hashes": self.state.spent_hashes,
            }, f, indent=2)

    def _append_journal(self, entry: Dict[str, Any]) -> None:
        with open(self.journal_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")

    def get_state(self) -> Dict[str, Any]:
        return {
            "last_epoch": self.state.last_epoch,
            "last_turn": self.state.last_turn,
            "head_hash": self.state.head_hash,
            "frozen": self.state.frozen,
        }

    def commit(
        self,
        epoch: int,
        turn: int,
        action_hash: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> KernelDecision:
        """
        Attempt to commit an action.
        
        Returns COMMIT if:
        - (epoch, turn) > (last_epoch, last_turn)
        - action_hash not in spent window
        - kernel not frozen
        """
        if self.state.frozen:
            return KernelDecision(
                outcome=KernelOutcome.FREEZE,
                reason_code=ReasonCode.FROZEN,
                last_epoch=self.state.last_epoch,
                last_turn=self.state.last_turn,
                head_hash=self.state.head_hash,
            )

        if (epoch, turn) <= (self.state.last_epoch, self.state.last_turn):
            self._append_journal({
                "event": "DENY",
                "reason": "ROLLBACK_OR_REPLAY_TURN",
                "epoch": epoch,
                "turn": turn,
                "last_epoch": self.state.last_epoch,
                "last_turn": self.state.last_turn,
            })
            return KernelDecision(
                outcome=KernelOutcome.DENY,
                reason_code=ReasonCode.ROLLBACK_OR_REPLAY_TURN,
                last_epoch=self.state.last_epoch,
                last_turn=self.state.last_turn,
                head_hash=self.state.head_hash,
            )

        if action_hash in self.state.spent_hashes:
            self._append_journal({
                "event": "DENY",
                "reason": "REPLAY_ACTION_HASH",
                "action_hash": action_hash,
                "epoch": epoch,
                "turn": turn,
            })
            return KernelDecision(
                outcome=KernelOutcome.DENY,
                reason_code=ReasonCode.REPLAY_ACTION_HASH,
                last_epoch=self.state.last_epoch,
                last_turn=self.state.last_turn,
                head_hash=self.state.head_hash,
            )

        prev_hash = self.state.head_hash
        commit_payload = canonical_json({
            "prev": prev_hash,
            "epoch": epoch,
            "turn": turn,
            "action_hash": action_hash,
        })
        new_hash = sha256_hex(commit_payload.encode("utf-8"))

        self.state.last_epoch = epoch
        self.state.last_turn = turn
        self.state.head_hash = new_hash

        self.state.spent_hashes.append(action_hash)
        if len(self.state.spent_hashes) > self.spent_window:
            self.state.spent_hashes = self.state.spent_hashes[-self.spent_window:]

        self._save_state()

        journal_entry = {
            "event": "COMMIT",
            "epoch": epoch,
            "turn": turn,
            "action_hash": action_hash,
            "prev_hash": prev_hash,
            "new_hash": new_hash,
        }
        if context:
            journal_entry["context"] = context
        self._append_journal(journal_entry)

        return KernelDecision(
            outcome=KernelOutcome.COMMIT,
            reason_code=ReasonCode.OK,
            last_epoch=epoch,
            last_turn=turn,
            head_hash=new_hash,
        )

    def freeze(self, reason: str = "manual") -> None:
        """Freeze the kernel - no more commits allowed."""
        self.state.frozen = True
        self._save_state()
        self._append_journal({"event": "FREEZE", "reason": reason})
