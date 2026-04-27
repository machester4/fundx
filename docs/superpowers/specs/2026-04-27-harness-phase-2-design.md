# Phase 2 — Gate Hooks (G1 + G3)

**Date:** 2026-04-27
**Status:** Stub (full design pending — brainstorm after Phase 1b closes)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Closes gaps:** G1 — evaluator verdicts not binding; G3 — Orient not verified
**Patterns enforced:** #2 (Orient → Work → Reflect cycle), #4 (hard circuit breakers via hooks)

---

## Stub-level scope

Implement `PreToolUse` hooks (Claude Agent SDK) on mutating tools of `mcp__broker-local`, minimally `place_order`, possibly also `update_universe`.

The hook denies the call when:

1. **(G3)** The session has not read `state/session-handoff.md` AND `state/portfolio.json` so far. Verification reads the SDK's transcript history for evidence — successful tool calls, file reads, or returns from a state-providing MCP that subsumes them.

2. **(G1)** No recent APPROVED verdict from the evaluator (or its post-1b successor) is present in transcript for the same `ticker + side + size`, within a freshness window (initial guess: last 10 turns of the main agent).

A simpler alternative to consider during the brainstorm: **pre-populate the first user message with handoff + portfolio snapshot already loaded by the harness**, eliminating G3 without needing a hook. This is what Anthropic's *Effective Harnesses* paper does in its "initializer" phase.

---

## Critical dependencies on Phase 1b

- If `trade-evaluator` is REMOVED: G1 is re-scoped — gate by what signal?
- If `risk-guardian` is KEPT but merged with `trade-evaluator`: the verdict-source for the hook changes.
- If `session-reflection` is SIMPLIFIED: pre-population may also simplify what the G3 check verifies.

These are the decisions that block detailed brainstorming and writing of this spec.

---

## Open questions for the future brainstorming session

- **Hook implementation surface** — does the Agent SDK TypeScript expose `PreToolUse` hooks today in the same shape the Python SDK does? Confirm before committing.
- **Freshness window units** — turns of the main agent, wall-clock minutes, or both?
- **Verdict matching granularity** — exact ticker / side / size, or fuzzy (ticker only, with size cap)?
- **Pre-population alternative** — adopt instead of, or in addition to, the hook? Belt-and-suspenders, or one or the other?
- **Behaviour on hook denial** — is the rejection message visible to the agent (so it can react) or silent (so it can't talk its way around)?

---

## Provisional Definition of Done

- 1 paper session where the agent attempts `place_order` without having read the handoff → tool denied with a clear message.
- 1 paper session where a sub-agent emits REJECTED → main agent attempts the trade → denied.
- MVP eval suite passes.
- New eval cases in `tests/eval/cases/` for both denial scenarios.

---

## Provisional effort

2–3 days.
