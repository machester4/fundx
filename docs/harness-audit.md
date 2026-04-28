# Harness Evolution Audit

## Purpose

Every harness component encodes an assumption about what the model can't do on its own.
As models improve, these assumptions go stale. This document tracks each component's
hypothesis and how to test it.

## Audit Schedule

Review after each major Claude model release or quarterly, whichever comes first.

## Phase 1b verdicts (2026-04-28, model: Opus 4.7)

Methodology: qualitative spot-check (1 baseline + 1 disabled session per YELLOW
component). See `docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-design.md`
for full methodology and `docs/superpowers/audit-1b/audit-log.md` for per-session
evidence with cost tracking.

Total spot-check cost: ~$25.41 (against $50 cap).

### Sub-Agents

| Agent | Initial | Verdict | Reason |
|-------|---------|---------|--------|
| market-analyst | 🟡 | **SIMPLIFY** | Merge with technical-analyst into single `market-research` agent. Disabled run: $4.05 vs baseline $4.39, agent inlined macro analysis using market-regime skill formula, ~80-85% quality. Unique value (Fed dot plot depth, breadth metrics) is marginal for routine sessions. |
| technical-analyst | 🟡 | **SIMPLIFY** | Merge with market-analyst. Disabled run revealed agent reuses prior technical artifacts in same-day repeat sessions; tech-analyst's marginal value concentrated in FIRST analysis cycle of a day. |
| risk-guardian | 🟢 | **KEEP** | Canonical generator/evaluator separation pattern (literature pattern #3). Hard-gate behavior + drawdown budget tiers + correlation rule are non-trivial structural framework. Not spot-checked (clearly load-bearing per Pass 1 reading). |
| trade-evaluator | 🟢 | **KEEP** | Canonical evaluator pattern. Skeptical bias-check (FOMO/anchoring/recency/narrative fallacy) caught real issues in spot-check #4 (GEV thesis: anti-hallucination violations + tail-risk vs stop-loss mismatch). Demonstrably load-bearing. |

### Skills

| Skill | Initial | Verdict | Reason |
|-------|---------|---------|--------|
| investment-thesis | 🟢 | **KEEP** | Pre-mortem (Gary Klein) + bull/bear/devil's-advocate stack are specific cognitive interventions. Pre-mortem in particular is not naturally produced by an optimistically-biased LLM. Not spot-checked. |
| risk-assessment | 🟡 | **REMOVE** (with relocation) | Disabled run: $4.53 vs $4.39 baseline. Agent fully reproduced EV+Kelly+conviction math INLINE because position-sizing skill (overlapping ~70%) was still enabled. Unique value: explicit EV calculation framework + universe MCP guidance (~30% of skill content). Removal requires relocating universe guidance to either (a) new `universe` skill, (b) opportunity-screening, or (c) per-fund CLAUDE.md template. |
| trade-memory | 🟢 | **KEEP** | Without explicit SQL templates + R-multiple framework, the `trade_journal.sqlite` is invisible to the agent. Removing breaks the entire learning loop. Not spot-checked. |
| market-regime | 🟢 | **KEEP** | Specific quantitative framework (Vol 30% + Trend 30% + Credit 20% + Macro 20% composite) with downstream sizing multipliers (0.7x/0.5x/0.25x). Not spot-checked but evidenced indirectly: spot-check #1 (market-analyst disabled) showed agent applied this formula correctly inline. |
| position-sizing | 🟡 | **KEEP** | Load-bearing. Disabled run: agent SKIPPED Kelly criterion, Piotroski F-Score, and two-method comparison entirely; proposed a position near max-cap without rigorous methodology. Cross-confirmed by spot-check #3 (risk-assessment disabled): agent did Kelly inline only because position-sizing was still enabled. The math lives here. |
| session-reflection | 🟢 | **KEEP** | Orchestrates entire Reflect phase of canonical Orient/Work/Reflect cycle. Handoff format is load-bearing for next-session continuity. The 10-bias table is detailed and unlikely to be replicated without prompting. Not spot-checked. |
| portfolio-review | 🟢 | **KEEP** | Survival Question and Barbell Assessment are specific Taleb-style cognitive interventions. Objective-specific review (runway/growth/income/accumulation) maps to fund taxonomy. Not spot-checked. |
| opportunity-screening | 🟢 | **KEEP** | Heavy on screener MCP tool usage guidance — without this skill, the screener MCP tools are opaque. Not spot-checked. |

### Rules

| Rule | Initial | Verdict |
|------|---------|---------|
| (all 10 rules) | (out of scope for Phase 1b) | (deferred — rules are cheap, audit opportunistically in future cycles) |

## Summary

- **9 KEEP**: 2 sub-agents (risk-guardian, trade-evaluator) + 7 skills (investment-thesis, trade-memory, market-regime, position-sizing, session-reflection, portfolio-review, opportunity-screening)
- **2 SIMPLIFY**: market-analyst + technical-analyst → merge into single `market-research` sub-agent
- **1 REMOVE**: risk-assessment (with mandatory relocation of universe MCP guidance)
- Total: 12 verdicts. 4 YELLOWs spot-checked. Audit cost: ~$25.41 (within $50 cap).

## Phase 2 implications

- The G1 hook (binding evaluator verdict) was planned to gate `place_order` on a recent APPROVED verdict from `trade-evaluator`. Trade-evaluator is KEEP, so the hook design stands.
- The risk-guardian verdict is also KEEP, so a parallel gate on its verdict (planned in Phase 2) is unaffected.
- The merge of market-analyst + technical-analyst into `market-research` does NOT affect the verdict-source pool for Phase 2 hooks (those are output-producing analysts, not verdict-issuing evaluators).
- **No Phase 2 scope changes required.**

## Phase 3 implications

- The LLM-as-judge eval grader (G5) needs to score outputs from the post-audit component set. Specifically:
  - The new `market-research` sub-agent's output format (TBD during merge work) must be the grader's target, not separate market-analyst + technical-analyst outputs.
  - Removed risk-assessment skill means the grader doesn't need to score "did the agent apply EV calculation" — it can score "did the agent apply two-method sizing (per position-sizing skill)" instead.
- **Phase 3 scope adjustment:** rubric design happens after audit changes are merged.

## How to Run an Audit (general process for future cycles)

1. Select component to test
2. Create a test fund with realistic seeded state
3. Capture a baseline session with full scaffolding
4. Disable the component (comment out in src/subagent.ts or src/skills.ts; for skills, run `fundx fund upgrade` to propagate to disk)
5. Run a session with the same focus as baseline
6. Compare side-by-side: what did the disabled run lose, change, or compensate for?
7. Verdict: **KEEP** / **SIMPLIFY** / **REMOVE**
8. If REMOVE/SIMPLIFY: apply the change, run eval suite, propagate via `fundx fund upgrade --all`
