import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_CLAUDE_DIR, WORKSPACE } from "./paths.js";

// ── Types ─────────────────────────────────────────────────────

export interface Skill {
  /** Human-readable name (e.g., "Investment Debate") */
  name: string;
  /** Directory name under .claude/skills/ (e.g., "investment-debate") */
  dirName: string;
  /** One-line description — Claude uses this to decide when to invoke the skill */
  description: string;
  /** SKILL.md body (without frontmatter) */
  content: string;
}

/** Build a complete SKILL.md with YAML frontmatter */
function buildSkillMd(skill: Skill): string {
  return `---
name: ${skill.dirName}
description: ${skill.description}
---

${skill.content.trim()}
`;
}

// ── Fund trading skills ────────────────────────────────────────

/**
 * Built-in fund skills — concise, principle-driven guides for autonomous trading.
 *
 * These go in each fund's .claude/skills/<dirName>/SKILL.md and are loaded
 * automatically by the Agent SDK via settingSources: ["project"].
 *
 * The autonomous agent reads skill descriptions at session start and invokes
 * full skill content when needed — no rigid pipeline, agent-directed reasoning.
 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    name: "Investment Thesis",
    dirName: "investment-thesis",
    description:
      "Develop and stress-test investment theses before significant trades. Combines idea generation with bull/bear dialectical analysis.",
    content: `# Investment Thesis

## When to Use
Before any significant trade: opening a new position, materially increasing an existing one,
or making a major allocation shift.

## When NOT to Use
- Mechanical stop-loss exits (the thesis already failed — just execute)
- Scheduled rebalances that follow a predetermined plan
- Trims under 2% of portfolio (minor position management, not a new decision)

## Technique

### 1. The Idea
State the thesis in one sentence: what you are buying/selling, why, and the expected time
horizon. If you cannot articulate it in one sentence, the idea is not ready.

<example type="good">
"Buy GDXJ because gold miners are trading at 0.8x NAV while gold is above $2,300,
with a 3-6 month horizon targeting a reversion to 1.0x NAV."
</example>

<example type="bad">
"Gold miners look interesting and could go up."
</example>

### 2. Bull Case
Build the strongest affirmative case using specific data:
- **Valuation:** Concrete multiples, discounts, or spreads vs. history
- **Catalyst:** Identifiable event or trend with a timeline
- **Technical:** Price action confirming or at least not contradicting the thesis
- **Macro alignment:** Consistent with current regime (see Market Regime skill)

Every claim must reference a number, date, or source. No unsupported assertions.

### 3. Bear Case
Attack the bull case with equal rigor. Steelman the opposing view:
- What is the market pricing in that you think is wrong? Why might the market be right?
- What macro or sector risk could overwhelm the thesis?
- What is the worst realistic drawdown, and can the fund absorb it?

### 4. Devil's Advocate
Assume you are already wrong. Identify:
- The single data point that would invalidate the thesis entirely
- Whether you are anchored to a prior trade or narrative (check trade journal)
- Whether this idea feels urgent — urgency is usually a red flag

### 4.5 Pre-Mortem (Gary Klein)
Assume 12 months from now this trade lost 20%. Write one paragraph explaining why. This is
the single most effective debiasing exercise — it forces you to generate failure scenarios
your optimistic brain would otherwise suppress. The pre-mortem output must be specific: name
the macro scenario, the sector catalyst that failed, or the technical breakdown that occurred.

### 5. Historical Parallel
Query the trade journal for similar past trades (same sector, similar setup, comparable
regime). What happened? What was learned? If no history exists, note that explicitly — first
trades in a new area deserve smaller sizing. First trades in a new sector/asset class deserve
minimum sizing regardless of conviction — you lack the pattern recognition that comes from
experience.

### 6. Conviction Assessment
Rate conviction 1-5 based on evidence quality, not gut feeling:

| Score | Meaning | Typical sizing |
|-------|---------|----------------|
| 1 | Speculative, thin evidence | 1-2% of portfolio |
| 2 | Reasonable but unconfirmed catalyst | 2-4% |
| 3 | Solid data, clear catalyst, manageable risk | 4-6% |
| 4 | Strong multi-factor alignment | 6-8% |
| 5 | Exceptional, rare setup — all signals aligned | 8-10% |

## Quality Standards
- Every factual claim has a number or source
- Bull and bear cases are roughly equal in depth
- A specific invalidation trigger is defined (not "if things get worse")
- Conviction score maps to a position size, not the other way around
- The pre-mortem paragraph is written and specific

## Output
Structured markdown with sections: Thesis, Bull Case, Bear Case, Devil's Advocate,
Pre-Mortem, Historical Parallel, Conviction (1-5), Recommended Action, Invalidation Trigger.
`,
  },
  {
    name: "Risk Assessment",
    dirName: "risk-assessment",
    description:
      "Pre-execution risk check before placing any trade order. Validates expected value, position sizing, and portfolio impact.",
    content: `# Risk Assessment

## When to Use
Immediately before placing any trade order — after the investment thesis is formed but
before execution. This is a final gate, not a substitute for thesis quality.

## When NOT to Use
- Pure exit or trim decisions where risk is being reduced, not added
- Mechanical stop-loss triggers (the stop was already validated at entry)

## Technique

### 1. Expected Value
Estimate the trade's expected value:
- **Upside target:** Price level and % gain if thesis plays out
- **Downside stop:** Price level and % loss if thesis fails
- **Probability estimate:** Rough odds of success (be honest, not optimistic)
- **EV = (P(win) x gain) - (P(loss) x loss)** — must be positive

If EV is negative or unclear, do not trade.

<example type="good">
"GDXJ entry at $42.15, target $48 (+13.9%), stop $38.50 (-8.6%).
P(win) = 55%, P(loss) = 45%. EV = (0.55 x 13.9%) - (0.45 x 8.6%) = +3.8%."
</example>

<example type="bad">
"I think GDXJ will go up because gold is strong. Risk/reward looks good."
</example>

### Drawdown Recovery Math
Losses are asymmetric — the deeper the hole, the harder to climb out:

| Loss | Gain to Recover |
|------|-----------------|
| -10% | +11.1% |
| -20% | +25% |
| -30% | +42.9% |
| -40% | +66.7% |
| -50% | +100% |
| -60% | +150% |

Always consider the recovery math before sizing. A -30% loss requires +42.9% gain to break
even — math that may make the fund's objective unreachable.

### 2. Position Size Validation
Use at least TWO sizing methods (conviction-based AND Kelly criterion). Take the SMALLER
result. If they diverge by more than 2x, your conviction estimate is likely miscalibrated
— trust Kelly and investigate why your conviction is so high.

Validate the proposed size against fund constraints:
- Does it exceed \`risk.max_position_pct\`? → Reduce
- Does it create a concentrated sector/factor bet? → Flag
- Is it appropriate for the conviction level? (See Position Sizing skill)
- Would a full loss at the stop violate \`risk.max_daily_loss_pct\`? → Reduce

### 3. Order Specification
Only after all checks pass, specify the exact order:
- Symbol, side (buy/sell), quantity, order type (limit/market)
- Stop-loss price and type
- Take-profit level (if applicable)

## Output
Structured checklist: EV calculation (with drawdown recovery context), dual-method size
validation, and final order specification or rejection with reason.

## Universe awareness

Before calling \`place_order\` (buy side), validate the ticker via the \`check_universe\` tool on the broker-local MCP. If \`in_universe: false\` and \`exclude_hard_block: false\`, you may proceed by including \`out_of_universe_reason\` (>= 20 chars, material and time-sensitive) in the trade call. If \`exclude_hard_block: true\`, do not attempt the trade — excluded tickers and sectors are set by the mandate and cannot be overridden.

Use \`list_universe({ sector })\` when you need to survey what's available in a particular area of your universe.

<example type="good">
check_universe({ ticker: "CRWD" }) returned in_universe: true, base_match: true. Proceeding with place_order.
</example>

<example type="good">
check_universe({ ticker: "NVDA" }) returned in_universe: false, requires_justification: true (NVDA is outside nasdaq100 — hypothetical).
Thesis: "NVDA announced Q1 beat with forward guidance +$2B above consensus, and the options-implied move is 5% vs historical average 3% — event-driven catalyst within 72h."
Passing this thesis as out_of_universe_reason to place_order.
</example>

<example type="bad">
Skipping check_universe because I'm confident AAPL is in sp500.
</example>

### Modifying the universe

If the user asks to change the fund's universe (e.g., "switch to Nasdaq 100", "exclude TSLA", "only tech stocks"), use the \`update_universe\` tool on the broker-local MCP. Never edit \`fund_config.yaml\` directly — the tool validates the change, writes atomically, invalidates the cache, and regenerates CLAUDE.md.

**Tool semantics:**
- \`mode.preset\` and \`mode.filters\` are mutually exclusive. Passing one switches modes.
- \`include_tickers\`, \`exclude_tickers\`, \`exclude_sectors\` REPLACE their current lists. To ADD one ticker, first call \`list_universe({ verbose: true })\` to read the current lists, then pass the full new list (existing + added).
- Omitted fields stay unchanged.
- The tool validates and resolves the new universe; check \`output.warnings\` and \`output.resolved.count\` to confirm the change is safe.

<example type="good">
User: "Exclude TSLA from my universe."
Me:
1. list_universe({ verbose: true }) → returns current exclude_tickers: ["FOO"]
2. update_universe({ exclude_tickers: ["FOO", "TSLA"] }) → validates, writes, returns warnings=[]
</example>

<example type="good">
User: "Switch to Nasdaq 100."
Me: update_universe({ mode: { preset: "nasdaq100" } }) → check output.resolved.count > 0 and output.warnings empty
</example>

<example type="bad">
update_universe({ exclude_tickers: ["TSLA"] }) without first reading the current list — this REPLACES, so any existing exclusions are lost silently.
</example>

<example type="bad">
Editing fund_config.yaml directly with Write/Edit tools — bypasses validation and won't regenerate CLAUDE.md.
</example>
`,
  },
  {
    name: "Trade Memory",
    dirName: "trade-memory",
    description:
      "Query trade journal for relevant past trades, win rates, and historical lessons before making decisions.",
    content: `# Trade Memory

## When to Use
Before any trade decision, query the trade journal to learn from history. Also use when
reviewing a sector, ticker, or strategy you have traded before. The journal is in
\`state/trade_journal.sqlite\` with a \`trades\` table and \`trades_fts\` FTS5 index.

## When NOT to Use
When the fund has no trade history yet — skip the journal queries and note that this is a
first trade with no historical context. Proceed with minimum sizing as appropriate.

## Technique

### Queries to Run

**1. Same-ticker history:**

<example type="good">
\`\`\`sql
SELECT symbol, side, entry_price, exit_price, pnl_pct, reasoning, lessons_learned,
       entry_date, exit_date
FROM trades WHERE symbol = ? ORDER BY entry_date DESC LIMIT 10
\`\`\`
</example>

What was your track record? Win rate? Average gain vs. average loss?

**2. Similar-setup search (FTS5):**

<example type="good">
\`\`\`sql
SELECT symbol, reasoning, lessons_learned, pnl_pct
FROM trades_fts WHERE trades_fts MATCH ?
ORDER BY rank LIMIT 10
\`\`\`
</example>

**FTS5 keyword guidance:** Search by: sector name, catalyst type (earnings, FDA, FOMC),
market regime at entry (risk-on, risk-off), strategy name (breakout, mean-reversion,
momentum). Combine keywords for more precise matches.

**3. Recent performance:**

<example type="good">
\`\`\`sql
SELECT COUNT(*) as total,
       SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
       AVG(pnl_pct) as avg_pnl,
       MIN(pnl_pct) as worst
FROM trades WHERE exit_date > date('now', '-30 days')
\`\`\`
</example>

Are you in a winning or losing streak? Adjust sizing accordingly.

**4. Pattern detection:**

<example type="good">
\`\`\`sql
SELECT symbol, side, pnl_pct, reasoning, lessons_learned
FROM trades WHERE pnl_pct < -5 ORDER BY pnl_pct ASC LIMIT 5
\`\`\`
</example>

What do your worst trades have in common? Are you about to repeat a pattern?

### R-Multiple Framework
Normalize all trades as multiples of initial risk (R). 1R = the dollar amount risked on the
trade. A 3R winner means you gained 3x what you risked. This makes trades comparable across
different position sizes and prices. Track your average R-multiple — positive means your
winners outsize your losers.

When querying the journal, compute R-multiples for past trades:
- R = entry_price - stop_price (for longs)
- R-multiple = (exit_price - entry_price) / R
- Average R-multiple across last 20 trades is your edge metric

## Decision Rules
- **Win rate < 40% on ticker** → Reduce size by 50% or skip
- **3+ consecutive losses recently** → Reduce all sizing by one tier
- **Past lesson directly applies** → Quote it in the thesis and adjust
- **No history on this ticker/sector** → Treat as first trade, use minimum sizing
- **Repeated same mistake** → Veto the trade until the pattern is addressed
- **Average R-multiple negative over 20+ trades** → Strategy needs fundamental reassessment

## Output
Summary of relevant past trades, key lessons that apply, win rate stats, R-multiple
analysis, and a clear recommendation: proceed (with adjustments), reduce size, or skip.
`,
  },
  {
    name: "Market Regime",
    dirName: "market-regime",
    description:
      "Classify the current market environment to calibrate position sizing and strategy selection. Run at the start of trading sessions.",
    content: `# Market Regime Classification

## When to Use
At the start of every trading session before making any decisions. Also re-run when a major
macro event occurs (FOMC, CPI, NFP, geopolitical shock). The regime determines baseline
position sizing, cash levels, and which strategies are appropriate.

## When NOT to Use
- Intraday scalping decisions (too short a timeframe for regime to matter)
- Mechanical DCA programs where regime is irrelevant by design

## Technique

### Composite Regime Score
Score = Volatility (30%) + Trend (30%) + Credit (20%) + Macro (20%)
Each component scored 1-4:
1 = risk-on signal, 2 = neutral, 3 = risk-off signal, 4 = crisis signal
Composite: 1.0-1.5 = Risk-On | 1.5-2.5 = Transition | 2.5-3.5 = Risk-Off | 3.5-4.0 = Crisis

### 1. Volatility Component (30%)
Score the volatility environment:

| Indicator | 1 (Risk-On) | 2 (Neutral) | 3 (Risk-Off) | 4 (Crisis) |
|-----------|-------------|-------------|---------------|------------|
| VIX level | <18 | 18-25 | 25-35 | >35 |
| VIX term structure | Contango (calm) | Flat | Mild backwardation | Deep backwardation |
| Realized vs implied | Implied > realized | ~Equal | Realized rising | Realized > implied |

### 2. Trend Component (30%)
Score the market trend:

| Indicator | 1 (Risk-On) | 2 (Neutral) | 3 (Risk-Off) | 4 (Crisis) |
|-----------|-------------|-------------|---------------|------------|
| SPX vs 50d MA | Above, rising | Above, flat | Below 50d | Below 50d, accelerating down |
| SPX vs 200d MA | Above | Above | Near/testing | Below |
| Advance-decline | Broadening | Flat | Narrowing | Collapsing |
| % stocks above 200d | >60% | 40-60% | 25-40% | <25% |

### 3. Credit Component (20%)
Score the credit environment:

| Indicator | 1 (Risk-On) | 2 (Neutral) | 3 (Risk-Off) | 4 (Crisis) |
|-----------|-------------|-------------|---------------|------------|
| IG spreads | Tightening | Stable | Widening | Blowing out |
| HY spreads | Tightening | Stable | Widening | Blowing out |
| OAS movement (5d) | Decreasing | Flat | +10-30bps | >+30bps |

### 4. Macro Component (20%)
Score the macro backdrop:

| Indicator | 1 (Risk-On) | 2 (Neutral) | 3 (Risk-Off) | 4 (Crisis) |
|-----------|-------------|-------------|---------------|------------|
| Yield curve | Steepening, normal | Flat | Inverted | Deeply inverted or rapid shift |
| DXY trend | Weakening | Stable | Strengthening | Spiking |
| LEI | Rising | Flat | Declining | Declining >3 months |

### Regime Transition Signals
A regime transition is signaled when 2+ components shift by >=1 point in the same direction
within 5 trading days. Transitions warrant immediate portfolio review.

<example type="good">
"Composite Score: 2.7 (Risk-Off). Volatility: 3 (VIX at 28, backwardation).
Trend: 3 (SPX below 50d MA, 35% above 200d). Credit: 2 (IG stable, HY +8bps).
Macro: 2 (curve flat, DXY stable). Regime shifted from Transition 3 days ago when
VIX broke 25 and breadth narrowed — two components moved +1 in same direction."
</example>

<example type="bad">
"Market feels risk-off. VIX is elevated. Things look uncertain."
</example>

## Regime Classifications

| Regime | Score Range | Sizing Multiplier | Cash Floor | Appropriate Strategies |
|--------|-------------|-------------------|------------|----------------------|
| **Risk-On** | 1.0-1.5 | 1.0x | Per fund min | Momentum, breakout |
| **Transition** | 1.5-2.5 | 0.7x | +10% cash | Mean-reversion, quality factor |
| **Risk-Off** | 2.5-3.5 | 0.5x | +20% cash | Defensive, income, short-duration |
| **Crisis** | 3.5-4.0 | 0.25x | +40% cash | Cash, treasuries, gold only |

### Regime-Dependent Strategy Constraints
- **Risk-On:** Momentum and breakout strategies are appropriate. Full conviction sizing.
- **Transition:** Mean-reversion and quality factor strategies preferred. Require conviction >= 3.
- **Risk-Off:** Defensive, income, and short-duration strategies only. Actively trim risk.
- **Crisis:** Cash, treasuries, and gold only. No new equity longs. Goal is survival.

**Dalio's warning:** In stress, correlations converge to 1.0. Apparent diversification is
illusory when you need it most. When regime is Risk-Off or Crisis, recalculate portfolio
risk assuming all equity correlations are 0.8.

## Output
Current regime classification with composite score and per-component breakdown, sizing
multiplier for the session, recommended cash floor adjustment, strategy constraints, and
any regime transition signals detected.
`,
  },
  {
    name: "Position Sizing",
    dirName: "position-sizing",
    description:
      "Calculate position size from conviction level, fund type, portfolio state, market regime, and Kelly criterion.",
    content: `# Position Sizing

## When to Use
After forming a thesis and conviction score but before placing the order. This skill
translates conviction into exact dollar amounts and share counts.

## When NOT to Use
- Exits, stop-loss triggers, or full-position closes (risk is being reduced, not added)
- Trims where the decision is "how much to sell" rather than "how much to buy"

## Technique

Always compute using two methods (conviction-based sizing AND Kelly criterion) and compare.
Take the smaller result. If they diverge by more than 2x, investigate why.

### Step 1: Base Size from Conviction

| Conviction | Base % of Portfolio |
|------------|---------------------|
| 1 — Speculative | 1-2% |
| 2 — Reasonable | 2-4% |
| 3 — Solid | 4-6% |
| 4 — Strong | 6-8% |
| 5 — Exceptional | 8-10% |

<example type="good">
"Conviction 3 (solid) → base 5%. Fund type runway x0.7 = 3.5%. Regime transition x0.7 = 2.45%.
Half-Kelly from journal stats = 3.1%. Taking smaller: 2.45%. Max position check: 2.45% < 25% cap. OK."
</example>

<example type="bad">
"High conviction, going with 8% position."
</example>

### Step 2: Fund Type Adjustment

| Fund Type | Adjustment |
|-----------|------------|
| Runway | x0.7 (capital preservation priority) |
| Growth | x1.0 (standard) |
| Accumulation | x1.0 for target asset, x0.5 for others |
| Income | x0.8 (yield stability priority) |
| Custom | Use fund's custom_rules if specified |

### Step 3: Regime Multiplier
Apply the market regime sizing multiplier from the Market Regime skill:
- Risk-On: 1.0x
- Transition: 0.7x
- Risk-Off: 0.5x
- Crisis: 0.25x

### Step 4: Portfolio Concentration Check
- After this trade, would any single position exceed \`max_position_pct\`? → Cap it
- Would total exposure in one sector exceed 30%? → Flag and reduce
- Would correlated positions (e.g., multiple gold instruments) exceed 40% combined? → Reduce

### Step 5: Kelly Criterion Cross-Check
Kelly % = win_prob - (1 - win_prob) / (avg_win / avg_loss)

Use half-Kelly (divide by 2) as the practical maximum. Always compute both conviction-based
size AND Kelly-optimal size. Use the smaller. If conviction-size exceeds 2x Kelly-size, your
conviction is likely miscalibrated — trust Kelly. Pull historical win rate from trade journal.

### Quality Gate
For individual equities, prefer Piotroski F-Score >= 6 (9-point financial quality scale).
Stocks with F-Score >= 8 historically outperformed by 7.5% annually over 20-year studies.
Below 4 is a red flag regardless of thesis quality. This gate applies to stock selection
quality, not ETFs or index instruments.

### Step 6: Final Calculation
\`\`\`
final_pct = min(
  base_size x fund_adj x regime_mult,
  half_kelly,
  max_position_pct
)
shares = floor((portfolio_value x final_pct) / current_price)
dollar_amount = shares x current_price
\`\`\`

Verify: dollar_amount <= available cash. If not, reduce to what cash allows.

## Output
Table showing: base size, each adjustment, final %, dollar amount, share count, and
the binding constraint (conviction, Kelly, max position, or cash). Must show results from
both the two methods (conviction-based and Kelly) for comparison.
`,
  },
  {
    name: "Session Reflection",
    dirName: "session-reflection",
    description:
      "End-of-session review: audit decisions, detect biases, update trade journal, and track objective progress.",
    content: `# Session Reflection

## When to Use
At the end of every trading session. Even if "nothing happened," reflect on why and whether
inaction was the right call.

## When NOT to Use
Emergency single-action sessions (e.g., executing a stop-loss at market open) — just execute
and log. Full reflection can happen at the next regular session.

## Technique

### 1. Decision Audit
For every decision made this session (trades, holds, skips):
- **What was the thesis?** — Restate it in one sentence
- **What actually happened?** — Price action, news, execution quality
- **Was the process good?** — Did you follow the thesis -> risk check -> execute flow?
- **Grade: A/B/C/D/F** — Based on process quality, not outcome

A good process with a bad outcome is still an A. A lucky win from a sloppy process is a D.

### 2. Bias Check
Honestly assess whether any of these biases influenced decisions:

| Bias | Signal | Antidote |
|------|--------|----------|
| **Anchoring** | Fixated on a price target or past entry | Re-derive fair value from current data |
| **Confirmation** | Only sought supporting evidence | Explicitly wrote bear case |
| **Loss aversion** | Held a loser past the stop, hoping for recovery | Mechanical stop-loss execution |
| **Recency** | Overweighted today's move vs. the thesis timeframe | Zoom out to thesis horizon |
| **FOMO** | Chased a move after missing the entry | Missed trades have zero cost |
| **Sunk cost** | Averaged down without new thesis support | Each add must stand alone as a new trade |
| **Overconfidence** | Conviction score inflated without proportional evidence | Compare conviction-based size vs Kelly — divergence signals overconfidence |
| **Disposition effect** | Sold winners too early, held losers too long | Compare holding periods: winners vs losers should be similar |
| **Narrative fallacy** | Built a compelling story that overrides data | Check: would you still make this trade if the story were boring? |
| **Herding** | Followed consensus or social sentiment without independent analysis | Verify thesis existed before reading others' views |

If any bias was present, note it explicitly and describe how it affected the decision.

### 3. Calibration Score
Over your last 20 predictions, compare predicted probability to actual hit rate. If you
predict 70% confidence and win only 40% of the time, you are systematically overconfident
— adjust future conviction scores down by the gap. Track this calibration score in
memory/trading-patterns.md and update it each session.

<example type="good">
"Last 20 predictions: avg predicted confidence 65%, actual hit rate 52%. Gap: -13%.
Adjusting future conviction scores down by ~1 tier until calibration improves."
</example>

<example type="bad">
"I think my predictions have been pretty accurate."
</example>

### 4. Journal Updates
Update the trade journal for every trade executed or closed.

Record initial risk (R) for every trade at entry. At exit, compute P&L as an R-multiple.
Track average R-multiple in memory. A positive average R-multiple means your winners outsize
your losers — this is the single most important metric for long-term profitability.

<example type="good">
"Bought 50 shares GDXJ at $42.15. Thesis: gold miners undervalued at 0.8x NAV with
gold above $2,300. Regime: Transition. Conviction: 3. Stop: $38.50 (-8.6%).
R = $3.65/share. Catalyst: Fed pause expected within 60 days."
</example>

<example type="bad">
"Bought GDXJ. Looks good."
</example>

For closed trades, always record:
- Final P&L ($ and %) and R-multiple
- Whether the exit matched the plan (hit target, hit stop, or discretionary)
- One specific lesson learned

### 5. Objective Progress
Review the fund's objective tracker:
- **Runway funds:** Current months of runway vs. target. Burn rate on track?
- **Growth funds:** Current multiple vs. target. Pace to reach goal?
- **Accumulation funds:** Units acquired vs. target. Average cost basis trend?
- **Income funds:** Monthly income rate vs. target. Yield sustainability?

Update \`state/objective_tracker.json\` with current progress metrics.

## Output
Structured markdown: Decision Audit (graded), Bias Check (honest), Calibration Score
(tracked), Journal Updates (written to DB with R-multiples), Objective Progress (updated),
Next Session Focus (priorities for the next trading session), Contract Evaluation (feedback
loop closed), Session Handoff (written to \`state/session-handoff.md\`), and for every trade
reviewed: **What will I do differently next time?** This field is mandatory — reflection
without behavioral change is just journaling.

## Follow-Up Scheduling
If during reflection you identify something that needs checking before the next
regular session (e.g., price level to monitor, order to verify, catalyst window),
schedule a follow-up by writing to \`state/pending_sessions.json\`.
See \`.claude/rules/self-scheduling.md\` for the format.

### 6. Contract Evaluation
Compare your Session Contract (written during Orient) against actual outcomes:

- **Stated intent**: [copy the contract verbatim from session start]
- **Actual outcome**: [what actually happened]
- **Deviation**: [if any, describe what changed and why]
- **Was the deviation justified?**: [yes/no + reasoning]

This closes the feedback loop between session planning and execution. Patterns of unjustified
deviation signal a problem with either planning or discipline.

### 7. Session Handoff
Write the full handoff to \`state/session-handoff.md\`. This file is read by the NEXT session
(whether cron or interactive chat) to maintain continuity. The handoff replaces the minimal
contract you wrote during Orient with the complete version.

Format:

\`\`\`markdown
# Session Handoff — {date} {session_type}

## Session Contract
> [Copy original contract from Orient]

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
\`\`\`

This handoff is critical — every session type (cron, chat, catch-up, pending) reads it.
An incomplete handoff breaks the continuity chain.
`,
  },
  {
    name: "Portfolio Review",
    dirName: "portfolio-review",
    description:
      "Holistic portfolio health check: position-by-position thesis validation, concentration analysis, and rebalancing recommendations.",
    content: `# Portfolio Review

## When to Use
At least once per week during a post-market session. Also trigger when:
- A position has moved more than 15% since last review
- Market regime has changed
- A new position is being considered (to understand fit)
- The fund is approaching a drawdown limit

## When NOT to Use
First session of a brand-new fund with no positions yet — there is nothing to review.
Use the session to establish the initial investment plan instead.

## Technique

### 1. Position-by-Position Review
For each open position:
- **Original thesis:** Is it still valid? Has the catalyst played out or expired?
- **Current P&L:** Unrealized gain/loss in $ and %
- **vs. Stop-loss:** How far from the stop? Has the stop been respected?
- **vs. Target:** How far from the profit target? Is the risk/reward still attractive?
- **Action:** Hold (thesis intact), Trim (take partial profits), Add (thesis strengthened),
  Close (thesis invalidated or target reached)

Positions without a valid current thesis should be closed. "I'm not sure" is a sell signal.

<example type="good">
"GDXJ: Thesis (gold miners undervalued at 0.8x NAV) still valid — NAV discount at 0.82x.
P&L: +$315 (+3.7%). Stop $38.50 is 8.6% below current. Target $48 is 13.9% above.
R/R still favorable. Action: HOLD. Catalyst (Fed pause) has not occurred yet."
</example>

<example type="bad">
"GDXJ: Up a bit. Looks fine. Hold."
</example>

### 2. Portfolio-Level Analysis
- **Concentration:** Top 3 positions as % of portfolio — flag if >50%
- **Sector exposure:** Group positions by sector — flag if any sector >30%
- **Correlation:** Identify positions that move together (e.g., gold miners + gold ETF).
  In a drawdown, correlated positions fall together — treat them as one combined position
  for risk purposes
- **Cash level:** Current cash % vs. regime-recommended minimum
- **Drawdown status:** Current drawdown from peak vs. \`max_drawdown_pct\` limit

### 3. Rebalancing Recommendations
Based on the above analysis:
- Positions to trim or close (with reasoning)
- Positions to add to (with thesis update)
- Cash adjustments needed for regime change
- New positions to research (gaps in the portfolio)

Rebalancing is not about perfection — it is about removing positions that no longer deserve
capital and right-sizing those that do.

### 4. Objective-Specific Review
Tailor the portfolio review to the fund's objective type:

- **Runway:** Months remaining vs target, burn rate sustainability, cash runway calculation.
  Is the portfolio generating enough to offset monthly withdrawals? At current trajectory,
  will the fund reach its target months?
- **Growth:** Required return rate to reach target on time, pace assessment. If behind pace,
  is the gap recoverable without excessive risk? Anti-revenge-trading check: do not increase
  risk simply because you are behind schedule.
- **Income:** Yield sustainability, diversification across 10+ income sources, coverage ratio
  (income generated vs income target). Concentration in any single income source >20% is a
  fragility risk.
- **Accumulation:** Cost basis trend (improving or worsening?), DCA vs lump sum assessment,
  target completion %. Is the remaining timeline sufficient at current acquisition rate?

### 5. Survival Question
"If I am completely wrong about everything — every thesis, every regime call, every macro
view — does the fund survive?" If the answer is no, reduce risk until the answer is yes.
This is the single most important question in portfolio management. A fund that survives
its mistakes can always recover; a fund that does not survive cannot.

### 6. Barbell Assessment
Classify each position as:
- **Essential** (protect capital, low risk): cash, treasuries, defensive positions
- **Asymmetric** (limited downside, large upside): high-conviction theses with tight stops

A healthy portfolio has both. A portfolio of only "medium risk" positions is fragile — it
has neither the safety of the essential bucket nor the upside of the asymmetric bucket.
Review the barbell balance and adjust if one side is empty.

## Output
Position table (symbol, size, P&L, thesis status, action), portfolio-level metrics
(concentration, sector, correlation, cash, drawdown), objective-specific progress,
survival assessment, barbell classification, and prioritized rebalancing actions
with reasoning.
`,
  },
  {
    name: "Opportunity Screening",
    dirName: "opportunity-screening",
    description:
      "Use the screener MCP to find and prioritise new trade candidates from the watchlist. Triggered at Orient and on user request.",
    content: `# Opportunity Screening

## When to Use
- Immediately after the Orient phase of a session, to see which tickers have been surfaced by screens for this fund.
- When the user asks in chat for opportunities, ideas, or "what's interesting right now".
- Mid-session, when considering new positions and the portfolio has open capacity.

## When NOT to Use
- Portfolio is already at its max-positions limit (per fund config).
- Market regime is clearly risk-off and this fund's objective is capital preservation — defer to runway-style defensive holds.
- Fund is in an active drawdown and the session is focused on damage control.
- The user is asking a question unrelated to new ideas — don't pre-empt.

## Technique
1. Query the screener MCP filtered by this fund for \`candidate\` and \`watching\` statuses first; then query \`fading\` separately to spot potential re-entries.
2. For any ticker that looks interesting, call \`screener.watchlist_trajectory({ ticker })\` and inspect:
   - How long it has been on the list (\`first_surfaced_at\`).
   - Whether scores trended up cleanly, plateaued, or whipsawed.
   - Whether it has previously transitioned to \`fading\` and recovered — re-entries after a pause are often stronger signals than first-time candidates.
3. Cross-reference each candidate against the current portfolio: does it introduce new sector exposure, or concentrate existing risk (per the fund's risk config)?
4. Select 3–5 candidates to prioritise. Hand them to the \`trade-evaluator\` sub-agent for thesis construction and risk review.

## Caveats
- **V1 scope:** only the 12-1 momentum screen populates the watchlist. Names without any screen tag should be treated as informational, not a recommendation.
- **Fund tagging:** funds whose \`universe\` is declared by sector/strategy/protocol (not explicit ETF/ticker lists) receive no automatic fund tags. The watchlist will still surface workspace-wide candidates; apply the fund's universe filter mentally.
- **Empty watchlist is normal** on a fresh install until the first daily run completes.

## Output Format
Produce a section titled **Opportunity shortlist** with one block per candidate:

\`\`\`
- **<TICKER>** — <status>, <days on list>
  - Current score: <x.x%> (trajectory: <rising | stable | recovered | fading-slightly>)
  - Why it fits this fund: <1 line mapping to objective>
  - Open question for analysis: <specific risk or catalyst to probe>
\`\`\`
`,
  },
];

// ── Workspace skill ────────────────────────────────────────────

/**
 * The create-fund skill lives in ~/.fundx/.claude/skills/create-fund/SKILL.md.
 * It is loaded automatically by the Agent SDK in workspace mode (cwd = ~/.fundx).
 */
export const WORKSPACE_SKILL: Skill = {
  name: "Create Fund",
  dirName: "create-fund",
  description: "Create a complete FundX investment fund from a natural language description by writing fund_config.yaml and initializing the fund directory",
  content: `# Create Fund

## When to Use
When the user describes an investment goal, strategy, or objective and wants to set up a fund.

## Process
1. Ask clarifying questions if any of these are missing: initial capital, time horizon, risk tolerance, target assets
2. Write the complete \`fund_config.yaml\` to \`${WORKSPACE}/funds/<name>/fund_config.yaml\`
3. Create required subdirectories: \`state/\`, \`analysis/\`, \`scripts/\`, \`reports/\`, \`.claude/\`
4. The app auto-detects the new fund and completes initialization (state files, CLAUDE.md)
5. Tell the user: "Type \`/fund <name>\` to start chatting with your new fund's AI manager."

## fund_config.yaml Schema

\`\`\`yaml
fund:
  name: my-fund                    # lowercase letters, digits, hyphens, underscores only
  display_name: "My Fund"
  description: "One-line description"
  created: "YYYY-MM-DD"            # today's date
  status: active

capital:
  initial: 10000                   # in USD
  currency: USD

objective:
  # Use 'custom' for complex or narrative goals (recommended):
  type: custom
  description: |
    Full objective: assets, strategy, macro thesis, deployment approach, success criteria.
    Be specific — this is read at every trading session.
  success_criteria: "What success looks like"

  # Alternatively, use a structured type:
  # type: runway
  # target_months: 18
  # monthly_burn: 3000
  # min_reserve_months: 3

  # type: growth
  # target_multiple: 2.0
  # timeframe_months: 24

  # type: accumulation
  # target_asset: BTC
  # target_amount: 1.0

  # type: income
  # target_monthly_income: 500

risk:
  profile: moderate                # conservative | moderate | aggressive
  max_drawdown_pct: 15             # conservative=10, moderate=15, aggressive=25
  max_position_pct: 25             # max % of portfolio in one position
  stop_loss_pct: 8
  max_daily_loss_pct: 5
  custom_rules:
    - "Rule specific to this fund's strategy"

universe:
  allowed:
    - type: etf
      tickers: [GDXJ, JNUG, AGQ, UGL]
  forbidden: []

schedule:
  timezone: America/New_York
  sessions:
    pre_market:  { time: "09:00", enabled: true,  focus: "Analyze overnight. Plan trades." }
    mid_session: { time: "13:00", enabled: false, focus: "Monitor positions." }
    post_market: { time: "18:00", enabled: true,  focus: "Review day. Update journal." }

broker:
  mode: paper                      # ALWAYS paper

claude:
  model: sonnet
  personality: |
    Describe the AI manager's full context: who is the investor, what is their background,
    the macro thesis driving this strategy, key principles, and relevant constraints.
    This is read at the start of every autonomous trading session — make it rich and specific.
  decision_framework: |
    Specific decision rules for this fund: entry criteria, exit criteria, position sizing
    approach, what macro signals to watch, what to avoid, how to handle drawdowns.
    These rules govern every trade decision — make them actionable and unambiguous.
\`\`\`

## Key Principles
- The \`personality\` and \`decision_framework\` fields are the most important — they are Claude's
  constitution for every autonomous trading session. Make them detailed, specific, and actionable.
- Always paper mode
- Use \`objective.type: custom\` for narrative goals; structured types for simple ones
- \`custom_rules\` should capture any strategy-specific constraints not covered by risk parameters
`,
};

// ── Public API ─────────────────────────────────────────────────

/** Names of all built-in fund skills */
export function getAllSkillNames(): string[] {
  return BUILTIN_SKILLS.map((s) => s.name);
}

/** Content (body without frontmatter) of a fund skill by human-readable name */
export function getSkillContent(skillName: string): string | undefined {
  return BUILTIN_SKILLS.find((s) => s.name === skillName)?.content;
}

/**
 * Write skills to `<claudeDir>/skills/<dirName>/SKILL.md`.
 * Idempotent — skips files that already exist.
 */
export async function ensureSkillFiles(claudeDir: string, skills: Skill[]): Promise<void> {
  for (const skill of skills) {
    const skillDir = join(claudeDir, "skills", skill.dirName);
    await mkdir(skillDir, { recursive: true });
    const filePath = join(skillDir, "SKILL.md");
    if (!existsSync(filePath)) {
      await writeFile(filePath, buildSkillMd(skill), "utf-8");
    }
  }
}

/**
 * Write the trading analysis skills to a fund's .claude/skills/ directory.
 * Called during fund creation so each fund's Agent SDK session auto-loads them.
 */
export async function ensureFundSkillFiles(fundClaudeDir: string): Promise<void> {
  await ensureSkillFiles(fundClaudeDir, BUILTIN_SKILLS);
}

// ── Per-Fund Rules ─────────────────────────────────────────────

const FUND_RULES: { fileName: string; content: string }[] = [
  {
    fileName: "state-consistency.md",
    content: `# State & Config Consistency

When the user provides information that changes fund parameters (capital, risk limits,
allowed assets, objective, etc.), you MUST update ALL affected files — not just one.

## Files that must stay in sync

| File | Contains |
|------|----------|
| \`fund_config.yaml\` | Declared fund parameters (source of truth for configuration) |
| \`state/portfolio.json\` | Current cash, total_value, and positions |
| \`state/objective_tracker.json\` | Progress toward the fund's goal |
| \`CLAUDE.md\` | Generated from fund_config.yaml — do NOT edit directly |

## portfolio.json Schema

Use exactly these field names when writing positions. The daemon's stop-loss monitor
and dashboard validate against this schema — wrong field names cause silent failures.

\`\`\`json
{
  "last_updated": "ISO timestamp",
  "cash": 10000,
  "total_value": 10500,
  "positions": [
    {
      "symbol": "AAPL",
      "shares": 10,
      "avg_cost": 150.00,
      "current_price": 155.00,
      "market_value": 1550.00,
      "unrealized_pnl": 50.00,
      "unrealized_pnl_pct": 3.33,
      "weight_pct": 14.76,
      "stop_loss": 142.50,
      "entry_date": "2026-01-15",
      "entry_reason": "Thesis summary here"
    }
  ]
}
\`\`\`

Do NOT use alternative field names (\`qty\`, \`avg_entry_price\`, \`cost_basis\`,
\`pct_of_portfolio\`, \`thesis\`). The correct names are: \`shares\`, \`avg_cost\`,
\`weight_pct\`, \`entry_reason\`.

## Rules

1. **Capital changes** — If the user corrects \`capital.initial\`:
   - Update \`fund_config.yaml\`
   - If the fund has NO open positions, also update \`portfolio.json\` so that
     \`cash\` and \`total_value\` match the new initial capital
   - If the fund HAS positions, warn the user that existing positions won't be
     adjusted and ask how to proceed

2. **Never edit only one side** — A change to \`fund_config.yaml\` without the
   corresponding state update (or vice-versa) will cause the dashboard to show
   incorrect P&L, wrong cash percentages, or phantom gains/losses

3. **CLAUDE.md is derived** — Never edit it by hand. If config changes, tell the
   user to run \`fundx fund upgrade --name <fund>\` to regenerate it

4. **Atomic updates** — When updating multiple files, update them all in the same
   response. Do not leave the fund in an inconsistent state between messages
`,
  },
  {
    fileName: "decision-quality.md",
    content: `# Decision Quality Standards

Why: Emotional overrides of systematic rules are the primary cause of preventable losses.

## Decision Hierarchy

When inputs conflict, follow this priority order:
1. Hard risk limits (max position, max drawdown, stop-loss) — absolute, never override
2. Fund objective alignment — does this trade serve the fund's goal?
3. Market regime appropriateness — is this the right trade for the current environment?
4. Thesis quality and conviction — is the analysis rigorous?
5. Timing and execution — is this the right moment?

## Red Flags — Pause and Reconsider

- Adding to a losing position without a new, independent thesis
- Removing or widening a stop-loss after it is set
- Trading in the first 15 minutes of market open on a volatile day
- Placing more than 3 trades in a single session (overtrading signal)
- Conviction score that increased after you already decided to trade (rationalization)
- Any trade where the reasoning starts with "I feel like..."

## Analyst Disagreement
When analysts disagree, weight the one with more specific data. Vague concerns do not override quantified analysis.
`,
  },
  {
    fileName: "analysis-standards.md",
    content: `# Analysis Standards

Why: Vague analysis leads to vague decisions. Specificity forces intellectual honesty.

<example type="good">
"GDXJ is trading at $42.15, down 12% from its 52-week high of $47.90, with RSI at
38 and approaching the 200-day MA at $40.80. Base case (60%): rebounds to $45 within
30 days on mean reversion. Downside (20%): breaks below $39 support if DXY > 107."
</example>

<example type="bad">
"GDXJ is oversold and near support. It should go up because gold miners are undervalued."
</example>

## Forbidden Patterns

1. **Listing facts without synthesis** — A list of data points is not analysis. Every fact
   must connect to the thesis with "which means..." or "this matters because..."

2. **Vague directional language** — Banned phrases: "could go either way," "looks interesting,"
   "might be a good opportunity," "the trend seems positive." Replace with specific claims
   and numbers.

3. **Hedging everything** — If every sentence includes "however" or "on the other hand,"
   the analysis has no point of view. Take a position and defend it. The bear case belongs
   in its own section, not diluting every sentence.

4. **Anchoring to round numbers** — Do not set targets at $50, $100, etc. unless there is
   a specific technical or fundamental reason. Targets come from analysis, not aesthetics.

5. **Recency bias in data selection** — Do not cherry-pick the time frame that supports
   your thesis. Show multiple time frames and acknowledge when they conflict.
`,
  },
  {
    fileName: "risk-discipline.md",
    content: `# Risk Discipline

Why: A 50% drawdown requires 100% gain to recover — math that makes most fund objectives unreachable.

Risk limits are hard constraints, not guidelines. They exist because the fund's objective
depends on capital preservation. A 50% drawdown requires a 100% gain to recover — math
that makes the objective unreachable.

## Position-Level Rules

1. **Stop-loss on every position** — No position is held without a defined stop-loss.
   The stop is set at entry and recorded in the trade journal. Moving a stop further
   from entry is prohibited unless the position is in profit and you are trailing the stop.

2. **Stops are executed mechanically** — When a stop is hit, the position is closed. No
   "let me wait to see if it recovers." The thesis failed; accept the loss.

3. **Never exceed \`max_position_pct\`** — This is a hard cap, not a target. If a position
   grows into exceeding the limit through appreciation, trim it at the next session.

4. **Each add is a new trade** — Adding to a position requires a new thesis that stands
   on its own. "Averaging down" without new information is not a strategy; it is denial.

## Portfolio-Level Rules

1. **Drawdown budget is sacred** — Track current drawdown from portfolio peak continuously.
   When drawdown reaches 50% of \`max_drawdown_pct\`, reduce all new position sizes by half.
   When drawdown reaches 75% of the limit, stop opening new positions entirely.

2. **Daily loss limit** — If realized + unrealized losses today exceed \`max_daily_loss_pct\`,
   no new trades for the remainder of the session. Existing stops remain active.

3. **Correlation is concentration** — Two positions with >0.7 correlation count as a single
   position for concentration purposes. Three gold-related holdings are not "diversified
   in gold" — they are one concentrated gold bet.

4. **Cash is a position** — Cash earns risk-free return and provides optionality. Holding
   cash when opportunities are scarce is an active, intelligent decision — not a failure
   to find trades.

5. **Stress correlation** — In Risk-Off/Crisis regime, recalculate all concentration limits assuming 0.8 correlation between equity positions. Apparent diversification evaporates under stress.

## Never

- Never disable or widen a stop-loss to avoid being stopped out
- Never exceed position size limits "just this once" for a high-conviction trade
- Never ignore the daily loss limit because "the market will come back"
- Never treat unrealized gains as a cushion to take more risk
- Never hold a position past an invalidation trigger you identified in the thesis

See the Drawdown Recovery Table in CLAUDE.md frameworks section for the full loss-recovery math.
`,
  },
  {
    fileName: "learning-loop.md",
    content: `# Learning Loop

The fund's long-term edge comes from compounding knowledge, not just capital. Every session
must contribute to the learning loop: query history before trading, record lessons after.

## Before Every Trade

1. **Query the journal** — Use the Trade Memory skill to search for same-ticker, same-sector,
   and similar-setup trades. This is not optional. Ignoring available history is the single
   most expensive mistake in systematic trading.

2. **Check prediction accuracy** — Review your recent predictions (thesis outcomes, regime
   calls, price targets). If your hit rate is below 40% in the last 30 days, you are in a
   cold streak — reduce sizing and increase selectivity.

3. **Look for repeated mistakes** — If the journal shows you have lost money the same way
   before (e.g., holding through earnings, fighting the trend, adding to losers), that
   pattern is a hard veto on the current trade if it matches.

## After Every Session

1. **Update the journal** — Every trade executed or closed gets a journal entry with:
   thesis, entry/exit prices, P&L, what went right, what went wrong, and one actionable
   lesson. "Good trade" and "bad luck" are not acceptable lessons.

2. **Grade your process** — Rate each decision A-F based on process quality (not outcome).
   Track the distribution over time. If more than 20% of decisions grade below C, the
   process needs repair before the next session.

3. **Record regime assessment accuracy** — Compare your session-start regime call with
   actual market behavior. Over time, this calibrates your regime classification skill.

## Adaptation Principles

- **Win rate < 40% over 20+ trades** → Fundamentally reassess strategy, do not just
  reduce sizing. Something structural is wrong.
- **Win rate 40-50%** → Acceptable if average win > 1.5x average loss. Focus on
  improving entry timing and stop placement.
- **Win rate > 60%** → Verify you are not just trading in a favorable regime. Check
  if performance holds across different market conditions.
- **3 consecutive losses** → Mandatory pause. Review all three trades before the next
  entry. Reduce next position size by one conviction tier.
- **Sizing adjustment** — If the last 10 trades show average loss > 2x average win,
  reduce all sizes by 30% until the ratio improves.

## What the Journal Must Never Become

- A log of what happened (that is just a trade blotter, not learning)
- A collection of excuses ("market was irrational," "stop-loss was just hit before reversal")
- Empty ("No trades today" with no reflection on why or what was considered)

Every journal entry must answer: "What will I do differently next time in this situation?"
`,
  },
  {
    fileName: "market-awareness.md",
    content: `# Market Awareness

Why: Calendar events create binary risk that sizing alone cannot manage.

## Correlation Awareness

In normal markets, assets have their usual correlations. In stress markets, correlations
converge toward 1 — everything falls together. This means:

- Diversification benefits disappear exactly when you need them most
- A "diversified" portfolio of 5 correlated growth positions is actually one position
- The only true diversifiers in stress are: cash, short-duration treasuries, and gold
  (and even gold can fail in liquidity crises)

When regime is Risk-Off or Crisis, recalculate portfolio risk assuming all position
correlations are 0.8. If this concentrated-correlation portfolio would breach drawdown
limits, reduce immediately.

## Cash Management

Cash is not "uninvested capital" — it is an active position with specific benefits:
- Optionality to buy at lower prices if the market declines
- Reduced portfolio volatility and drawdown
- Psychological capacity to think clearly without panic

**Minimum cash floors by regime:** per fund baseline + regime adjustment (see Market Regime
skill table). Never let cash drop below the floor for a new position. If an existing position
appreciates and pushes cash below the floor, do not act immediately — but do not add
new positions until cash is replenished.

## Calendar Awareness

Key events that change the risk/reward landscape. Before trading, check if any of these
are within 24 hours:

| Event | Typical Impact | Action |
|-------|---------------|--------|
| **FOMC decision** | Vol spike, trend reversal possible | Reduce size or wait |
| **CPI/PPI release** | Rate expectations shift | Avoid rate-sensitive trades pre-release |
| **NFP (jobs report)** | Broad market move | Reduce exposure pre-release |
| **Earnings (held ticker)** | 5-15% gap possible | Decide before: hold through or exit before |
| **Options expiration** | Pin risk, gamma squeeze | Be aware of open interest at strikes |
| **Quad witching** | Elevated volume, whipsaws | Avoid initiating new positions |

If a major event is within 24 hours and the thesis does not explicitly account for it,
either wait or reduce size by 50%. "I will trade through it" is acceptable only if the
thesis includes a specific scenario for the event outcome.
`,
  },
  {
    fileName: "self-scheduling.md",
    content: `# Self-Scheduling

You can schedule follow-up sessions by writing to \`state/pending_sessions.json\`.

## When to Use
- You need to check a price level later (support/resistance break)
- You started an analysis but need fresh data in N minutes
- You placed a limit order and want to verify execution
- You want to review a position after a specific event window

## How
Read \`state/pending_sessions.json\` (create as \`[]\` if missing). Append an entry:

\`\`\`json
{
  "id": "<generate a unique id>",
  "type": "agent_followup",
  "focus": "<specific objective for the follow-up session>",
  "scheduled_at": "<ISO timestamp, minimum 5 min from now>",
  "created_at": "<current ISO timestamp>",
  "source": "agent",
  "max_turns": 10,
  "max_duration_minutes": 5,
  "priority": "normal"
}
\`\`\`

Then write the updated array back to \`state/pending_sessions.json\`.

## Limits
- Max 5 self-scheduled sessions per day
- Minimum 5 minutes between sessions
- Maximum 24 hours in the future
- max_turns must not exceed 25
- max_duration_minutes must not exceed 15
- Keep follow-ups short and focused — one objective per session
- Do NOT schedule follow-ups for routine work that the next regular session will handle

## Good Follow-Up Reasons
- "Check if GLD broke $420 support in the next 30 min"
- "Verify limit order for 50 shares GDXJ filled after market open"
- "Review portfolio after FOMC statement release at 14:30"

## Bad Follow-Up Reasons
- "Continue general analysis" (wait for next scheduled session)
- "Check market again" (too vague — what specifically?)
`,
  },
  {
    fileName: "communication.md",
    content: `# Communication

Why: Persisted artifacts (analysis, journal, reports, autonomous Telegram alerts)
stay in English so they remain consistent and searchable across sessions. Chat
responses mirror the user — answering in their language is the natural courtesy
and avoids forcing translation on either side.

## Rules
- **Chat responses: match the language of the user's most recent message.**
  If they write in Spanish, reply in Spanish. If English, reply in English.
  When in doubt or on the first turn with no clear signal, default to English.
- Telegram autonomous notifications (trade alerts, digests, milestones): English.
  These are pushed without a user prompt to mirror, so they follow the artifact
  default.
- analysis/*.md files: English
- Trade journal entries (reasoning, lessons_learned): English
- Session reports: English
- Quote financial data with ticker symbols and numbers in their natural form
  (e.g., "AAPL up 3.2% to $185.40" / "AAPL sube 3.2% a $185.40")
`,
  },
  {
    fileName: "session-init.md",
    content: `# Session Initialization — Mandatory Sequence

Before ANY analysis or action, complete these steps IN ORDER:

1. **Read handoff** — Read \`state/session-handoff.md\`. Understand what the last session did,
   what it deferred, and what it recommended for this session. If missing or stale (>24h),
   note this and proceed — you will rely more heavily on state files.

2. **Read state** — Read \`state/portfolio.json\` and \`state/objective_tracker.json\`.
   Know current positions, cash, total value, and objective progress.

3. **Read session log** — Read \`state/session_log.json\`. Check last session status, cost,
   timing. If the last session errored, investigate why before proceeding.

4. **Check pending** — Read \`state/pending_sessions.json\`. Was this session self-scheduled?
   If so, the reason is in the pending entry — address it.

5. **Verify state integrity** — Portfolio cash + sum(position market_values) should
   approximate total_value (within 2%). If not, investigate before trading.

6. **Write Session Contract** — Write a minimal handoff to \`state/session-handoff.md\` with
   your session contract:

   > Orient complete. Portfolio: $[cash] cash, [N] positions, [X]% toward objective.
   > Last session: [type] on [date], status [ok/error].
   > This session intent: [what you plan to do and why].

   This serves two purposes: confirms you completed Orient, and ensures the next session
   has context even if this session is interrupted.

7. **Review watchlist** — Before moving to analysis, consult the workspace watchlist for any candidates
   surfaced by screens.

   Call the \`screener.watchlist_query\` tool twice:

   1. \`{ fund: "<this fund's name>", status: ["candidate", "watching"], limit: 20 }\` — fresh and established candidates eligible for this fund.
   2. \`{ fund: "<this fund's name>", status: ["fading"], limit: 20 }\` — names that were previously active but are cooling off.

   For each entry whose status changed since the timestamp of the prior
   \`session-handoff.md\`, note the transition in the Session Contract under a
   **Watchlist updates** heading (ticker, old → new status, reason). Fresh
   candidates and any \`fading → watching\` re-entries become primary inputs to the
   Analyze phase. If the watchlist is empty (common in a freshly initialised
   workspace until the first screen run completes), record that and proceed
   without it — the screen will populate on its next daily cycle.

Only after completing all 7 steps, proceed with analysis.

## Session-Type Priorities

After Orient, prioritize based on session type:

- **pre-market**: Overnight developments, regime check, plan today's actions, set alerts
- **mid-session**: Verify morning thesis still valid, check price levels, execute if triggers hit
- **post-market**: Close-of-day review, full reflection, comprehensive handoff for tomorrow
- **catch-up**: Understand what was missed, compressed analysis, flag anything urgent
- **pending (self-scheduled)**: Address the specific reason this session was scheduled
- **chat (interactive)**: Read handoff for context, then respond to user's needs

## Analysis Reuse

After Orient, before launching sub-agents, check \`analysis/\` for assessments from
the last 4 hours. If a market-assessment exists from today and conditions have not changed
materially, you may reference it instead of re-running the market-analyst. This saves turns
and cost.

Reuse criteria: same trading day, no major news since assessment, regime has not shifted.
`,
  },
  {
    fileName: "session-completion.md",
    content: `# Session Completion — Verification Required

Before ending any session, verify ALL of the following:

1. **Data-backed claims**: Every recommendation or assessment made this session has
   supporting data retrieved from a tool call THIS session. No claims from memory or
   prior sessions without fresh verification.

2. **Trade integrity**: If trades were executed, verify:
   - \`portfolio.json\` reflects the trades (read it back)
   - Trade journal entry exists with thesis, stop-loss, and R-value
   - Telegram notification was sent

3. **Analysis quality**: If analysis was written to \`analysis/\`, verify it contains
   specific numbers, dates, and sources. Flag and fix any vague language.

4. **Handoff written**: \`state/session-handoff.md\` has been updated with the full
   handoff (not just the contract from Orient).

5. **Reflection completed**: Session Reflection skill has been run. Even "nothing
   happened" sessions require reflection on why inaction was chosen and whether
   it was correct.

6. **Objective tracker current**: \`state/objective_tracker.json\` reflects current
   portfolio value and progress.

7. **Contract evaluated**: The Session Contract from Orient has been compared against
   actual outcomes in the reflection.

If any check fails, address it before ending. Do not skip checks because "the session
is running low on turns" — an incomplete handoff costs more than an extra turn.
`,
  },
];

/**
 * Write behavioral rules to a fund's .claude/rules/ directory.
 * Called during fund creation and upgrade.
 */
export async function ensureFundRules(fundClaudeDir: string): Promise<void> {
  const rulesDir = join(fundClaudeDir, "rules");
  await mkdir(rulesDir, { recursive: true });
  for (const rule of FUND_RULES) {
    await writeFile(join(rulesDir, rule.fileName), rule.content, "utf-8");
  }
}

/** Returns the number of per-fund rules */
export function getFundRuleCount(): number {
  return FUND_RULES.length;
}

/**
 * Write the create-fund skill to ~/.fundx/.claude/skills/.
 * Called during workspace initialization.
 */
export async function ensureWorkspaceSkillFiles(): Promise<void> {
  await ensureSkillFiles(WORKSPACE_CLAUDE_DIR, [WORKSPACE_SKILL]);
}

// ── Per-Fund Memory ───────────────────────────────────────────

export interface MemoryFile {
  fileName: string;
  description: string;
  content: string;
}

export const FUND_MEMORY_FILES: MemoryFile[] = [
  {
    fileName: "MEMORY.md",
    description: "Index of memory files",
    content: `# Fund Memory

Memory files for this fund. Updated by the AI agent during sessions.

- [market-lessons.md](market-lessons.md) — Market patterns and lessons learned
- [trading-patterns.md](trading-patterns.md) — Trading behavior observations
- [fund-notes.md](fund-notes.md) — General fund observations
`,
  },
  {
    fileName: "market-lessons.md",
    description: "Market patterns and lessons learned",
    content: `---
description: Market patterns and lessons learned by the AI agent
---

(No observations yet. The AI agent will populate this during trading sessions.)
`,
  },
  {
    fileName: "trading-patterns.md",
    description: "Trading behavior observations",
    content: `---
description: Trading behavior observations and recurring patterns
---

(No observations yet. The AI agent will populate this during trading sessions.)
`,
  },
  {
    fileName: "fund-notes.md",
    description: "General fund observations",
    content: `---
description: General observations about this fund's performance and strategy
---

(No observations yet. The AI agent will populate this during trading sessions.)
`,
  },
];

export const MEMORY_USAGE_RULE = {
  fileName: "memory-usage.md",
  content: `# Memory Usage

You have a persistent memory system in the \`memory/\` directory at the fund root.

## At Session Start
Read \`memory/MEMORY.md\` to see what memory files exist. Read individual files
as relevant to the current session's focus.

## During Sessions
When you discover something worth remembering across sessions, write it to the
appropriate memory file:
- \`memory/market-lessons.md\` — Market patterns, sector behavior, macro observations
- \`memory/trading-patterns.md\` — What works/doesn't for this fund, entry/exit timing
- \`memory/fund-notes.md\` — Strategy adjustments, risk observations, general notes

## Rules
- Keep entries concise and actionable — facts and lessons, not raw data
- Do not duplicate information already in CLAUDE.md, fund_config.yaml, or state files
- State files (portfolio.json, objective_tracker.json, trade_journal.sqlite) are for
  current state. Memory is for learned patterns and observations that inform future decisions.
- Prefix each entry with a date (YYYY-MM-DD) for context
`,
};

/**
 * Write memory files and memory-usage rule to a fund directory.
 * Called during fund creation and upgrade. Idempotent — does not overwrite existing memory.
 */
export async function ensureFundMemory(fundRoot: string, fundClaudeDir: string): Promise<void> {
  const memoryDir = join(fundRoot, "memory");
  await mkdir(memoryDir, { recursive: true });

  for (const file of FUND_MEMORY_FILES) {
    const filePath = join(memoryDir, file.fileName);
    if (!existsSync(filePath)) {
      await writeFile(filePath, file.content, "utf-8");
    }
  }

  // Write the memory-usage rule
  const rulesDir = join(fundClaudeDir, "rules");
  await mkdir(rulesDir, { recursive: true });
  const rulePath = join(rulesDir, MEMORY_USAGE_RULE.fileName);
  await writeFile(rulePath, MEMORY_USAGE_RULE.content, "utf-8");
}
