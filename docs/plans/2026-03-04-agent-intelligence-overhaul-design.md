# Agent Intelligence Overhaul — Design Document

**Date:** 2026-03-04
**Goal:** Transform the FundX agent from generic/shallow into an institutional-grade hedge fund portfolio manager
**Approach:** Principles Over Procedures — shorter, principle-driven skills leveraging Claude's natural reasoning

## Problem Statement

The current agent exhibits four issues:
1. **Generic/shallow analysis** — reads like a blog post, not an institutional investor
2. **Poor decision quality** — doesn't adapt to market conditions, over-trades
3. **Doesn't learn/improve** — repeats mistakes, no evolution across sessions
4. **Robotic personality** — feels like a template, not a skilled fund manager

**Root causes identified:**
- Skills are overly prescriptive (200-400 lines of rigid step-by-step procedures) — constrains Claude's natural reasoning
- Sub-agents use Haiku model — insufficient for deep financial analysis
- Per-fund CLAUDE.md is generic — no investment philosophy, mental models, or quality standards
- Only 1 behavioral rule (state-consistency) — no guardrails for decision quality
- MCP server documentation bloats CLAUDE.md (~40 lines of tool docs Claude can discover via SDK)
- Template personalities are one-liners

## Design: Approach A — Principles Over Procedures

### 1. New Fund CLAUDE.md Template

**Changes:**
- Add "Mental Models" section (second-order thinking, base rates, asymmetric risk/reward, margin of safety, regime awareness)
- Add "Standards" section (specific numbers required, conviction levels, uncertainty quantification, historical references)
- Remove MCP server documentation (Claude discovers tools via SDK tool listing)
- Compress session protocol from 7 steps to 5
- Trading rules as principles, not procedures

**Template structure:**
```
# {fund_display_name}
## Identity — 2-3 sentences with personality and philosophy
## Objective — generated from objective type
## Mental Models — 5 frameworks for thinking
## Standards — institutional-grade quality bars
## Risk Constraints — from fund config
## Universe — allowed/forbidden assets
## Session Protocol — 5 principles
## State Files — file paths
## Trading Rules — 5 non-negotiable principles
```

### 2. Rewritten Trading Skills (7 skills, 80-150 lines each)

| # | New Skill | Replaces | Key Change |
|---|-----------|----------|------------|
| 1 | `investment-thesis` | `investment-debate` + `investment-brainstorming` | Merged: idea generation + stress-testing in one cognitive process. Principle-driven, not step-by-step. |
| 2 | `risk-assessment` | `risk-matrix` | Simplified to dimensions + hard constraints. Removed verbose scoring matrices. |
| 3 | `trade-memory` | `trade-memory` | Trimmed. Removed rigid SQL templates (Claude writes SQL). Kept decision rules. |
| 4 | `market-regime` | `market-regime` | Simplified to 4 regimes (Risk-On/Transition/Risk-Off/Crisis). Removed numerical scoring (-2 to +2). |
| 5 | `position-sizing` | `position-sizing` | Kept quantitative rigor. Removed verbose step numbering. ~90 lines. |
| 6 | `session-reflection` | `session-reflection` | Enhanced bias detection. More emphasis on actionable lessons vs mechanical grading. |
| 7 | `portfolio-review` | NEW (replaces brainstorming slot) | Holistic portfolio health check — thesis validation, concentration, correlation, rebalancing. |

**Design principles for all skills:**
- Describe *what good looks like*, not every micro-step
- Include quality standards ("X is weak; Y is actionable")
- Trust Claude to reason through the details
- Keep under 150 lines — Anthropic research shows concise instructions outperform verbose ones
- No rigid scoring matrices — use natural language conviction levels

### 3. Sub-Agent (Analyst) Upgrades

**Model change:** Haiku → Sonnet for all 5 analysts
**Max turns:** 15 → 20

**Prompt rewrites:**
- Add domain expertise expectations ("senior macro strategist", "senior technical analyst")
- Require specific data points — ban vague language in prompts
- Expand output format: beyond signal+confidence to include key drivers, risks, positioning implications
- Add quality examples showing good vs bad analysis

| Agent | New Role Description |
|-------|---------------------|
| `macro-analyst` | Senior macro strategist — monetary policy, economic cycle, cross-asset signals, geopolitical |
| `technical-analyst` | Senior technical analyst — trend structure, volume confirmation, key levels, momentum |
| `sentiment-analyst` | Senior sentiment analyst — positioning data, flow analysis, fear/greed extremes |
| `news-analyst` | Senior news analyst — catalyst identification, regulatory impact, event timeline |
| `risk-analyst` | Senior risk manager — concentration, correlation, tail risk, liquidity, stress testing |

### 4. New Behavioral Rules (5 new rules)

| Rule File | Purpose |
|-----------|---------|
| `decision-quality.md` | No trades without quantified expected value. No FOMO trades. No trades that ignore your own history. Every trade must have a written thesis and exit criteria. |
| `analysis-standards.md` | All analysis must include specific numbers, dates, and sources. No generic language ("market looks good"). Uncertainty must be quantified. |
| `risk-discipline.md` | Always set stops. Never average down without thesis update. Respect position limits absolutely. Cut losses at predetermined levels. Never risk more than you can afford to lose on the fund's objective timeline. |
| `learning-loop.md` | Reference past trades when making new decisions. Update conviction based on outcomes. Track prediction accuracy over time. Adapt strategy based on what's actually working. |
| `market-awareness.md` | Adjust aggressiveness to regime. Don't fight the trend. Respect correlation spikes during stress. Manage cash as a position. Reduce activity in uncertain environments. |

### 5. Template Personality Upgrades

Each built-in template personality expands from 1 sentence to 3-4 paragraphs of investment philosophy:

- **Runway:** Fiduciary with a deadline. Survival first, returns second. Default position is cash. Cost of missing opportunity < cost of drawdown.
- **Growth:** Conviction-driven alpha seeker. Concentrates in best ideas. Comfortable with volatility as the price of returns. Thinks in expected value.
- **Accumulation:** Patient accumulator. DCA + strategic opportunism. Loves volatility (buying opportunities). Thinks in average cost, not daily P&L.
- **Income:** Yield engineer. Builds reliable income streams. Trades defensively around core yield positions. Measures success in monthly cash flow.

## Implementation Scope

### Files to Modify
1. `src/skills.ts` — Rewrite all BUILTIN_SKILLS, add FUND_RULES
2. `src/template.ts` — Rewrite `buildClaudeMd()` function
3. `src/subagent.ts` — Rewrite all 5 analyst agents (model + prompts)
4. `src/services/templates.service.ts` — Upgrade template personalities
5. `tests/skills.test.ts` — Update tests for new skill names/structure

### Files Unchanged
- `src/agent.ts` — SDK configuration stays the same
- `src/services/chat.service.ts` — Context building stays the same
- `src/services/session.service.ts` — Session runner stays the same
- `src/paths.ts`, `src/state.ts`, `src/types.ts` — No structural changes

### Migration
- Existing funds need `fundx fund upgrade --all` to regenerate skills and rules
- The `upgrade` command already handles this via `ensureFundSkillFiles()` and `ensureFundRules()`
- Old skill directories (investment-debate, investment-brainstorming) need cleanup during upgrade

## Success Criteria
- Agent analysis reads like institutional research (specific numbers, cited sources, quantified uncertainty)
- Agent references past trades when making new decisions
- Agent adjusts behavior based on market regime
- Agent produces conviction-based decisions with clear exit criteria
- Agent catches its own biases in session reflections
- Skills < 150 lines each (current average: ~250)
