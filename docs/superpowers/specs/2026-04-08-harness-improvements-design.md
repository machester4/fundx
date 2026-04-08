# Harness Improvements for Long-Running Agent Sessions

**Date:** 2026-04-08  
**Status:** Draft  
**References:** [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents), [Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)

## Summary

Seven improvements to FundX's session harness, inspired by Anthropic's engineering research on long-running agent patterns. The changes improve session continuity, decision quality, and harness maintainability across autonomous (cron) and interactive (chat) sessions.

## Context

FundX sessions run autonomously via the daemon (pre-market, mid-session, post-market cron schedules) and interactively via chat. Each session is a fresh Claude Code invocation that reads the fund's CLAUDE.md, skills, rules, and state files.

### Current Gaps

| Gap | Current State | Target |
|-----|--------------|--------|
| **Handoff** | `session_log.json` = metadata only (500-char summary, cost, tokens) | Rich structured handoff with context, concerns, deferred decisions |
| **Init verification** | Generic prompt: "Start by reading your state files" | Mandatory sequenced init with state verification |
| **Self-evaluation bias** | Risk-guardian validates constraints but is invoked by the same agent proposing trades | Separate skepticism-tuned evaluator agent |
| **No session intent** | Sessions do whatever seems appropriate | Explicit contract at start, evaluation against it at end |
| **Premature completion** | Nothing prevents declaring "done" without verification | Completion checklist rule |
| **Harness never audited** | 7 skills + 7 rules assumed necessary | Periodic audit framework |
| **Ephemeral sub-agent output** | Analyst results via Task tool text, lost between sessions | Persistent analysis files in `analysis/` |

---

## 1. Session Handoff File

### What

A structured markdown file (`state/session-handoff.md`) that every session reads at the start and writes at the end, creating a continuous context chain across all session types.

### Format

```markdown
# Session Handoff — {date} {session_type}

## Session Contract
> Orient complete. Portfolio: $X cash, Y positions, Z% toward objective.
> Last session: [type] on [date], status [ok/error].
> This session intent: [what I plan to do and why].

## What I Did
- [Concrete actions taken, decisions made, trades executed]

## Open Concerns
- [Issues identified but not resolved]

## Deferred Decisions
- [Decisions postponed with reasoning and timeline]

## Next Session Should
- [Specific priorities for the next session]

## Market Context Snapshot
- Regime: [classification + score]
- VIX: [level]
- Key events next 48h: [calendar items]
```

### Two-Phase Write (Incremental Handoff)

To handle interrupted sessions (user closes terminal, timeout):

1. **Phase 1 — After Orient**: Write a minimal handoff with the Session Contract section only. This guarantees the next session has *something* even if the current session is interrupted.
2. **Phase 2 — After Reflection**: Overwrite with the full handoff including all sections.

### Continuity Chain

```
pre-market (cron) → writes handoff
    ↓
chat (interactive) → reads pre-market handoff, writes updated handoff
    ↓
post-market (cron) → reads chat handoff, writes handoff
    ↓
next pre-market → reads post-market handoff
```

Every session type (cron scheduled, cron pending, cron catch-up, interactive chat) participates in the chain.

### Graceful Degradation

The `session-init` rule handles edge cases:
- **Stale handoff** (>24h old): Read it but note staleness; proceed with fresh state file reads
- **Missing handoff**: First session after fund creation or after file corruption; proceed without it
- **Interrupted handoff** (contract-only, no reflection): Previous session was cut short; note this and check state files carefully

### Implementation

- Add `readSessionHandoff(fundName)` and `writeSessionHandoff(fundName, content)` to `state.ts` (plain text read/write, not JSON)
- Path: `fundPaths(fundName).sessionHandoff` → `state/session-handoff.md` in `paths.ts`
- Session Reflection skill extended to generate handoff content and write it
- Session Init rule reads it as step 1

---

## 2. Session Initialization Protocol

### What

A new fund rule (`session-init.md`) that formalizes the mandatory init sequence with state verification, replacing the generic prompt instruction.

### Rule Content

```markdown
# Session Initialization — Mandatory Sequence

Before ANY analysis or action, complete these steps IN ORDER:

1. **Read handoff** — Read `state/session-handoff.md`. Understand what the last session did,
   what it deferred, and what it recommended for this session. If missing or stale (>24h),
   note this and proceed — you'll rely more heavily on state files.

2. **Read state** — Read `state/portfolio.json` and `state/objective_tracker.json`.
   Know current positions, cash, total value, and objective progress.

3. **Read session log** — Read `state/session_log.json`. Check last session status, cost,
   timing. If the last session errored, investigate why before proceeding.

4. **Check pending** — Read `state/pending_sessions.json`. Was this session self-scheduled?
   If so, the reason is in the pending entry — address it.

5. **Verify state integrity** — Portfolio cash + sum(position market_values) should
   approximate total_value (within 2%). If not, investigate before trading.

6. **Write Session Contract** — Write a minimal handoff to `state/session-handoff.md` with
   your session contract:

   > Orient complete. Portfolio: $[cash] cash, [N] positions, [X]% toward objective.
   > Last session: [type] on [date], status [ok/error].
   > This session intent: [what you plan to do and why].

   This serves two purposes: confirms you completed Orient, and ensures the next session
   has context even if this session is interrupted.

Only after completing all 6 steps, proceed with analysis.

### Session-Type Priorities

After Orient, prioritize based on session type:

- **pre-market**: Overnight developments, regime check, plan today's actions, set alerts
- **mid-session**: Verify morning thesis still valid, check price levels, execute if triggers hit
- **post-market**: Close-of-day review, full reflection, comprehensive handoff for tomorrow
- **catch-up**: Understand what was missed, compressed analysis, flag anything urgent
- **pending (self-scheduled)**: Address the specific reason this session was scheduled
- **chat (interactive)**: Read handoff for context, then respond to user's needs
```

### Prompt Simplification

The session prompt in `session.service.ts` is simplified from 12 lines of instructions to:

```typescript
const prompt = [
  `You are running a ${sessionType} session for fund '${fundName}'.`,
  `Focus: ${focus}`,
  ``,
  `Follow your session-init rule to orient yourself, then proceed.`,
  `Write analysis to analysis/${today}_${sessionType}.md.`,
].join("\n");
```

Detail lives in the rule (loaded by Agent SDK), not in the prompt.

### Template Change

The 8-step Session Protocol in `template.ts` step 1 (Orient) simplifies to:
```
1. **Orient** — Follow the `session-init` rule in `.claude/rules/`. Complete all 6 steps
   and write your Session Contract before proceeding.
```

Steps 2-8 remain unchanged.

---

## 3. Trade Evaluator Agent

### What

A 4th sub-agent (`trade-evaluator`) that reviews proposed trade decisions with a skepticism-tuned prompt. Invoked AFTER the main agent forms a thesis but BEFORE risk-guardian validates constraints.

### Difference from Risk-Guardian

| Aspect | risk-guardian | trade-evaluator |
|--------|--------------|-----------------|
| **Focus** | Numeric constraint validation | Qualitative decision quality |
| **Checks** | Position size, concentration, drawdown budget, liquidity | Thesis strength, bias detection, timing rationale, journal consultation |
| **Stance** | Neutral (pass/fail checklist) | Skeptical by default |
| **Output** | APPROVED / REJECTED | SCORE (1-5) + CONCERNS list |
| **When** | After evaluator, before execution | After thesis formation, before risk-guardian |

### Agent Definition

```typescript
{
  name: "trade-evaluator",
  description: "Skeptical reviewer of proposed trades. Evaluates thesis quality, checks for cognitive biases, and validates timing rationale. Invoke after forming a trade thesis but before risk-guardian.",
  model: "sonnet",
  tools: ["Read", "Bash", "Grep", "Glob"],
  mcpServers: ["market-data"],
  maxTurns: 15,
}
```

### Prompt Design (Skepticism-Tuned)

Key elements drawn from Article 2's finding that Claude is a poor QA agent out-of-the-box:

```
Your default stance is skeptical. Your job is to find reasons NOT to do this trade.

You receive a proposed trade with its thesis. Evaluate:

1. **Thesis Strength** (1-5): Is the thesis specific and falsifiable? Does it have a clear
   invalidation trigger? Is the evidence from this session's data, not assumed?

2. **Bias Check**: Does the proposal show signs of:
   - Confirmation bias (only supporting evidence cited)
   - FOMO (chasing a move after missing entry)
   - Anchoring (fixated on a past price)
   - Recency bias (overweighting today's move)

3. **Journal Consultation**: Was the trade journal queried for similar setups?
   If so, what was the historical hit rate? If not, this is a concern.

4. **Timing Rationale**: Why now? Is there a catalyst within the thesis timeframe?
   Are there upcoming events (FOMC, earnings, CPI) that could invalidate?

5. **Contrarian Test**: What is the consensus view, and has the thesis accounted
   for why consensus might be right?

Output format:
<trade_evaluation>
SCORE: [1-5]
THESIS_STRENGTH: [1-5 with one-line justification]
BIAS_FLAGS: [list or "none detected"]
JOURNAL_CHECK: [consulted/not consulted + historical context]
TIMING: [justified/questionable + reasoning]
CONCERNS: [numbered list]
RECOMMENDATION: [PROCEED / RECONSIDER / REJECT]
</trade_evaluation>

Rules:
- Score below 3 = RECONSIDER. Score below 2 = REJECT.
- If you identify an issue but feel inclined to approve anyway, that inclination is wrong.
  State the concern clearly.
- "The thesis sounds compelling" is not a valid reason to override concerns.
- If the journal was not consulted, that alone warrants RECONSIDER.
```

### Protocol Change

Session Protocol step 4 (Validate) in `template.ts` becomes a two-gate process:

```
4. **Validate** — Two gates before execution:
   a. Invoke trade-evaluator via Task tool. Address any CONCERNS raised.
      If REJECT, do not proceed. If RECONSIDER, strengthen thesis or abandon.
   b. Invoke risk-guardian via Task tool. If REJECTED, do not execute (hard gate).
```

---

## 4. Session Contracts

### What

At the start of each session, the agent declares its intent (what it plans to do and why). At the end, it evaluates against that intent. This is the "sprint contract" pattern from Article 2.

### Implementation

Session Contracts are integrated into two existing mechanisms — no new files or skills needed:

**Start (via Session Init rule, step 6):**
The agent writes its contract as part of the minimal handoff in `state/session-handoff.md`:
```
> Orient complete. Portfolio: $48,200 cash, 3 positions, 67% toward objective.
> Last session: pre-market on 2026-04-08, status success.
> This session intent: Review AAPL position approaching stop-loss, check FOMC
> outcome impact on regime, consider adding GLD hedge if regime stays Risk-Off.
```

**End (via Session Reflection skill extension):**
New section added to the Session Reflection skill output:

```markdown
### Contract Evaluation
- **Stated intent**: [copy from session start]
- **Actual outcome**: [what actually happened]
- **Deviation**: [if any, describe]
- **Was the deviation justified?**: [yes/no + reasoning]
```

This evaluation becomes part of the full handoff written in Phase 2.

---

## 5. Anti-Premature-Completion Guard

### What

A new fund rule (`session-completion.md`) that prevents the agent from ending a session without verifying that work is actually complete.

### Rule Content

```markdown
# Session Completion — Verification Required

Before ending any session, verify ALL of the following:

1. **Data-backed claims**: Every recommendation or assessment made this session has
   supporting data retrieved from a tool call THIS session. No claims from memory or
   prior sessions without fresh verification.

2. **Trade integrity**: If trades were executed, verify:
   - `portfolio.json` reflects the trades (read it back)
   - Trade journal entry exists with thesis, stop-loss, and R-value
   - Telegram notification was sent

3. **Analysis quality**: If analysis was written to `analysis/`, verify it contains
   specific numbers, dates, and sources. Flag and fix any vague language.

4. **Handoff written**: `state/session-handoff.md` has been updated with the full
   handoff (not just the contract from Orient).

5. **Reflection completed**: Session Reflection skill has been run. Even "nothing
   happened" sessions require reflection on why inaction was chosen and whether
   it was correct.

6. **Objective tracker current**: `state/objective_tracker.json` reflects current
   portfolio value and progress.

7. **Contract evaluated**: The Session Contract from Orient has been compared against
   actual outcomes in the reflection.

If any check fails, address it before ending. Do not skip checks because "the session
is running low on turns" — an incomplete handoff costs more than an extra turn.
```

---

## 6. Harness Evolution Audit Framework

### What

A document and process for periodically evaluating which harness components (skills, rules, sub-agents) are still load-bearing. Not a code change — a maintainability practice.

### Document: `docs/harness-audit.md`

```markdown
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

## How to Run an Audit

1. Select component to test
2. Create a test fund with identical config
3. Run 5 paper-mode sessions WITH the component
4. Run 5 paper-mode sessions WITHOUT the component (remove skill/rule/agent)
5. Compare outputs on the relevant metric
6. Record results and verdict: KEEP / SIMPLIFY / REMOVE
7. If REMOVE: delete from `src/skills.ts` + run `fundx fund upgrade --all`
```

---

## 7. Persistent Analysis Files

### What

Sub-agents write their analysis to persistent files in `analysis/` instead of only returning ephemeral text via the Task tool. This creates an audit trail and enables reuse across sessions.

### File Naming Convention

```
analysis/
├── 2026-04-08_pre-market.md              # Main session analysis (already exists)
├── 2026-04-08_market-assessment.md        # market-analyst output
├── 2026-04-08_technical-AAPL.md           # technical-analyst output (per-ticker)
├── 2026-04-08_trade-evaluation-AAPL.md    # trade-evaluator output (per-trade)
└── 2026-04-08_risk-validation-AAPL.md     # risk-guardian output (per-trade)
```

### Sub-Agent Prompt Addition

Each sub-agent's prompt in `subagent.ts` gets an additional instruction:

```
After completing your analysis, write the full assessment to a file in the fund's
analysis/ directory using the Write tool:
- market-analyst → analysis/{today}_market-assessment.md
- technical-analyst → analysis/{today}_technical-{TICKER}.md
- trade-evaluator → analysis/{today}_trade-evaluation-{TICKER}.md
- risk-guardian → analysis/{today}_risk-validation-{TICKER}.md

The file content should be your complete structured output, not a summary.
```

### Session Init Reuse

The `session-init` rule includes guidance for reusing recent analysis:

```
After Orient, before launching sub-agents, check analysis/ for assessments from
the last 4 hours. If a market-assessment exists from today's pre-market session
and conditions haven't changed materially, you may reference it instead of
re-running the market-analyst. This saves turns and cost.

Reuse criteria: same trading day, no major news since assessment, regime hasn't shifted.
```

### Cleanup

Analysis files older than 30 days can be archived or deleted. The daemon's existing daily cleanup cron (00:00) is extended to prune old analysis files.

---

## Files to Create or Modify

### New Files
| File | Purpose |
|------|---------|
| `state/session-handoff.md` (per fund, runtime) | Session handoff content |
| `.claude/rules/session-init.md` (per fund) | Init protocol rule |
| `.claude/rules/session-completion.md` (per fund) | Completion guard rule |
| `docs/harness-audit.md` | Audit framework document |

### Modified Files
| File | Changes |
|------|---------|
| `src/paths.ts` | Add `sessionHandoff` path |
| `src/state.ts` | Add `readSessionHandoff()`, `writeSessionHandoff()` |
| `src/skills.ts` | Add `session-init` and `session-completion` to `FUND_RULES`; extend `session-reflection` skill with contract evaluation + handoff generation |
| `src/subagent.ts` | Add `trade-evaluator` agent; add file-write instructions to all agents |
| `src/template.ts` | Simplify Orient step, update Validate step for two-gate process |
| `src/services/session.service.ts` | Simplify session prompt |
| `src/services/daemon.service.ts` | Add analysis file cleanup to daily cron |
| `src/types.ts` | No schema changes needed (handoff is plain markdown, not JSON) |

### Propagation
After implementation, run `fundx fund upgrade --all` to propagate new skills/rules to existing funds.
