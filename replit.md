# JQS (JSON Query Signature) / Quorum System

A full-stack implementation of a deterministic decision system with canonical JSON processing, HMAC-SHA256 receipt signing, evidence registry, and juror contract enforcement.

## Overview

This system implements a "fail-closed" epistemic kernel for evaluating predicates and producing cryptographically signed verdicts. Key principles:

- **Silence is not permission** - Missing predicates default to UNKNOWN/BLOCK
- **Hallucinated vetoes are downgraded** - DISPROVEN requires valid evidence citations
- **Decision is deterministic** - Given the same inputs, output is always identical

## Architecture

### Backend Modules (TypeScript)

| Module | File | Purpose |
|--------|------|---------|
| **Canonical JSON** | `server/canonical.ts` | Deterministic JSON serialization + SHA-256 hashing |
| **Signer** | `server/signer.ts` | HMAC-SHA256 receipt signing and verification |
| **Decision** | `server/decision.ts` | ALLOW/BLOCK/ESCALATE verdict computation |
| **Evidence** | `server/evidence.ts` | Content-addressed evidence registry |
| **Contract** | `server/contract.ts` | Juror prompt generation + output enforcement |
| **Orchestrator** | `server/orchestrator.ts` | Session coordination + receipt production |
| **Kernel** | `server/kernel.ts` | SnapSpace Lite commit kernel (monotonic turns + replay prevention) |
| **Jury Policy** | `server/jury_policy.ts` | ANALYZE mode let-through + weighted jury verdict reduction |
| **Triage** | `server/triage.ts` | Domain-based juror filtering |
| **Compiler** | `core/compiler.py` | Question compiler (human question → JQS frame) |

### API Endpoints

#### Canonical JSON
- `POST /api/canonicalize` - Canonicalize JSON + compute SHA-256 hash
- `GET /api/history` - Get canonicalization history

#### Signing
- `POST /api/sign` - Sign data with HMAC-SHA256
- `POST /api/verify` - Verify signature (fail-closed)

#### Decision
- `POST /api/decide` - Compute verdict from predicate results

#### Evidence Registry
- `POST /api/evidence` - Register evidence artifact
- `GET /api/evidence/:id` - Get evidence record
- `GET /api/evidence/:id/payload` - Get evidence payload (base64)
- `GET /api/evidence-index` - Get juror-safe manifest
- `POST /api/evidence/validate-citations` - Validate citation IDs

#### Juror Contract
- `POST /api/contract/build-prompt` - Build vendor-agnostic juror prompt
- `POST /api/contract/normalize` - Parse raw juror JSON output
- `POST /api/contract/process` - Normalize + enforce citation policy

#### Session Orchestrator
- `POST /api/session/run` - Run complete JQS session

## SnapSpace Lite Kernel

The kernel is a deterministic commit gate that enforces:

1. **Monotonic Turn Discipline** - (epoch, turn) must strictly increase
2. **Replay Prevention** - Same action_hash cannot commit twice (within window)
3. **Durable Journal** - Hash-chained append-only log for auditability

### Commit Flow

```
JQS Session → Verdict
     ↓
  ALLOW? ─── No ──→ BLOCK (no kernel attempt)
     │
    Yes
     ↓
  Kernel Commit
     ↓
  COMMIT? ── No ──→ BLOCK (kernel denied)
     │
    Yes
     ↓
  Final: ALLOW
```

### Kernel Decisions
- `COMMIT` - Action recorded, state advanced
- `DENY` - Refused (rollback/replay detected)
- `FREEZE` - Kernel frozen due to corruption

## Key Design Decisions

### Fail-Closed Behavior
- Unknown/malformed status → UNKNOWN
- Missing predicate → UNKNOWN (blocks)
- Invalid signature → always returns false
- Parse errors → empty/degraded output

### Asymmetric Trust Model
- **PROVEN** needs no justification ("proof is silent")
- **DISPROVEN** requires:
  - Non-empty `verdict_code`
  - At least 1 valid `cited_evidence_id` from registry
- Invalid DISPROVEN → downgraded to UNKNOWN

### Evidence IDs
- Content-addressed with `ev_` prefix
- First 20 chars of SHA-256 hash of manifest
- Deterministic and collision-resistant

### Status Normalization
```
PROVEN/TRUE/YES/PASS/OK → PROVEN
DISPROVEN/FALSE/NO/FAIL/VETO/REJECT → DISPROVEN
UNKNOWN/UNSURE/N/A/NA/IDK → UNKNOWN
ABSTAIN → ABSTAIN
```

### Verdict Rules
1. All required predicates PROVEN → ALLOW
2. Any required predicate DISPROVEN → BLOCK
3. Any required predicate UNKNOWN/ABSTAIN/missing → BLOCK
4. `forceEscalate: true` → ESCALATE

## CLI Tools

Both TypeScript and Python versions are available:

### Local Harness (Interactive Testing)
```bash
# TypeScript version
npx tsx tools/run-local.ts

# Python version (calls TypeScript API)
python3 tools/run_local.py
```

This creates evidence, generates a juror prompt, accepts manual juror input, runs the session, and produces a signed receipt. Output files are auto-written to `out/` (Python) or `output/` (TypeScript).

### Receipt Verifier (Independent Verification)
```bash
# TypeScript version
npx tsx tools/verify-receipt.ts unsigned.json receipt_sig.json keys.json

# Python version (standalone, no API needed)
python3 tools/verify_receipt.py unsigned.json receipt_sig.json keys.json
```

Example keys.json:
```json
{"jqs-k1": {"encoding": "utf8", "value": "dev-secret-change-me"}}
```

Exit codes: 0 = verified, 2 = failed/invalid

## Database

PostgreSQL is used for operation history tracking. The schema is defined in `shared/schema.ts`.

## Running the Application

The workflow `Start application` runs:
```bash
npm run dev
```

This starts the Express server with Vite for the frontend on port 5000.

## File Structure

```
server/
├── canonical.ts    # Deterministic JSON + SHA-256
├── signer.ts       # HMAC-SHA256 signing
├── decision.ts     # Verdict computation
├── evidence.ts     # Evidence registry
├── contract.ts     # Juror contract
├── orchestrator.ts # Session coordination
├── routes.ts       # API endpoints
└── storage.ts      # Database interface

shared/
├── schema.ts       # Type definitions
└── routes.ts       # API route definitions

tools/
└── run-local.ts    # CLI testing harness
```

## Security Notes

- Keys are transported as hex-encoded strings
- HMAC-SHA256 is used (symmetric, no PKI)
- Evidence payloads limited to 500KB
- Audit logs are append-only (best-effort)
