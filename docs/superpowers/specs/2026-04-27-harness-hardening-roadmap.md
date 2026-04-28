# FundX Harness Hardening — Roadmap

**Date:** 2026-04-27
**Status:** Approved (brainstorming)
**Owner:** michael
**Brainstorming session:** 2026-04-27 — analysis of harness gaps against canonical literature

---

## Vision

A simple, mechanically-verifiable Claude Agent SDK harness for the long-running autonomous trading sessions FundX runs on cron, grounded in published best-practice literature.

The guiding principle is the most-quoted passage in the harness literature, from Anthropic's *Harness Design for Long-Running Apps*:

> Every component in a harness encodes an assumption about what the model can't do on its own, and those assumptions are worth stress testing.

Every change in this roadmap either:
1. **Adds** a missing canonical pattern (deterministic gates, execution budgets, structured handoff with size cap, outcome-based eval grader), or
2. **Stress-tests existing scaffolding** for obsolescence in Opus 4.7 (the audit phase).

The end state is **not a more elaborate harness** — it is a leaner one with deterministic gates where the literature requires them, and removed scaffolding where the current model makes it redundant.

---

## Reference framework — the 12 canonical patterns

Synthesised from Anthropic (*Effective Harnesses for Long-Running Agents*, *Harness Design for Long-Running Apps*, *Building Effective Agents*, *Effective Context Engineering for AI Agents*), Slack Engineering, Augment Code, Lance Martin (Jan 2026), Blake Link.

| # | Pattern | What it does | Failure mode it prevents | FundX state | Phase that addresses it |
|---|---|---|---|---|---|
| 1 | Structured handoff artifact | Versioned file with task, status, decisions, "what's next" — read at orient, written at reflect. | Cold-start rediscovery; context loss across sessions. | ✅ `state/session-handoff.md` produced by `Session Reflection` skill, consumed by `session-init` rule. | Already in place; size cap added in Phase 3 (G4). |
| 2 | Orient → Work → Reflect cycle | Mandatory first action: re-establish state from durable artifacts. Last action: persist updated state. | Stateless drift; agents acting on stale assumptions. | ⚠️ Defined in `session-init.md` rule but not enforced in code. | Phase 2 (G3) — verification hook + pre-population. |
| 3 | Generator / Evaluator separation | A second agent (different prompt, often different tools) judges output. | Self-grading bias — *"agents reliably skew positive when grading their own work."* | ⚠️ Logically yes (`risk-guardian`, `trade-evaluator` in `src/subagent.ts`); verdicts are advisory text, not binding. | Phase 1b (audit if still load-bearing) → Phase 2 (G1) — binding hook if KEEP. |
| 4 | Hard circuit breakers via hooks | Out-of-band code denies dangerous operations regardless of model reasoning. | LLM-level safety bypass via prompt injection or hallucinated justification. | ❌ No `PreToolUse`/`PostToolUse`/`Stop` hooks defined. | Phase 2 (G1+G3); Phase 3 (G4 — `Stop` hook for handoff). |
| 5 | Sub-agent context isolation | Sub-agent runs in clean window, returns 1–2k token summary. | Main-agent context pollution; conflation of concerns. | ✅ `Task` tool with `agents: {…}` definitions. | Already in place; audited in Phase 1b. |
| 6 | Long, atomic feature/task list as single source of truth | Hundreds of discrete items with boolean state — JSON, not Markdown. | Premature completion; "we're done" hallucination. | ⚠️ `objective_tracker.json` and `pending_sessions.json` cover this for FundX's domain. | N/A — investing is naturally state-shaped, not list-shaped. |
| 7 | Sprint contract / pre-commit plan | Generator proposes work + verification criteria; evaluator approves before code is written. | Cascading mis-alignment; under- or over-scoped sprints. | ✅ "Session Contract" written in handoff during Orient, evaluated in `session-completion` rule. | Already in place. |
| 8 | Just-in-time retrieval over upfront stuffing | Hold paths/IDs; load via tool when needed. | Context rot; stale indexes; attention dilution. | ✅ MCPs (`broker-local`, `market-data`, `screener`, `sws`) are JIT by design. | Already in place. |
| 9 | Execution budgets enforced by the harness | Token, turn, and dollar caps live in code, not the prompt. | Runaway loops; cost incidents. | ❌ Sub-agents have `maxTurns` (15–25); top-level `runFundSession` has none. | **Phase 1a (G2).** |
| 10 | Tool design as a first-class craft (ACI / poka-yoke) | Few non-overlapping tools, descriptive params, formats close to training data, structurally impossible to misuse. | Tool-selection ambiguity; format-related self-corrections. | ✅ MCPs are well designed and non-overlapping. ⚠️ One known issue (zvec single-writer) is already mitigated via IPC. | Already in place. |
| 11 | File-driven prompting (CLAUDE.md + skills/ + rules/) | Instructions live in versioned files auto-loaded by the harness, not hardcoded strings. | Skill drift between code and runtime. | ✅ Exemplary — `src/skills.ts` is the single source of truth, written via `ensureFundSkillFiles` / `ensureFundRules`, loaded with `settingSources: ["project"]`. | Already in place. |
| 12 | Outcome-based evals with K-runs and isolated fixtures | Assert on results, not paths. K runs per case for `pass^k`. Each run gets a clean seeded environment. | Brittle mechanism assertions; flaky shared state; over-claiming reliability from a single lucky run. | ⚠️ K-runs and fixtures yes (`tests/eval/`, `runner.ts`); outcome-based assertions mostly missing — current asserts are mechanism-based (`must_invoke`, `must_not_invoke`, `max_turns`). | **Phase 3 (G5)** — LLM-as-judge grader + report `pass@k` and `pass^k`. |

**Score:** 6 ✅ + 5 ⚠️ + 1 ❌ + 1 N/A. Above-average baseline for an autonomous-agent harness. The 7 gaps below are what this roadmap closes.

---

## Gap inventory

| Gap | Severity | Pattern violated | Phase |
|---|---|---|---|
| **G1** — Evaluator verdicts are advisory, not binding | High | #3, #4 | Phase 2 |
| **G2** — No execution budgets in production sessions | High | #9 | **Phase 1a** |
| **G3** — Orient is rule-text, not verified | Medium | #2, #4 | Phase 2 |
| **G4** — Handoff has no size cap | Medium-low | #1 + context engineering | Phase 3 |
| **G5** — Eval grader is mechanism-based, not outcome | Medium | #12 | Phase 3 |
| **G6** — No external supervisor / no daily-fund cap | Medium | operational | Phase 4 |
| **G7** — Existing scaffolding not stress-tested for Opus 4.7 | Medium | meta-pattern | **Phase 1b** |

---

## Phase plan

### Dependency graph

```
Phase 1a — Budgets (G2) ──┐
                          ├──▶ Phase 2 — Hooks (G1+G3) ──┐
Phase 1b — Audit (G7) ────┴──▶ Phase 3 — Quality (G4+G5)─┴──▶ Phase 4 — Operations (G6)
```

- Phases 1a and 1b are **independent** — parallelisable if capacity allows.
- Phases 2 and 3 both depend on 1b.
- Phase 4 sits on top of everything.

### Per-phase summary

| Phase | Gaps | Spec | Effort |
|---|---|---|---:|
| 1a — Execution budgets (v1: hard-kill only) | G2 | [phase-1a](./2026-04-27-harness-phase-1a-budgets-design.md) | 0.5–1 day |
| 1b — Qualitative audit | G7 | [phase-1b](./2026-04-27-harness-phase-1b-audit-design.md) | 2.5–4 days |
| 2 — Gate hooks | G1, G3 | [phase-2 (stub)](./2026-04-27-harness-phase-2-design.md) | 2–3 days |
| 3 — Context quality + eval grader | G4, G5 | [phase-3 (stub)](./2026-04-27-harness-phase-3-design.md) | 3–4 days |
| 4 — Operational observability | G6 | [phase-4 (stub)](./2026-04-27-harness-phase-4-design.md) | 2–3 days |
| 1c — 75 % soft warning (deferred from 1a) | (subset of G2) | TBD — brainstorm post-1b audit | 1.5–3 days |
| **Total** | 7 gaps | 5 specs + 1 deferred | **11.5–18 days** |

---

## Order rationale

The order is **hybrid** (build the universal-value items first; audit before hardening anything dependent on existing scaffolding):

- **1a before everything else** because budgets are universally valuable. They protect against cost incidents during the rest of the work — including 1b's experiments where a misbehaving session must not be able to blow up cost.
- **1b before 2 and 3** because hardening hooks against an evaluator we might simplify or remove (e.g., merging `risk-guardian` and `trade-evaluator`) is wasted work. Same logic for the LLM-judge grader in Phase 3 — calibrating against components we'll soon change is throw-away calibration.
- **1a and 1b are independent** of each other and can be parallelised.
- **2 before 3** because gates (security) before quality (handoff hygiene + grader). A binding hook for evaluator verdicts (G1) materially improves the signal that Phase 3's grader will assess.
- **4 last** because operational observability sits on top of everything earlier.

---

## Definition of Done — per phase

| Phase | DoD highlights | Spec section with full criteria |
|---|---|---|
| 1a | Budgets resolved per session; warning at 75%; hard kill at 100%; logged in `session_log.json`; eval suite green. | phase-1a §"Definition of Done" |
| 1b | All 12 components have a verdict (KEEP / SIMPLIFY / REMOVE); REMOVE PRs merged; eval green; results doc lists Phase 2 dependencies. | phase-1b §"Definition of Done" |
| 2 | `place_order` denied without (a) Orient artifacts read this session, and (b) recent APPROVED verdict from evaluator. New eval cases for both denials. | phase-2 — TBD post-1b |
| 3 | Handoff > 8 KB rotates; `Stop` hook fails sessions with no handoff; LLM-judge produces reproducible scores; eval reports `pass@k` and `pass^k`. | phase-3 — TBD post-2 |
| 4 | Daemon-stale alert in < 5 min; daily fund cap enforced; `fundx status` shows live cost. | phase-4 — TBD post-3 |

---

## Per-phase workflow

Each phase follows the same loop:

1. **Brainstorm** the phase's spec to detail (already done for 1a and 1b; stubs for 2/3/4 will be brainstormed when their turn comes).
2. **Write plan** via `superpowers:writing-plans` skill — one plan per phase.
3. **Execute** plan, marking tasks done as they complete.
4. **Request code review** via `superpowers:requesting-code-review` skill on completion.
5. **Close the phase**: update this roadmap with status, archive plan to `docs/plans/`.
6. **Move to the next phase.**

---

## References

- [Effective Harnesses for Long-Running Agents — Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Harness Design for Long-Running Apps — Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Building Effective Agents — Anthropic](https://www.anthropic.com/engineering/building-effective-agents)
- [Effective Context Engineering for AI Agents — Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Demystifying Evals for AI Agents — Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Managing Context in Long-Run Agentic Applications — Slack Engineering](https://slack.engineering/managing-context-in-long-run-agentic-applications/)
- [Agent Design Patterns — Lance Martin (Jan 2026)](https://rlancemartin.github.io/2026/01/09/agent_design/)
- [Harness Engineering for AI Coding Agents — Augment Code](https://www.augmentcode.com/guides/harness-engineering-ai-coding-agents)
- [Session Handoff Protocol — Blake Link](https://blakelink.us/posts/session-handoff-protocol-solving-ai-agent-continuity-in-complex-projects/)
- Internal: [`docs/harness-audit.md`](../../harness-audit.md) — component-by-component audit (template today; populated in Phase 1b)
- Internal memory: `reference_harness_articles.md` — applied patterns

---

## Status log

| Date | Status |
|---|---|
| 2026-04-27 | Roadmap created. Specs 1a and 1b detailed. Specs 2 / 3 / 4 are stubs. Awaiting user review before invoking `writing-plans` for Phase 1a. |
| 2026-04-27 | Code-truth audit of `src/agent.ts` revealed the SDK already enforces `maxTurns` and `maxBudgetUsd` natively. Phase 1a scope reduced to v1 (hard-kill only, cascade resolver, log fields, distinguished Telegram alert). Effort dropped from 2–3 days to 0.5–1 day. The 75 % soft warning piece was extracted as **deferred Phase 1c** (needs streaming-input refactor of `runAgentQuery`; brainstorm after Phase 1b audit informs whether it's still needed). |
| 2026-04-27 | Phase 1a v1 complete: `resolveBudget` cascade + `buildBudgetAlert` formatter wired into `runFundSession`. MVP eval green. Smoke tests confirmed budget-kill and normal-completion paths. Commits: `a86b511`, `3b83fa9`, `0a3dcb8`, `0db8f8e`, `f524753`. |
| 2026-04-27 | Phase 1a v1 follow-ups: smoke test caught hyphen/underscore mismatch in `DEFAULTS_BY_SESSION_TYPE` (fixed in `d78dbcf`); CLAUDE.md documentation (`2dd3014`); roadmap log entry (`9b1b000`); final review minors (test consistency, log assertion) in this commit. |
| 2026-04-28 | Phase 1b complete: 9 KEEP, 1 SIMPLIFY (merged `market-analyst` + `technical-analyst` into `market-research` sub-agent — see commit `18fac01`), 1 REMOVE (risk-assessment) **deferred** with universe MCP guidance relocation requirement. Audit cost ~$27.97 against $50 cap. MVP eval 8/8 PASS post-merge. Audit branch merged in `54501c9`. Phase 2 scope unchanged (trade-evaluator + risk-guardian both KEEP). Phase 3 LLM-judge rubric to score `market-research` combined output instead of two separate analysts. See [audit-results spec](./2026-04-27-harness-phase-1b-audit-results.md). |
