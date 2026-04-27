# Phase 3 — Context Quality + Eval Grader (G4 + G5)

**Date:** 2026-04-27
**Status:** Stub (full design pending — brainstorm after Phase 2 closes)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Closes gaps:** G4 — handoff has no size cap; G5 — eval grader is mechanism-based
**Patterns enforced:** #1 (structured handoff with size discipline), #12 (outcome-based evals)

---

## Stub-level scope — G4 (handoff size cap)

- Update `Session Reflection` skill to produce a handoff with a validated **JSON section** (`next_session_should[]`, `open_concerns[]`, `deferred_decisions[]`) plus a bounded free-form `notes_md` tail.
- If the head exceeds 8 KB: archive the full file to `state/handoffs/<iso-ts>.md` and rewrite the head as a summary that points back to the archive.
- Add a `Stop` hook (or equivalent verification step) that fails the session if no handoff was written. This mechanises part of the existing `session-completion` rule that today is rule-text only.

## Stub-level scope — G5 (LLM-as-judge eval grader)

- New module `src/services/eval/grader.ts`: invokes a separate Claude (Sonnet, distinct from the model under test) with a pre-defined rubric (1–5 on thesis clarity, data grounding, constraint compliance, etc.).
- Calibrate with 5–10 manually-scored few-shot examples. Technique: as in *Harness Design for Long-Running Apps* — *"calibrated the evaluator using few-shot examples with detailed score breakdowns."*
- `runner.ts` in `src/services/eval/` reports both `pass@k` (≥ 1 of K runs passes — capacity) and `pass^k` (all K runs pass — reliability). Currently it reports only the aggregate.
- Document in `tests/eval/README.md`.

---

## Dependencies on Phase 1b

- If sub-agents are simplified, the rubric needs to grade only the surviving signal sources.
- If `session-reflection` is simplified, the schema for the handoff JSON needs to align with the simplified skill.

---

## Open questions for the future brainstorming session

- **Rubric design** — start with which dimensions? Anthropic-style 1–5, or weighted multi-criteria?
- **Calibration corpus size** — 5 manual scorings sufficient, or push to 20?
- **Cost model for the judge** — Sonnet on every eval run is non-trivial cost. Is the judge invoked per case or per run?
- **Handoff archive retention** — keep all archived handoffs forever, or rotate after N days?

---

## Provisional Definition of Done

- Handoff > 8 KB rotates correctly; head stays < 8 KB.
- Session that ends without writing handoff → `Stop` hook fails it → status = `"incomplete_no_handoff"`.
- Grader produces a reproducible score (variance < 0.3 over 3 runs of the same input).
- Eval report shows both `pass@k` and `pass^k`.

---

## Provisional effort

3–4 days.
