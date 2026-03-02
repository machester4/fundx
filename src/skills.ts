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
 * Built-in trading analysis skills derived from the TradingAgents framework (arXiv:2412.20138).
 *
 * These go in each fund's .claude/skills/<dirName>/SKILL.md and are loaded
 * automatically by the Agent SDK via settingSources: ["project"].
 *
 * The autonomous agent reads skill descriptions at session start and invokes
 * full skill content when needed — no rigid pipeline, agent-directed reasoning.
 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    name: "Investment Debate",
    dirName: "investment-debate",
    description: "Conduct a structured bull vs bear dialectical debate with data, rebuttals, and quantitative scoring before any significant trade decision",
    content: `# Investment Debate (Bull vs Bear)

Based on the TradingAgents framework (arXiv:2412.20138) — adapted for single-agent
dialectical reasoning with multi-round structure, quantitative scoring, and
devil's advocate discipline.

## When to Use
Before any significant trade decision — opening a new position, substantially increasing
an existing one, or making a major allocation change. Skip for minor rebalances or
stop-loss exits where speed matters.

## Prerequisites — Data Before Debate
<HARD-GATE>
Do NOT begin the debate without real data. You must have gathered at least:
1. Current price, recent price action, and key technical levels (from market-data MCP)
2. Relevant news or catalysts from the last 7 days (from market-data or web search)
3. Current portfolio state (from state/portfolio.json)
4. Fund objective progress (from state/objective_tracker.json)

If sub-agent analyst reports are available (macro, technical, sentiment, news, risk),
use them as primary input. The debate must argue from evidence, not assumptions.
</HARD-GATE>

## Technique

### Round 1 — Opening Arguments

**Step 1A — Bull Case**
Argue FOR the trade. Every argument must cite a specific data point:
- Price action evidence: exact levels, % moves, volume (from market-data)
- Fundamental catalyst: specific event, date, expected impact
- How this trade advances the fund's objective — quantify if possible
- Historical precedent: query trade journal for similar setups and their outcomes

Score each argument on strength (1-5):
- 5: Hard data directly supports the claim
- 4: Strong indirect evidence
- 3: Reasonable inference from available data
- 2: Plausible but relies on assumptions
- 1: Speculative, no supporting data

**Step 1B — Bear Case**
Argue AGAINST the trade. For every bull argument, provide a specific counter:
- For each bull point, identify what data it ignores or misreads
- Quantify the downside: what is the max realistic loss?
- Identify the most likely failure scenario (not worst-case, most probable)
- Check: has the fund been wrong in similar setups before? (query trade journal)
- What would need to be true for this trade to fail? How likely is that?

Score each argument on strength (1-5) using the same scale.

### Round 2 — Rebuttals

**Step 2A — Bull Rebuttal**
Address the bear case's strongest point (highest-scored argument):
- Can you refute it with additional data?
- If you cannot refute it, explicitly concede and adjust your thesis
- Does the bear's strongest concern change the risk/reward materially?

**Step 2B — Bear Rebuttal**
Address the bull case's strongest point (highest-scored argument):
- Is the bull's best evidence as strong as it appears?
- What alternative explanation exists for the same data?
- If the bull's strongest point holds, is it sufficient to justify the trade?

### Round 3 — Devil's Advocate

Before judging, attempt to destroy your own preferred conclusion:
- If you're leaning bullish: generate the single most devastating bear argument
  you haven't considered yet. A scenario that would make this trade a clear loss.
- If you're leaning bearish: generate the single strongest bull argument you
  haven't considered. A scenario that would make skipping this trade a clear mistake.
- If this new argument scores 4+ on the strength scale, you must incorporate it
  into your final judgment.

### Round 4 — Quantitative Judgment

Do NOT use vague language like "the bull case was stronger." Use this framework:

**Evidence Score** = (sum of bull argument scores) vs (sum of bear argument scores)
- Bull total significantly higher (>30% gap): Bullish
- Bear total significantly higher (>30% gap): Bearish
- Within 30%: Genuinely contested — default to caution

**Concession Impact**: Did either side concede a major point in rebuttals?
- Bull conceded: subtract 3 from bull total
- Bear conceded: subtract 3 from bear total
- Both conceded: both weaker — increase caution

**Devil's Advocate Impact**: Did the Round 3 argument score 4+?
- Yes: reduce confidence by one level regardless of direction

**Confidence Calibration** (0.0 to 1.0):
- 0.8-1.0: Overwhelming evidence one direction, no concessions, devil's advocate failed
- 0.6-0.8: Strong evidence, minor concessions, thesis intact after rebuttals
- 0.4-0.6: Genuinely contested, meaningful points on both sides
- 0.2-0.4: Weak thesis, significant concessions, devil's advocate scored high
- 0.0-0.2: Should not trade — no clear edge

**Decision Threshold by Fund Type:**
- Runway funds: Only trade if confidence >= 0.7 (capital preservation priority)
- Growth funds: Trade if confidence >= 0.5 (accept more uncertainty for upside)
- Income funds: Only trade if confidence >= 0.6 (protect income streams)
- Accumulation funds: Trade if confidence >= 0.5 (focus on target asset acquisition)

### Round 5 — Risk Integration

Before finalizing, apply the risk assessment (invoke risk-matrix skill or evaluate inline):
- Does the position size respect max_position_pct?
- Would a loss breach max_drawdown_pct?
- What is the max dollar loss if stop-loss triggers?
- Does the portfolio become too concentrated after this trade?

If any constraint is violated, the trade fails regardless of debate outcome.

## Trade Journal Integration
Before AND after the debate:
- **Before**: Query \`state/trade_journal.sqlite\` for past trades in the same symbol
  or similar setups. What happened? What lessons were recorded?
- **After**: If the trade proceeds, log the debate verdict, confidence score, and
  key arguments so future sessions can reference this debate's quality.

## Output Format
In your analysis report, document the debate under a "## Investment Debate" section:

\`\`\`
### Round 1 — Opening Arguments
**Bull Case** (total score: X/Y)
1. [Argument] — strength: N/5
2. [Argument] — strength: N/5
...

**Bear Case** (total score: X/Y)
1. [Argument] — strength: N/5
2. [Argument] — strength: N/5
...

### Round 2 — Rebuttals
**Bull rebuttal** to bear's strongest point: [response]
**Bear rebuttal** to bull's strongest point: [response]
Concessions: [any conceded points]

### Round 3 — Devil's Advocate
Preferred direction: [bullish/bearish]
Counter-argument: [the strongest argument against your preference]
Counter strength: N/5

### Round 4 — Verdict
Evidence score: Bull X vs Bear Y
Concession adjustments: [if any]
Devil's advocate impact: [if any]
**Direction: [bullish / bearish / neutral]**
**Confidence: [0.0-1.0]**
**Decision: [TRADE / NO TRADE / REDUCE SIZE]**
Fund objective alignment: [how this serves the fund's goal]

### Round 5 — Risk Check
Position size: X% (max: Y%)
Stop-loss: X% (limit: Y%)
Max dollar loss: $X
Constraint compliance: [PASS/FAIL]
\`\`\`
`,
  },
  {
    name: "Risk Assessment Matrix",
    dirName: "risk-matrix",
    description: "Quantitative pre-execution risk check: expected value calculation, portfolio impact analysis, correlation check, and hard constraint validation before any trade",
    content: `# Risk Assessment Matrix (Quantitative Pre-Execution)

This is the FINAL gate between decision and execution. The investment-debate decides
IF you should trade. This skill decides the exact SIZE, STOP, and whether portfolio
constraints allow it.

## When to Use
After investment-debate produces a TRADE or REDUCE SIZE verdict, BEFORE placing
any order. This skill produces the exact order parameters.

## Prerequisites
You must have before starting:
1. The investment-debate verdict and confidence score (0.0-1.0)
2. Current portfolio from \`state/portfolio.json\` (positions, cash, total value)
3. Current price and recent volatility for the target symbol (from market-data MCP)
4. Fund risk constraints from CLAUDE.md (max_drawdown_pct, max_position_pct, stop_loss_pct)

## Technique

### Step 1 — Expected Value Calculation

Estimate the trade's expected value using debate outputs:

\`\`\`
Define:
  P(win)  = debate confidence score (e.g. 0.7)
  P(loss) = 1 - P(win)
  R(win)  = estimated gain if thesis plays out (in $ or %)
  R(loss) = loss at stop-loss level (in $ or %)

Expected Value = P(win) × R(win) - P(loss) × R(loss)
Risk/Reward Ratio = R(win) / R(loss)
\`\`\`

**Decision rules:**
- EV must be positive to proceed
- Risk/Reward must be >= 2:1 for runway/income funds, >= 1.5:1 for growth/accumulation
- If EV is positive but Risk/Reward is below threshold → reduce size or widen target

### Step 2 — Position Sizing (invoke position-sizing skill)

Use the position-sizing skill to determine the base allocation. This step produces
the initial position size before portfolio-level adjustments.

### Step 3 — Portfolio Impact Analysis

Calculate how the new position changes the portfolio:

\`\`\`
Current positions: read from state/portfolio.json
New allocation = proposed_size / total_portfolio_value

After-trade portfolio:
- Cash remaining = current_cash - (proposed_size)
- Cash % = cash_remaining / total_portfolio_value
- Largest position % = max(existing_position_pcts, new_allocation)
- Number of positions = current_count + 1
\`\`\`

**Checks:**
- Cash % after trade >= 10% for runway funds, >= 5% for others
- No single position > max_position_pct from fund config
- Total invested (non-cash) <= 90% for runway, 95% for others

### Step 4 — Correlation Check

Assess overlap with existing positions:
- Is the new symbol in the same sector as an existing position?
- Do existing holdings move in the same direction (correlated)?
- If adding a position correlated with existing ones:
  combined_exposure = existing_pct + new_pct
  If combined_exposure > max_position_pct × 1.5 → reduce or skip

Use \`get_company_profile\` from market-data MCP to check sector/industry.
If the fund holds sector ETFs, check for underlying overlap.

### Step 5 — Hard Constraint Validation

Every item must PASS or the trade is BLOCKED:

| Constraint | Formula | Source |
|-----------|---------|--------|
| Max position size | new_allocation <= max_position_pct | fund_config.yaml |
| Max drawdown headroom | current_drawdown + max_loss < max_drawdown_pct | fund_config.yaml |
| Stop-loss set | stop_price is defined and <= stop_loss_pct below entry | fund_config.yaml |
| Max daily loss | today's realized losses + max_loss < max_daily_loss_pct | fund_config.yaml |
| Cash reserve | cash_after >= minimum per fund type | Step 3 |

If ANY constraint fails → **BLOCK the trade**. Do not override. Log which constraint
failed and what adjustment would be needed to pass.

### Step 6 — Final Order Parameters

If all checks pass, output exact order details:

\`\`\`
Symbol: [ticker]
Side: [buy/sell]
Quantity: [shares] (= position_size / current_price, rounded down)
Order type: [market/limit]
Limit price: [if limit order]
Stop-loss: $[price] ([X]% below entry)
Max loss: $[amount] ([X]% of portfolio)
Expected value: $[EV]
Risk/Reward: [X]:1
\`\`\`

## Output Format
Document under a "## Risk Assessment" section:

\`\`\`
### Expected Value
P(win): X | R(win): X% | P(loss): X | R(loss): X%
EV: $X (X%) | Risk/Reward: X:1 | PASS/FAIL

### Position Size
[From position-sizing skill output]

### Portfolio Impact
Cash after: $X (X%) | Largest position: X% | Positions: N
Correlation flag: [none / moderate / high]

### Constraint Validation
| Constraint | Value | Limit | Status |
|-----------|-------|-------|--------|
| Position size | X% | Y% | PASS |
| Drawdown room | X% | Y% | PASS |
| Stop-loss | X% | Y% | PASS |
| Daily loss | X% | Y% | PASS |
| Cash reserve | X% | Y% | PASS |

### Order
[Exact order parameters if all PASS, or BLOCKED with reason]
\`\`\`
`,
  },
  {
    name: "Trade Journal Review",
    dirName: "trade-memory",
    description: "Query trade journal SQLite database and FTS5 search to find relevant past trades, calculate win rates, and apply historical lessons before making a new trade",
    content: `# Trade Journal Review (Historical Memory)

This skill is about LOOKING UP history before trading. It is not about writing
journal entries — that happens in session-reflection.

## When to Use
- Before any trade: check if you have traded this symbol or a similar setup before
- When the investment-debate needs historical evidence
- When market conditions remind you of a past scenario
- To calculate your actual win rate for a specific trade type

## Database Schema

The trade journal lives at \`state/trade_journal.sqlite\` with this schema:

\`\`\`sql
trades (
  id INTEGER PRIMARY KEY,
  timestamp TEXT,          -- ISO 8601
  fund TEXT,               -- fund name
  symbol TEXT,             -- ticker
  side TEXT,               -- 'buy' or 'sell'
  quantity REAL,
  price REAL,
  total_value REAL,
  order_type TEXT,         -- 'market', 'limit', 'stop', etc.
  session_type TEXT,       -- 'pre_market', 'mid_session', 'post_market'
  reasoning TEXT,          -- why the trade was made
  analysis_ref TEXT,       -- path to analysis file
  closed_at TEXT,          -- when position was closed (NULL if open)
  close_price REAL,
  pnl REAL,               -- realized P&L in dollars
  pnl_pct REAL,           -- realized P&L in percent
  lessons_learned TEXT,    -- post-mortem notes
  market_context TEXT      -- regime, VIX, etc. at time of trade
)

-- FTS5 full-text search index (auto-synced via triggers):
trades_fts (trade_id, symbol, side, reasoning, market_context, lessons_learned)
\`\`\`

## Technique

### Query 1 — Same Symbol History

Before trading a symbol, run:

\`\`\`sql
SELECT symbol, side, price, close_price, pnl, pnl_pct,
       reasoning, lessons_learned, timestamp, closed_at
FROM trades
WHERE symbol = '{SYMBOL}' AND fund = '{FUND}'
ORDER BY timestamp DESC
LIMIT 10;
\`\`\`

**Extract:**
- How many times have you traded this? Win/loss record?
- What was your reasoning last time? Was it correct?
- Any lessons_learned that apply to the current situation?

### Query 2 — Win Rate by Trade Type

If you can classify your trade type (momentum, mean-reversion, breakout, earnings play):

\`\`\`sql
SELECT
  COUNT(*) as total,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
  SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
  AVG(pnl_pct) as avg_return,
  AVG(CASE WHEN pnl > 0 THEN pnl_pct ELSE NULL END) as avg_win,
  AVG(CASE WHEN pnl <= 0 THEN pnl_pct ELSE NULL END) as avg_loss
FROM trades
WHERE fund = '{FUND}' AND closed_at IS NOT NULL
  AND reasoning LIKE '%{TRADE_TYPE}%';
\`\`\`

**Use this to calibrate conviction:** If your win rate on momentum trades is 40%,
don't assign 0.8 confidence to a new momentum trade.

### Query 3 — FTS5 Semantic Search

For finding trades with similar reasoning or market context, use full-text search:

\`\`\`sql
SELECT t.symbol, t.side, t.reasoning, t.lessons_learned,
       t.pnl, t.pnl_pct, t.market_context
FROM trades_fts fts
JOIN trades t ON t.id = CAST(fts.trade_id AS INTEGER)
WHERE trades_fts MATCH '"rising VIX" OR "defensive rotation"'
  AND t.fund = '{FUND}'
ORDER BY fts.rank
LIMIT 5;
\`\`\`

**Use this when:** You want to find trades made in similar market conditions,
regardless of symbol. For example, "what happened last time I traded during
a VIX spike?" or "how did my breakout trades perform in low-vol regimes?"

### Query 4 — Overall Fund Performance

Get the big picture before making decisions:

\`\`\`sql
SELECT
  COUNT(*) as total_trades,
  SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
  ROUND(100.0 * SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) as win_rate,
  ROUND(SUM(pnl), 2) as total_pnl,
  ROUND(AVG(pnl_pct), 2) as avg_return_pct
FROM trades
WHERE fund = '{FUND}' AND closed_at IS NOT NULL;
\`\`\`

## Similarity Criteria

Two trades are "similar" when they share 2+ of these:
1. **Same sector** (e.g., both tech stocks)
2. **Same trade type** (momentum, mean-reversion, breakout, earnings)
3. **Same market regime** (both during Risk-Off, both during high vol)
4. **Similar reasoning** (FTS5 match score > 0.5)
5. **Similar time horizon** (both intraday, both swing, both position)

## Decision Rules

After gathering history:

- **Win rate < 40% on this trade type?** → Lower conviction by one level
- **Lost money on this exact symbol last time?** → Read lessons_learned carefully.
  If the current setup repeats the same pattern that caused the loss, skip.
- **No history at all?** → That's fine, but note it. First trades in a symbol
  deserve smaller sizing (50-75% of normal).
- **Strong lessons_learned entry matches current situation?** → Apply the lesson
  explicitly. Quote it in your analysis.

## Output Format
Include a "## Trade History Context" section in your analysis:

\`\`\`
### Symbol History: {SYMBOL}
Trades found: N | Win rate: X% | Avg return: X%
Last trade: [date] [side] @ $X → P&L: $X (X%)
Last lesson: "[quoted lessons_learned]"

### Similar Setups (FTS5)
- [date] [symbol] [side]: [reasoning summary] → P&L: X%
  Lesson: "[quoted]"
- ...

### Win Rate for This Trade Type
Type: [momentum/breakout/etc] | Trades: N | Win rate: X%
Avg win: +X% | Avg loss: -X%

### Historical Adjustment
[How history influenced your conviction / sizing / decision]
\`\`\`
`,
  },
  {
    name: "Market Regime Detection",
    dirName: "market-regime",
    description: "Classify the current market regime using concrete data from MCP tools, score indicators quantitatively, and persist the regime for cross-session tracking",
    content: `# Market Regime Detection

## When to Use
At the start of every session, especially pre-market. The regime classification must
be completed BEFORE any trading analysis or decisions. Other skills (investment-debate,
position-sizing) reference the current regime.

## Prerequisites — Data Gathering
<HARD-GATE>
You must gather real data before classifying. Do NOT guess the regime from memory
or assumptions. Use the market-data MCP tools listed below for each indicator.
</HARD-GATE>

## Technique

### Step 1 — Gather Indicator Data

For each indicator, use the specified MCP tool and record the raw value:

| Indicator | MCP Tool | What to Get |
|-----------|----------|-------------|
| VIX level | \`get_quote\` symbol="^VIX" (or \`get_bars\` for trend) | Current level + 5-day direction |
| S&P 500 trend | \`get_bars\` symbol="SPY" timeframe="1Day" limit=200 | Price vs 50-day and 200-day SMA |
| Market breadth | \`get_market_movers\` | Ratio of gainers vs losers, volume distribution |
| Sector rotation | \`get_sector_performance\` | Which sectors lead (cyclical vs defensive) |
| Volatility trend | \`get_bars\` symbol="SPY" timeframe="1Day" limit=20 | Calculate 20-day realized vol (stddev of daily returns × √252) |
| News catalyst | \`get_economic_calendar\` | Upcoming FOMC, CPI, NFP in next 7 days |

### Step 2 — Score Each Indicator

Rate each indicator on a -2 to +2 scale:

| Score | Meaning | Example |
|-------|---------|---------|
| +2 | Strongly risk-on | VIX < 15 and falling |
| +1 | Mildly risk-on | SPY above 50-day SMA, cyclicals leading |
| 0 | Neutral / mixed | Mixed signals, no clear direction |
| -1 | Mildly risk-off | VIX 25-35, defensive sectors outperforming |
| -2 | Strongly risk-off | VIX > 35, SPY below 200-day SMA, breadth collapsing |

**VIX scoring guide** (compare to its own 20-day average, not fixed thresholds):
- Current < 80% of 20-day avg → +2 (vol compressing, complacency)
- Current 80-100% of avg → +1 (normal, calm)
- Current 100-120% of avg → 0 (slightly elevated)
- Current 120-150% of avg → -1 (rising fear)
- Current > 150% of avg → -2 (crisis / panic)

**Trend scoring guide:**
- Price > 50-day SMA > 200-day SMA → +2 (strong uptrend)
- Price > 50-day SMA, 50-day > 200-day → +1 (uptrend)
- Price between 50-day and 200-day → 0 (mixed)
- Price < 50-day SMA, 50-day < 200-day → -1 (downtrend)
- Price < 200-day SMA and falling → -2 (strong downtrend)

### Step 3 — Classify Regime

Sum all indicator scores to get the Regime Score:

| Regime Score | Classification | Description |
|-------------|---------------|-------------|
| +8 to +12 | **Strong Risk-On** | All signals aligned bullish |
| +3 to +7 | **Risk-On** | Most signals bullish, minor concerns |
| -2 to +2 | **Transition** | Mixed signals, regime unclear |
| -7 to -3 | **Risk-Off** | Most signals bearish, caution warranted |
| -12 to -8 | **Strong Risk-Off** | All signals aligned bearish, capital preservation mode |

**Volatility overlay** (independent of direction):
- 20-day realized vol > 25% annualized → add "High Volatility" tag
- 20-day realized vol < 10% annualized → add "Low Volatility" tag
- Upcoming major macro event in next 48h → add "Event Risk" tag

### Step 4 — Strategy Implications

Based on the regime, set session-level constraints:

| Regime | Max New Position Size | Max Total Deployment | Action Bias |
|--------|----------------------|---------------------|-------------|
| Strong Risk-On | max_position_pct | 90% of portfolio | Build positions |
| Risk-On | max_position_pct × 0.75 | 80% of portfolio | Normal trading |
| Transition | max_position_pct × 0.5 | 60% of portfolio | Small or no new positions |
| Risk-Off | max_position_pct × 0.25 | 40% of portfolio | Reduce exposure |
| Strong Risk-Off | No new longs | 20% of portfolio | Raise cash, defensive only |

**Fund type adjustments:**
- Runway funds: shift one level more conservative (Risk-On → Transition behavior)
- Growth funds: use table as-is
- Income funds: shift one level more conservative
- Accumulation funds: use table as-is (DCA through regimes)

### Step 5 — Persist Regime

Write the regime classification to the session analysis file so:
- Other skills can reference it (investment-debate, position-sizing)
- Future sessions can track regime transitions
- The session reflection can compare today's regime vs. yesterday's

Include in the analysis file header:
\`\`\`
Regime: [classification] (score: [X])
Volatility tag: [High/Low/Normal]
Event risk: [Yes/No — event name if yes]
Previous regime: [from last session analysis, if available]
Regime change: [Yes/No]
\`\`\`

## Output Format
Start your analysis report with a "## Market Regime" section:

\`\`\`
### Indicator Scores
| Indicator | Raw Value | Score | Notes |
|-----------|-----------|-------|-------|
| VIX | 18.5 (avg: 16.2) | -1 | 14% above avg |
| S&P trend | Above 50d, above 200d | +2 | Strong uptrend |
| Breadth | 65% advancers | +1 | Broad participation |
| Sectors | Tech +1.2%, Utils -0.5% | +1 | Cyclicals leading |
| Realized vol | 14% ann. | 0 | Normal range |
| Events | CPI in 3 days | 0 | Event risk flagged |

### Classification
Regime Score: +3 → **Risk-On**
Tags: Event Risk (CPI Thursday)
Previous: Risk-On (no change)

### Session Constraints
Max new position: X% | Max deployment: 80% | Bias: Normal trading
\`\`\`
`,
  },
  {
    name: "Position Sizing",
    dirName: "position-sizing",
    description: "Calculate exact position size from debate confidence score, fund type adjustments, portfolio state, and Kelly criterion cross-check",
    content: `# Position Sizing (Quantitative)

## When to Use
Whenever determining how much capital to allocate to a trade. This skill is
invoked by the risk-matrix skill as Step 2, or standalone if doing a quick sizing.

## Input Required
You must have before starting:
1. **Debate confidence score** (0.0-1.0) from the investment-debate skill
2. **Current portfolio** from \`state/portfolio.json\` (cash, positions, total value)
3. **Fund risk constraints** from CLAUDE.md (max_position_pct, max_drawdown_pct, stop_loss_pct)
4. **Current market regime** from market-regime skill (affects sizing caps)

## Technique

### Step 1 — Map Confidence to Base Size

Use the investment-debate confidence score directly (do NOT re-assess conviction):

| Confidence | Base Size (% of portfolio) | Rationale |
|-----------|--------------------------|-----------|
| 0.8 - 1.0 | 12-15% | Overwhelming evidence, all signals aligned |
| 0.6 - 0.8 | 6-12% | Strong evidence, minor concerns |
| 0.5 - 0.6 | 3-6% | Minimum for a trade — borderline conviction |
| < 0.5 | 0% | Do not trade — below minimum threshold |

Interpolate within ranges: confidence 0.7 → ~9% base size.

### Step 2 — Fund Type Adjustment

Apply a multiplier based on fund objective:

| Fund Type | Multiplier | Hard Cap | Rationale |
|-----------|-----------|----------|-----------|
| Runway | × 0.5 | max_loss ≤ 1 month of burn | Capital preservation is primary |
| Growth | × 1.0 | None beyond constraints | Accept risk for upside |
| Income | × 0.7 | Size by yield contribution | Protect income streams |
| Accumulation | × 1.0 | Size by target asset qty | Focus on accumulation pace |

**Runway special rule:** Calculate:
\`\`\`
monthly_burn = from fund_config.yaml objective.monthly_burn
max_risk_per_trade = monthly_burn × 1.0
max_position = max_risk_per_trade / stop_loss_pct
If adjusted_size > max_position → use max_position
\`\`\`

### Step 3 — Portfolio State Adjustment

Apply multipliers based on current conditions:

| Condition | Check | Adjustment |
|-----------|-------|-----------|
| Near max drawdown | current_drawdown > max_drawdown_pct × 0.7 | × 0.5 |
| High deployment | invested > 75% of portfolio | × 0.7 |
| Concentrated | any position > max_position_pct × 0.8 | × 0.8 |
| Correlated exposure | new + existing same-sector > 20% | × 0.6 |
| Objective nearly achieved | progress > 80% | × 0.5 |

**Apply all that match** — multipliers stack:
\`\`\`
adjusted_size = base_size × fund_multiplier × state_adj1 × state_adj2 × ...
\`\`\`

### Step 4 — Regime Adjustment

Apply the session constraint from market-regime skill:

| Regime | Max New Position |
|--------|-----------------|
| Strong Risk-On | max_position_pct |
| Risk-On | max_position_pct × 0.75 |
| Transition | max_position_pct × 0.5 |
| Risk-Off | max_position_pct × 0.25 |
| Strong Risk-Off | 0% (no new longs) |

If adjusted_size > regime cap → use regime cap.

### Step 5 — Kelly Criterion Cross-Check (Optional)

If you have enough trade history (20+ closed trades), calculate Kelly:

\`\`\`
Query from trade journal:
  win_rate = winning_trades / total_closed_trades
  avg_win = average pnl_pct of winning trades
  avg_loss = average |pnl_pct| of losing trades
  b = avg_win / avg_loss  (win/loss ratio)

Kelly fraction: f* = win_rate - (1 - win_rate) / b
Half-Kelly (safer): f*/2

If adjusted_size > half_Kelly × portfolio_value → flag as oversized
\`\`\`

Kelly is a CROSS-CHECK, not the primary sizing method. If your conviction-based
size exceeds half-Kelly by more than 2×, reduce to half-Kelly.

If fewer than 20 closed trades, skip this step — not enough data.

### Step 6 — Final Calculation

\`\`\`
final_size_pct = min(adjusted_size, max_position_pct, regime_cap)
position_dollars = final_size_pct × total_portfolio_value
shares = floor(position_dollars / current_price)
actual_allocation = (shares × current_price) / total_portfolio_value

stop_price = current_price × (1 - stop_loss_pct / 100)
max_loss_dollars = shares × (current_price - stop_price)
max_loss_pct = max_loss_dollars / total_portfolio_value × 100
\`\`\`

## Output Format
Document under a "## Position Sizing" section:

\`\`\`
### Sizing Calculation
Debate confidence: 0.72
Base size: 9.6%
Fund adjustment (runway × 0.5): 4.8%
State adjustments: × 0.7 (high deployment) = 3.4%
Regime cap (Risk-On): 18.75% → no reduction
Kelly cross-check: f*/2 = 5.1% → no flag (3.4% < 5.1%)

### Final Position
Size: 3.4% ($3,400 of $100,000 portfolio)
Shares: 17 @ $198.50
Actual allocation: 3.38%
Stop-loss: $182.62 (8% below entry)
Max loss: $270 (0.27% of portfolio)
\`\`\`
`,
  },
  {
    name: "Session Reflection",
    dirName: "session-reflection",
    description: "End-of-session review: grade every decision, audit biases with specific tests, write journal entries, compare vs benchmark, and update objective progress",
    content: `# Session Reflection (Post-Session Learning)

## When to Use
At the end of every session, after all trades and analysis are complete.
This is the LAST thing you do before the session ends. Non-negotiable.

## Prerequisites
Before starting reflection, gather:
1. Read today's analysis file from \`analysis/\` (compare intentions vs. actions)
2. Read \`state/portfolio.json\` for current positions and values
3. Read \`state/objective_tracker.json\` for goal progress
4. Get SPY performance today via \`get_bars\` (benchmark comparison)

## Technique

### Step 1 — Decision Audit

For each trade executed this session, grade it:

| Dimension | 1 (Poor) | 2 (Okay) | 3 (Good) |
|-----------|----------|----------|----------|
| **Thesis quality** | Vague or no clear thesis | Reasonable but incomplete | Specific, data-backed, falsifiable |
| **Entry timing** | Chased price, entered at resistance | Acceptable but not optimal | Entered at support, waited for confirmation |
| **Position sizing** | Too large or too small vs. conviction | Reasonable but not calculated | Sized per position-sizing skill |
| **Risk management** | No stop-loss or violated constraints | Stop set but loose | Tight stop, within all constraints |

**Score = sum of all dimensions (4-12 per trade):**
- 10-12: Excellent execution
- 7-9: Acceptable
- 4-6: Poor — write detailed lessons_learned

For trades you DECIDED AGAINST — also grade the decision:
- Was it right not to trade? (Did the price move against the trade thesis?)
- Was it a missed opportunity? (Did the trade thesis play out?)
- Action bias check: did you skip because of inertia, not analysis?

### Step 2 — Thesis Validation (Active Positions)

For EVERY active position (not just today's trades):

\`\`\`
Symbol: [ticker]
Original thesis: [from trade reasoning in journal]
Still valid? [Yes / Weakened / Invalidated]
Evidence: [what data supports or contradicts the thesis]
Action: [Hold / Adjust stop / Reduce / Close]
\`\`\`

**Hard rule:** If a thesis is "Invalidated" and you don't close the position,
you must explain why with specific evidence. "Hoping for a bounce" is not evidence.

### Step 3 — Bias Audit

For each bias, apply a specific TEST (not just ask yourself):

| Bias | Test | How to Check |
|------|------|-------------|
| **Confirmation** | Did you search for bearish evidence during the debate? | Review Round 2 bear rebuttal — was it substantive or token? |
| **Anchoring** | Are you holding because of your entry price? | Would you buy this position at today's price? If no → anchored |
| **Loss aversion** | Did you hold a loser past your stop? | Check: is any position below its stop-loss level right now? |
| **Recency** | Did a recent win make you oversize? | Compare today's position sizes to your 30-day average |
| **Action bias** | Did you trade because you "should do something"? | Count trades today. If > 3, question whether all were necessary |
| **Disposition** | Did you sell winners too early and hold losers? | Compare holding period of winners vs losers in journal |

Score: count how many biases you detected (0 = clean, 1-2 = minor, 3+ = problematic).
If 3+: next session should trade at HALF normal sizing.

### Step 4 — Benchmark Comparison

Compare today's session performance vs. SPY:

\`\`\`
Fund P&L today: $X (X%)
SPY change today: X%
Alpha: [fund return - SPY return]%
\`\`\`

**Trailing comparison** (if data available):
- Fund vs SPY over last 7 days
- Fund vs SPY over last 30 days
- Is the fund generating alpha, or just riding beta?

If the fund consistently underperforms SPY over 30 days, flag it:
"Consider whether active trading is adding value vs. holding SPY."

### Step 5 — Journal Updates

For any CLOSED positions this session:

\`\`\`sql
UPDATE trades
SET closed_at = '{ISO_TIMESTAMP}',
    close_price = {PRICE},
    pnl = {REALIZED_PNL},
    pnl_pct = {REALIZED_PNL_PCT},
    lessons_learned = '{SPECIFIC_LESSON}'
WHERE id = {TRADE_ID};
\`\`\`

**lessons_learned must be specific and actionable:**
- BAD: "Should have been more patient"
- GOOD: "Entry was 3% above 50-day SMA — next time wait for retest of the moving average before entering"

### Step 6 — Objective Progress

Update \`state/objective_tracker.json\` with:

\`\`\`
Current value: $X
Starting value: $X
Progress: X% toward objective
Pace: [ahead / on track / behind]
Estimated completion: [date or "N/A"]
\`\`\`

**If behind pace:**
- Identify the gap: how much needs to change?
- Is the strategy working but slowly, or is it fundamentally flawed?
- Concrete adjustment: "Increase position sizing by 20%" or "Shift to higher-conviction trades only" or "No change — variance is expected"

**If ahead of pace:**
- Consider reducing risk. Protect gains.
- For runway funds: extend the runway estimate.

## Output Format
End your analysis report with a "## Session Reflection" section:

\`\`\`
### Decision Grades
| Trade | Thesis | Timing | Sizing | Risk | Total |
|-------|--------|--------|--------|------|-------|
| BUY NVDA | 3 | 2 | 3 | 3 | 11/12 |
| Skipped AMD | Correct — thesis didn't hold |

### Active Position Review
| Symbol | Thesis Status | Action |
|--------|--------------|--------|
| NVDA | Valid | Hold |
| AAPL | Weakened — earnings miss | Tighten stop to $X |

### Bias Audit
Biases detected: 1 (minor anchoring on AAPL entry price)
Next session sizing: Normal

### Benchmark
Fund today: +0.8% | SPY today: +0.5% | Alpha: +0.3%

### Journal Updates
- Closed MSFT: +$320 (+4.2%). Lesson: "Breakout above $400 resistance worked — confirm with volume next time"

### Objective Progress
Value: $32,500 | Progress: 54% | Pace: On track
No strategy adjustment needed.
\`\`\`
`,
  },
  {
    name: "Investment Brainstorming",
    dirName: "investment-brainstorming",
    description:
      "You MUST use this before any significant strategy change, new position thesis, portfolio restructuring, or when the user proposes an investment idea. Explores intent, market context, and designs an investment approach before execution.",
    content: `# Investment Brainstorming — Ideas Into Strategy

## Overview

Help turn investment ideas into fully formed strategies through structured dialogue.

Start by understanding the fund's current context (portfolio, objective progress, market regime),
then ask questions one at a time to refine the idea. Once you understand the approach,
present the strategy and get approval before executing any trades.

<HARD-GATE>
Do NOT execute any trade, invoke investment-debate or risk-matrix, or take any position action
until you have presented a strategy and the user (or your own deliberation in autonomous mode)
has validated it. This applies to EVERY significant investment decision regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Trade Is Obvious"

Every significant strategy goes through this process. A single stock pick, a sector rotation,
a hedge — all of them. "Obvious" trades are where unexamined assumptions cause the most capital loss.
The strategy can be short (a few sentences for straightforward positions), but you MUST formulate
and validate it before acting.

## Process

**Step 1 — Explore Fund Context**
Before anything else, gather the current state:
- Read portfolio.json — current positions, cash, allocation
- Read objective_tracker.json — progress toward the fund's goal
- Check recent session analysis files — what was decided last session?
- Query trade journal for recent trades and lessons learned
- Assess current market regime (invoke market-regime skill if not already done)

**Step 2 — Understand the Idea**
Ask clarifying questions one at a time:
- What is the investment thesis? What catalyst or signal prompted this idea?
- What is the time horizon — days, weeks, months?
- What is the expected outcome? How does it advance the fund's objective?
- What would invalidate this thesis?
- Prefer multiple choice questions when possible
- Only one question per message in interactive mode

**Step 3 — Propose 2-3 Approaches**
Present different ways to express the idea with trade-offs:
- **Approach A**: Direct position (e.g., buy the stock outright)
- **Approach B**: Indirect exposure (e.g., ETF, sector play, pairs trade)
- **Approach C**: Wait for better entry (e.g., set alerts, scale in gradually)

For each approach:
- Expected return vs. risk
- How it interacts with existing positions
- How it aligns with the fund's objective type and risk profile
- Recommended approach with clear reasoning

**Step 4 — Present the Strategy**
Once an approach is selected, present the complete strategy:
- **Thesis**: One paragraph — why this trade, why now
- **Instrument(s)**: What to buy/sell
- **Sizing guidance**: Approximate allocation (exact sizing is done by position-sizing skill)
- **Entry criteria**: What conditions must be met to enter
- **Exit criteria**: Target price/condition and stop-loss level
- **Risk factors**: Top 3 things that could go wrong
- **Objective alignment**: How this advances the fund's specific goal

Scale each section to complexity — a few sentences if straightforward, more detail if nuanced.

**Step 5 — Document**
Save the validated strategy to the fund's analysis directory:
- File: \`analysis/YYYY-MM-DD-<topic>-strategy.md\`
- Include all sections from Step 4
- Reference any data or analysis that supported the decision

**Step 6 — Transition to Execution**
After the strategy is documented and approved:
1. Invoke **investment-debate** to stress-test the thesis (bull vs bear)
2. Invoke **risk-matrix** to finalize position sizing and risk checks
3. Only then proceed to trade execution

Do NOT skip directly to trading. The execution skills are the next step.

## Autonomous Mode Behavior

When running in a scheduled autonomous session (no user interaction):
- Steps 1-3 happen as internal deliberation — document your reasoning
- Step 4 becomes a self-assessment: "Does this strategy meet the fund's rules?"
- Skip Step 2's interactive questions — use the fund's decision_framework as your guide
- The HARD-GATE still applies: formulate before acting, never trade on impulse

## Key Principles

- **One question at a time** — Don't overwhelm with multiple questions
- **Objective-first** — Every strategy must connect to the fund's life goal
- **Explore alternatives** — Always propose 2-3 approaches before settling
- **YAGNI for trading** — Simpler strategies beat complex ones; avoid over-engineering positions
- **Incremental validation** — Present strategy, get approval, then execute
- **Capital preservation** — When in doubt, the default is to NOT trade
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
  provider: alpaca                 # use global config provider
  mode: paper                      # ALWAYS paper — user enables live with 'fundx live enable'

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
- Always \`mode: paper\` — live trading requires explicit user confirmation via CLI
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
 * Write the 6 trading analysis skills to a fund's .claude/skills/ directory.
 * Called during fund creation so each fund's Agent SDK session auto-loads them.
 */
export async function ensureFundSkillFiles(fundClaudeDir: string): Promise<void> {
  await ensureSkillFiles(fundClaudeDir, BUILTIN_SKILLS);
}

/**
 * Write the create-fund skill to ~/.fundx/.claude/skills/.
 * Called during workspace initialization.
 */
export async function ensureWorkspaceSkillFiles(): Promise<void> {
  await ensureSkillFiles(WORKSPACE_CLAUDE_DIR, [WORKSPACE_SKILL]);
}
