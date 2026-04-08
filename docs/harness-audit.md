# Harness Evolution Audit

## Purpose

Every harness component encodes an assumption about what the model can't do on its own.
As models improve, these assumptions go stale. This document tracks each component's
hypothesis and how to test it.

## Audit Schedule

Review after each major Claude model release or quarterly, whichever comes first.

## Component Inventory

### Sub-Agents

| Agent | Hypothesis | Test Method | Last Tested | Verdict |
|-------|-----------|-------------|-------------|---------|
| market-analyst | Main agent can't do thorough macro analysis in-context | Run 5 sessions without agent, compare macro coverage | - | - |
| technical-analyst | Main agent lacks systematic technical analysis | Run 5 sessions without agent, compare TA quality | - | - |
| risk-guardian | Main agent won't self-enforce hard risk limits | Run 5 sessions without gate, check for limit violations | - | - |
| trade-evaluator | Main agent has self-evaluation bias on trade quality | Run 5 sessions without evaluator, compare thesis quality | - | - |

### Skills

| Skill | Hypothesis | Test Method | Last Tested | Verdict |
|-------|-----------|-------------|-------------|---------|
| investment-thesis | Without structured thesis, agent makes poorly-reasoned trades | Compare thesis quality with/without skill | - | - |
| risk-assessment | Without EV calc + position sizing formula, agent sizes incorrectly | Check sizing accuracy with/without skill | - | - |
| trade-memory | Without journal lookup prompt, agent repeats past mistakes | Check journal query rate with/without skill | - | - |
| market-regime | Without regime framework, agent misclassifies conditions | Compare regime calls with/without skill | - | - |
| position-sizing | Without formula, agent over/under-sizes | Compare sizing to Kelly with/without skill | - | - |
| session-reflection | Without reflection prompt, agent skips end-of-session review | Check reflection rate with/without skill | - | - |
| portfolio-review | Without review framework, agent misses portfolio-level risks | Compare review depth with/without skill | - | - |

### Rules

| Rule | Hypothesis | Test Method | Last Tested | Verdict |
|------|-----------|-------------|-------------|---------|
| session-init | Without init sequence, agent skips state reading | Check file-read rate in first 5 turns | - | - |
| session-completion | Without completion guard, agent ends prematurely | Check handoff quality with/without rule | - | - |
| state-consistency | Without schema enforcement, agent writes malformed state | Check state file validity with/without rule | - | - |
| decision-quality | Without hierarchy, agent ignores risk limits for thesis | Check decision ordering with/without rule | - | - |
| analysis-standards | Without standards, agent writes vague analysis | Compare specificity with/without rule | - | - |
| risk-discipline | Without discipline rule, agent widens stops | Check stop-loss adherence with/without rule | - | - |
| learning-loop | Without loop, agent doesn't query journal | Check journal query rate with/without rule | - | - |
| market-awareness | Without awareness, agent misses calendar events | Check event awareness with/without rule | - | - |
| communication | Without rule, agent mixes languages | Check language consistency with/without rule | - | - |
| self-scheduling | Without format spec, agent writes malformed pending sessions | Check pending session validity with/without rule | - | - |

## How to Run an Audit

1. Select component to test
2. Create a test fund with identical config
3. Run 5 paper-mode sessions WITH the component
4. Run 5 paper-mode sessions WITHOUT the component (remove skill/rule/agent)
5. Compare outputs on the relevant metric
6. Record results and verdict: **KEEP** / **SIMPLIFY** / **REMOVE**
7. If REMOVE: delete from `src/skills.ts` + run `fundx fund upgrade --all`
