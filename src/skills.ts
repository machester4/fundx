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
      "Develop, stress-test, and validate investment theses before any significant trade. Combines idea generation with bull/bear dialectical analysis.",
    content: `# Investment Thesis

## When to Use
Before any significant trade: opening a new position, materially increasing an existing one,
or making a major allocation shift. Skip for mechanical actions (stop-loss exits, scheduled
rebalances, minor trims).

## Technique

### 1. The Idea
State the thesis in one sentence: what you are buying/selling, why, and the expected time
horizon. If you cannot articulate it in one sentence, the idea is not ready.

**Good:** "Buy GDXJ because gold miners are trading at 0.8x NAV while gold is above $2,300,
with a 3-6 month horizon targeting a reversion to 1.0x NAV."

**Bad:** "Gold miners look interesting and could go up."

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

### 5. Historical Parallel
Query the trade journal for similar past trades (same sector, similar setup, comparable
regime). What happened? What was learned? If no history exists, note that explicitly — first
trades in a new area deserve smaller sizing.

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

## Output
Structured markdown with sections: Thesis, Bull Case, Bear Case, Devil's Advocate,
Historical Parallel, Conviction (1-5), Recommended Action, Invalidation Trigger.
`,
  },
  {
    name: "Risk Assessment",
    dirName: "risk-assessment",
    description:
      "Quantitative pre-execution risk check before placing any trade order. Validates position sizing, portfolio impact, and hard constraints.",
    content: `# Risk Assessment

## When to Use
Immediately before placing any trade order — after the investment thesis is formed but
before execution. This is a final gate, not a substitute for thesis quality. Every order
passes through this check. No exceptions.

## Technique

### 1. Expected Value
Estimate the trade's expected value:
- **Upside target:** Price level and % gain if thesis plays out
- **Downside stop:** Price level and % loss if thesis fails
- **Probability estimate:** Rough odds of success (be honest, not optimistic)
- **EV = (P(win) x gain) - (P(loss) x loss)** — must be positive

If EV is negative or unclear, do not trade. "I think it will go up" is not a valid EV
calculation.

### 2. Position Size
Validate the proposed size against fund constraints:
- Does it exceed \`risk.max_position_pct\`? → Reduce
- Does it create a concentrated sector/factor bet? → Flag
- Is it appropriate for the conviction level? (See Position Sizing skill)
- Would a full loss at the stop violate \`risk.max_daily_loss_pct\`? → Reduce

### 3. Portfolio Impact
Assess what happens to the whole portfolio:
- **Cash remaining:** After this trade, is cash above the fund's minimum reserve?
- **Correlation:** Does this position move with existing holdings? If adding a gold miner
  when you already hold gold ETFs, you are concentrating, not diversifying.
- **Drawdown budget:** Current drawdown + worst-case loss on this trade — does it breach
  \`risk.max_drawdown_pct\`?

### 4. Hard Constraints
Check every item — any failure is a veto:
- [ ] Ticker is in \`universe.allowed\` and not in \`universe.forbidden\`
- [ ] Broker mode matches intent (paper vs. live)
- [ ] Position size ≤ \`risk.max_position_pct\` of portfolio
- [ ] Stop-loss is defined and entered with the order
- [ ] Post-trade cash ≥ minimum reserve for fund type
- [ ] No earnings/FOMC/CPI within 24h unless thesis explicitly accounts for it

### 5. Order Specification
Only after all checks pass, specify the exact order:
- Symbol, side (buy/sell), quantity, order type (limit/market)
- Stop-loss price and type
- Take-profit level (if applicable)

## Output
Structured checklist: EV calculation, size validation, portfolio impact summary,
hard constraint pass/fail, and final order specification or rejection with reason.
`,
  },
  {
    name: "Trade Memory",
    dirName: "trade-memory",
    description:
      "Query trade journal for relevant past trades, win rates, and historical lessons before making a new trade decision.",
    content: `# Trade Memory

## When to Use
Before any trade decision, query the trade journal to learn from history. Also use when
reviewing a sector, ticker, or strategy you have traded before. The journal is in
\`state/trade_journal.sqlite\` with a \`trades\` table and \`trades_fts\` FTS5 index.

## Technique

### Queries to Run

**1. Same-ticker history:**
\`\`\`sql
SELECT symbol, side, entry_price, exit_price, pnl_pct, reasoning, lessons_learned,
       entry_date, exit_date
FROM trades WHERE symbol = ? ORDER BY entry_date DESC LIMIT 10
\`\`\`
What was your track record? Win rate? Average gain vs. average loss?

**2. Similar-setup search (FTS5):**
\`\`\`sql
SELECT symbol, reasoning, lessons_learned, pnl_pct
FROM trades_fts WHERE trades_fts MATCH ?
ORDER BY rank LIMIT 10
\`\`\`
Use keywords from the current thesis: sector, catalyst type, regime, strategy name.

**3. Recent performance:**
\`\`\`sql
SELECT COUNT(*) as total,
       SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) as wins,
       AVG(pnl_pct) as avg_pnl,
       MIN(pnl_pct) as worst
FROM trades WHERE exit_date > date('now', '-30 days')
\`\`\`
Are you in a winning or losing streak? Adjust sizing accordingly.

**4. Pattern detection:**
\`\`\`sql
SELECT symbol, side, pnl_pct, reasoning, lessons_learned
FROM trades WHERE pnl_pct < -5 ORDER BY pnl_pct ASC LIMIT 5
\`\`\`
What do your worst trades have in common? Are you about to repeat a pattern?

## Decision Rules
- **Win rate < 40% on ticker** → Reduce size by 50% or skip
- **3+ consecutive losses recently** → Reduce all sizing by one tier
- **Past lesson directly applies** → Quote it in the thesis and adjust
- **No history on this ticker/sector** → Treat as first trade, use minimum sizing
- **Repeated same mistake** → Veto the trade until the pattern is addressed

## Output
Summary of relevant past trades, key lessons that apply, win rate stats, and a
clear recommendation: proceed (with adjustments), reduce size, or skip.
`,
  },
  {
    name: "Market Regime",
    dirName: "market-regime",
    description:
      "Classify the current market environment to calibrate position sizing and strategy. Run at the start of every trading session.",
    content: `# Market Regime Classification

## When to Use
At the start of every trading session before making any decisions. Also re-run when a major
macro event occurs (FOMC, CPI, NFP, geopolitical shock). The regime determines baseline
position sizing, cash levels, and which strategies are appropriate.

## Technique

Assess five dimensions using market data MCP:

### 1. Volatility
- VIX level and trend (rising, stable, falling)
- VIX term structure (contango = calm, backwardation = stress)
- Realized vs. implied vol spread

### 2. Trend
- S&P 500 vs. 50-day and 200-day moving averages
- Trend direction and strength (strong up, weak up, range, weak down, strong down)
- Key support/resistance levels nearby

### 3. Breadth
- Advance-decline ratio
- % of stocks above 200-day MA
- Sector rotation patterns (defensive vs. cyclical leadership)

### 4. Rotation
- Which sectors are leading and lagging?
- Growth vs. value performance
- Large cap vs. small cap spread

### 5. Macro Backdrop
- Fed policy stance and next meeting date
- Treasury yield curve (inverted, flat, steep)
- Credit spreads (IG and HY) — widening = stress
- Dollar strength (DXY trend)

## Regime Classifications

| Regime | VIX | Trend | Breadth | Sizing Multiplier | Cash Floor |
|--------|-----|-------|---------|-------------------|------------|
| **Risk-On** | <18, falling | Above 50/200 MA | >60% above 200d | 1.0x | Per fund min |
| **Transition** | 18-25 or rising | Mixed signals | 40-60% | 0.7x | +10% cash |
| **Risk-Off** | 25-35 | Below 50 MA | <40% | 0.5x | +20% cash |
| **Crisis** | >35, backwardation | Below 200 MA | <25% | 0.25x | +40% cash |

## Output
Current regime classification with supporting data for each dimension, sizing multiplier
to apply for the session, recommended cash floor adjustment, and any regime-specific
warnings (e.g., "VIX term structure just inverted — monitor for escalation").
`,
  },
  {
    name: "Position Sizing",
    dirName: "position-sizing",
    description:
      "Calculate exact position size from conviction level, fund type, portfolio state, market regime, and Kelly criterion cross-check.",
    content: `# Position Sizing

## When to Use
After forming a thesis and conviction score but before placing the order. This skill
translates conviction into exact dollar amounts and share counts.

## Technique

### Step 1: Base Size from Conviction

| Conviction | Base % of Portfolio |
|------------|---------------------|
| 1 — Speculative | 1-2% |
| 2 — Reasonable | 2-4% |
| 3 — Solid | 4-6% |
| 4 — Strong | 6-8% |
| 5 — Exceptional | 8-10% |

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
Kelly % = (win_prob x avg_win / avg_loss) - (1 - win_prob) / (avg_win / avg_loss)

Use half-Kelly (divide by 2) as the practical maximum. If the Kelly-optimal size is
significantly smaller than your conviction-based size, trust Kelly — your conviction
may be overconfident. Pull historical win rate from trade journal.

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

Verify: dollar_amount ≤ available cash. If not, reduce to what cash allows.

## Output
Table showing: base size, each adjustment, final %, dollar amount, share count, and
the binding constraint (conviction, Kelly, max position, or cash).
`,
  },
  {
    name: "Session Reflection",
    dirName: "session-reflection",
    description:
      "End-of-session review: audit decisions honestly, detect biases, update trade journal with actionable lessons, and track objective progress. Non-negotiable final action of every session.",
    content: `# Session Reflection

## When to Use
At the end of every trading session — this is non-negotiable. Even if "nothing happened,"
you reflect on why and whether inaction was the right call.

## Technique

### 1. Decision Audit
For every decision made this session (trades, holds, skips):
- **What was the thesis?** — Restate it in one sentence
- **What actually happened?** — Price action, news, execution quality
- **Was the process good?** — Did you follow the thesis → risk check → execute flow?
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

If any bias was present, note it explicitly and describe how it affected the decision.

### 3. Journal Updates
Update the trade journal for every trade executed or closed:

**Good journal entry:**
\`\`\`
Bought 50 shares GDXJ at $42.15. Thesis: gold miners undervalued at 0.8x NAV with
gold above $2,300. Regime: Transition. Conviction: 3. Stop: $38.50 (-8.6%).
Catalyst: Fed pause expected within 60 days.
\`\`\`

**Bad journal entry:**
\`\`\`
Bought GDXJ. Looks good.
\`\`\`

For closed trades, always record:
- Final P&L ($ and %)
- Whether the exit matched the plan (hit target, hit stop, or discretionary)
- One specific lesson learned

### 4. Objective Progress
Review the fund's objective tracker:
- **Runway funds:** Current months of runway vs. target. Burn rate on track?
- **Growth funds:** Current multiple vs. target. Pace to reach goal?
- **Accumulation funds:** Units acquired vs. target. Average cost basis trend?
- **Income funds:** Monthly income rate vs. target. Yield sustainability?

Update \`state/objective_tracker.json\` with current progress metrics.

## Output
Structured markdown: Decision Audit (graded), Bias Check (honest), Journal Updates
(written to DB), Objective Progress (updated), and Next Session Focus (priorities
for the next trading session).
`,
  },
  {
    name: "Portfolio Review",
    dirName: "portfolio-review",
    description:
      "Holistic portfolio health check: position-by-position thesis validation, concentration analysis, correlation assessment, and rebalancing recommendations.",
    content: `# Portfolio Review

## When to Use
At least once per week during a post-market session. Also trigger when:
- A position has moved more than 15% since last review
- Market regime has changed
- A new position is being considered (to understand fit)
- The fund is approaching a drawdown limit

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

## Output
Position table (symbol, size, P&L, thesis status, action), portfolio-level metrics
(concentration, sector, correlation, cash, drawdown), and prioritized rebalancing
actions with reasoning.
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

Every trade decision must meet these quality standards. No exceptions for "obvious" trades,
hot tips, or time pressure. The process exists to protect the fund from its own biases.

## Requirements Before Any Trade

1. **Written thesis required** — No order is placed without a documented investment thesis
   (see Investment Thesis skill). "It looks like a good setup" is not a thesis.

2. **Positive expected value** — Every trade must have an explicit EV calculation:
   EV = (P(win) x gain) - (P(loss) x loss). If EV is negative, zero, or "hard to estimate,"
   do not trade.

3. **Trade history consulted** — Query the trade journal for same-ticker and similar-setup
   history before every new trade. Past lessons override current intuition.

4. **No FOMO trades** — If the primary motivation is "it already moved and I missed it,"
   the trade is vetoed. Missed moves have zero cost. Chasing moves has real cost.

5. **No revenge trades** — After a loss, the next trade must meet a higher bar: conviction
   ≥ 3 and explicit acknowledgment that this is not an attempt to "make it back."

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
`,
  },
  {
    fileName: "analysis-standards.md",
    content: `# Analysis Standards

All analysis produced during trading sessions must meet institutional quality standards.
Vague or superficial analysis leads to vague decisions and real losses.

## Required Standards

### Specific Numbers
Every analytical claim must include concrete data:

**Good:** "GDXJ is trading at $42.15, down 12% from its 52-week high of $47.90, with RSI at
38 and approaching the 200-day MA at $40.80."

**Bad:** "GDXJ is oversold and near support."

### Sources Cited
State where data comes from. When using market-data MCP, note the data point and timestamp.
When citing a macro trend, reference the specific indicator (e.g., "10Y yield at 4.35%
per Treasury data" not "yields are high").

### Uncertainty Quantified
Never present a single scenario as certain. Provide:
- Base case with probability estimate
- Upside scenario with probability
- Downside scenario with probability
- What would change your mind (specific trigger)

**Good:** "Base case (60%): GDXJ rebounds to $45 within 30 days on mean reversion. Upside
(20%): breaks above $48 if Fed signals cuts. Downside (20%): breaks below $39 support if
dollar strengthens above DXY 107."

**Bad:** "GDXJ should go up because gold miners are undervalued."

### Alternatives Considered
Before recommending any action, explicitly evaluate at least one alternative:
- Why this ticker and not a competitor?
- Why trade now and not wait?
- Why this size and not smaller/larger?

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

## Never

- Never disable or widen a stop-loss to avoid being stopped out
- Never exceed position size limits "just this once" for a high-conviction trade
- Never ignore the daily loss limit because "the market will come back"
- Never treat unrealized gains as a cushion to take more risk
- Never hold a position past an invalidation trigger you identified in the thesis
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

Trading does not happen in a vacuum. The market environment determines what strategies work,
how to size positions, and when to stay in cash. Ignoring the environment is the fastest
way to blow up a fund.

## Regime Respect

The Market Regime classification (Risk-On, Transition, Risk-Off, Crisis) is not advisory —
it is a binding constraint on behavior:

- **Risk-On:** Normal operations. Full conviction-based sizing. Deploy cash when opportunities
  meet quality standards.
- **Transition:** Increased caution. Reduce sizing by 30%. Require conviction ≥ 3 for new
  positions. Widen stop-losses by 20% to avoid noise shakeouts.
- **Risk-Off:** Defensive posture. Reduce sizing by 50%. Only trade conviction 4-5. Actively
  look for positions to trim. Raise cash to 30%+ of portfolio.
- **Crisis:** Capital preservation mode. No new long positions. Trim aggressively. Cash
  target 50%+. The goal is survival, not returns.

If you find yourself rationalizing why the regime does not apply to your trade, that is
the regime applying to your trade.

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
