# Juried Layer — Drop-in Module

Self-contained operating code for the IF quorum / juried decision system.
Copy this entire folder into your project, wire in your model call, and go.

---

## Files

| File | Purpose |
|------|---------|
| `types.ts` | Shared type stubs (PredicateStatus, STATUS_ALIASES, EvidenceRegistry, validateCitations) |
| `governor.ts` | Enforces full-artifact output — no bare INVALID/refusal allowed |
| `governor_research.ts` | Dedicated 5-section research synthesis path — never blocks |
| `triage.ts` | Juror selection + role flattening + continuation detection |
| `jury_policy.ts` | Verdict reduction, ANALYZE mode let-through, human-escalation stripping |
| `contract.ts` | Juror prompt builder, output normalization, citation enforcement |

---

## Dependency Map

```
types.ts           ← no deps
governor.ts        ← no deps
governor_research.ts ← no deps
triage.ts          ← no deps
jury_policy.ts     ← no deps
contract.ts        ← types.ts + governor.ts
```

All files are standalone TypeScript with no framework or HTTP dependencies.

---

## Quick Start

### 1. Plan mode (ANALYZE / STRICT) with Governor enforcement

```typescript
import { callPrimaryJurorEnforced } from "./contract";

// Inject your model call here (OpenAI, Anthropic, etc.)
async function myModelCall(prompt: string): Promise<string> {
  // e.g. openai.chat.completions.create(...)
  return "...";
}

const result = await callPrimaryJurorEnforced(userPrompt, myModelCall);
// result is always a 7-step continuable artifact — never a bare refusal
```

### 2. Research synthesis

```typescript
import { runResearchGovernor } from "./governor_research";

const text = await runResearchGovernor({
  topic: "AI oversight mechanisms in high-stakes planning",
  addDetail: "Focus on irreversible decisions and replay prevention.",
  mode: "ANALYZE",
  callModel: myModelCall,
});
// Returns 5-section artifact: Source List / Evidence Map / Synthesis Summary / Gaps / Confidence
```

### 3. Verdict reduction (multi-juror quorum)

```typescript
import { reduceVerdicts } from "./jury_policy";

const result = reduceVerdicts("ANALYZE", [
  { juror_id: "j1", role_tag: "DOMAIN",  verdict: "ALLOW", rationale: "..." },
  { juror_id: "j2", role_tag: "SAFETY",  verdict: "ALLOW", rationale: "..." },
  { juror_id: "j3", role_tag: "VALUE",   verdict: "ESCALATE", rationale: "..." },
], draftAnswerText);
// In ANALYZE mode, VALUE-class escalation is demoted to a non-blocking note
```

### 4. Juror prompt builder + citation enforcement

```typescript
import { buildJurorPrompt, processJurorResponse } from "./contract";
import { EvidenceRegistry } from "./types";

const prompt = buildJurorPrompt({ role: "general_reasoner", caseId, predicates, evidenceIndex });
const rawOutput = await myModelCall(prompt);

const registry: EvidenceRegistry = { "ev_abc123": { evidence_id: "ev_abc123", label: "Source X" } };
const { outputs, diagnostics } = processJurorResponse(rawOutput, predicates, registry);
// DISPROVEN without valid citations is automatically downgraded to UNKNOWN
```

---

## Key Design Principles

### Fail-closed
- Missing predicate → UNKNOWN (blocks)
- Malformed JSON → empty output
- DISPROVEN without valid citations → downgraded to UNKNOWN

### ANALYZE mode never blocks
- VALUE-class ESCALATE → demoted to NOTE
- "requires human decision" sentinel → stripped from output
- IMPOSSIBLE kernel status → downgraded to CONCLUDE
- Blocker-only answers → auto-retried with override prompt

### Governor layer
- Model output must be a full 7-step artifact (Action / Obligation / Dependency / Status per step)
- Bare INVALID or refusal-only output → repair attempt → deterministic fallback
- INVALID is only allowed as `Status: INVALID` inside a step, never as a bare line

### Role flattening
- All jurors receive the same system prompt (`UNIFORM_JUROR_SYSTEM_PROMPT`)
- Eliminates role-induced semantic drift across the quorum

### Continuation mode
- Detected by keywords: "continue without rewriting", "steps are ordered and binding", etc.
- Hard-overrides prompt to prevent reframing, new options, or step deletion
- Only Narrow / Suspend / add constraints are allowed
