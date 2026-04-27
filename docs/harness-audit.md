# Harness Evolution Audit

## Purpose

Every harness component encodes an assumption about what the model can't do on its own.
As models improve, these assumptions go stale. This document tracks each component's
hypothesis and how to test it.

## Audit Schedule

Review after each major Claude model release or quarterly, whichever comes first.

## Component Inventory

### Sub-Agents

| Agent | Initial | Hypothesis | Why YELLOW (if applicable) | Verdict |
|-------|---------|-----------|----------------------------|---------|
| market-analyst | 🟡 | Without dedicated agent + 25-turn context window + structured `<market_assessment>` output, Opus 4.7 won't gather coherent multi-factor regime assessment in-context | Possible merge with technical-analyst into one `market-research` agent — both produce structured assessments using market-data MCP, separate context windows may be redundant for Opus 4.7 | TBD post-spot-check |
| technical-analyst | 🟡 | Without dedicated agent + TA framework + anti-Fibonacci/anti-Elliott guidance, Opus 4.7 will produce hand-wavy TA without specific levels | Same merge candidate as market-analyst — TA work is recipe-like and Opus 4.7 likely handles inline | TBD post-spot-check |
| risk-guardian | 🟢 | Without separated HARD GATE agent prompted "find reasons to reject", main agent will rationalize trades that violate drawdown/correlation/sizing limits | (canonical generator/evaluator separation pattern, well-supported by literature) | KEEP |
| trade-evaluator | 🟢 | Without separated SKEPTICAL agent prompted to find biases (FOMO/anchoring/recency/narrative fallacy), main agent's self-evaluation will skew positive | (canonical generator/evaluator separation pattern, well-supported by literature) | KEEP |

### Skills

| Skill | Initial | Hypothesis | Why YELLOW (if applicable) | Verdict |
|-------|---------|-----------|----------------------------|---------|
| investment-thesis | 🟢 | Without explicit Bull/Bear/Devil's Advocate/Pre-Mortem (Gary Klein) framework, Opus 4.7 will produce thesis but skip structured stress-testing | (specific cognitive interventions; pre-mortem in particular is not naturally produced by an optimistically-biased LLM) | KEEP |
| risk-assessment | 🟡 | Without explicit EV calculation + drawdown recovery math + two-method sizing requirement, Opus 4.7 will skip rigorous pre-trade math | Significant overlap with `position-sizing` (Kelly + conviction sizing) and `risk-guardian` agent (drawdown recovery, correlation rules). Also contains universe.awareness MCP guidance shoehorned in — different concern | TBD post-spot-check |
| trade-memory | 🟢 | Without explicit SQL templates + R-multiple framework + decision rules, Opus 4.7 won't proactively query the local SQLite trade journal | (the journal is invisible without prompting; without queries, the entire learning loop is broken) | KEEP |
| market-regime | 🟢 | Without composite scoring formula (Vol 30% + Trend 30% + Credit 20% + Macro 20%) and 4-tier classification table, Opus 4.7 will hand-wave regime classification | (specific quantitative framework with downstream sizing multipliers — 0.7x/0.5x/0.25x — that depend on regime classification) | KEEP |
| position-sizing | 🟡 | Without conviction-tier table + Kelly formula + fund-type adjustments + Piotroski F-Score gate, Opus 4.7 will size positions intuitively | Significant overlap with `risk-assessment` skill (also requires "two methods" sizing, conviction + Kelly). Could merge into one `sizing-and-risk-check` skill | TBD post-spot-check |
| session-reflection | 🟢 | Without structured end-of-session protocol (Decision Audit + Bias Check + Calibration + Journal + Objective + Contract Eval + Handoff Writing), Opus 4.7 won't reliably close the loop | (orchestrates entire Reflect phase of canonical Orient/Work/Reflect cycle; handoff format is load-bearing for next-session continuity) | KEEP |
| portfolio-review | 🟢 | Without explicit framework (Position-by-Position + Portfolio-Level + Survival Question + Barbell Assessment + Objective-Specific), Opus 4.7 won't conduct holistic portfolio reviews | (Survival Question and Barbell Assessment are specific cognitive interventions — Taleb-style; objective-specific review maps to fund taxonomy) | KEEP |
| opportunity-screening | 🟢 | Without explicit guidance on screener MCP (watchlist_query/trajectory/tag, screen_run vs screen_discover), Opus 4.7 won't use these tools effectively | (heavy on MCP tool usage guidance — without this skill, the screener MCP is opaque) | KEEP |

### Rules

| Rule | Hypothesis | Test Method | Last Tested | Verdict |
|------|-----------|-------------|-------------|---------|
| session-init | Without init sequence, agent skips state reading | Check file-read rate in first 5 turns | - | (out of scope for Phase 1b — rules are cheap, audit later) |
| session-completion | Without completion guard, agent ends prematurely | Check handoff quality with/without rule | - | (out of scope for Phase 1b) |
| state-consistency | Without schema enforcement, agent writes malformed state | Check state file validity with/without rule | - | (out of scope for Phase 1b) |
| decision-quality | Without hierarchy, agent ignores risk limits for thesis | Check decision ordering with/without rule | - | (out of scope for Phase 1b) |
| analysis-standards | Without standards, agent writes vague analysis | Compare specificity with/without rule | - | (out of scope for Phase 1b) |
| risk-discipline | Without discipline rule, agent widens stops | Check stop-loss adherence with/without rule | - | (out of scope for Phase 1b) |
| learning-loop | Without loop, agent doesn't query journal | Check journal query rate with/without rule | - | (out of scope for Phase 1b) |
| market-awareness | Without awareness, agent misses calendar events | Check event awareness with/without rule | - | (out of scope for Phase 1b) |
| communication | Without rule, agent mixes languages | Check language consistency with/without rule | - | (out of scope for Phase 1b) |
| self-scheduling | Without format spec, agent writes malformed pending sessions | Check pending session validity with/without rule | - | (out of scope for Phase 1b) |

## Pass 2 Targets (YELLOW components needing spot-check)

- [ ] `market-analyst` — possible merge with technical-analyst into `market-research`
- [ ] `technical-analyst` — possible merge with market-analyst
- [ ] `risk-assessment` — overlap with position-sizing + risk-guardian
- [ ] `position-sizing` — overlap with risk-assessment

**4 YELLOWs total.** Pass 2 budget estimate: ~$8-12 (4 × $2-3 per disable session). Cumulative after Pass 2 expected: ~$15-19. Within $40 cutoff and $50 hard cap.

## How to Run an Audit

1. Select component to test
2. Create a test fund with identical config
3. Run 5 paper-mode sessions WITH the component
4. Run 5 paper-mode sessions WITHOUT the component (remove skill/rule/agent)
5. Compare outputs on the relevant metric
6. Record results and verdict: **KEEP** / **SIMPLIFY** / **REMOVE**
7. If REMOVE: delete from `src/skills.ts` + run `fundx fund upgrade --all`

(Note: Phase 1b uses qualitative spot-check methodology — 1 baseline + 1 disabled session per YELLOW — instead of the 5+5 quantitative approach. See `docs/superpowers/specs/2026-04-27-harness-phase-1b-audit-design.md` Pass 2 methodology.)
