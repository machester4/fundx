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
    description: "Conduct a bull vs bear dialectical debate before any significant trade decision",
    content: `# Investment Debate (Bull vs Bear)

## When to Use
Before any significant trade decision — opening a new position, substantially increasing
an existing one, or making a major allocation change. Skip for minor rebalances or
stop-loss exits where speed matters.

## Technique
Conduct an internal dialectical debate before committing to a trade:

**Step 1 — Build the Bull Case**
Argue FOR the trade. Cite specific data points:
- Recent price action, technical levels, and momentum
- Fundamental catalysts (earnings, product launches, macro tailwinds)
- How this trade advances the fund's specific objective
- Historical precedents where similar setups worked

**Step 2 — Build the Bear Case**
Attack the bull case. For every bull argument, find a counter:
- What risks is the bull case ignoring or downplaying?
- What adverse scenarios could unfold? How likely are they?
- Is the timing right, or is there a better entry point?
- What does the historical failure rate look like for this setup?

**Step 3 — Judge**
Evaluate both sides objectively:
- Which side had stronger, more specific evidence?
- Which side relied more on assumptions vs. data?
- What is the prevailing direction: bullish, bearish, or genuinely neutral?
- What is your confidence level (low / medium / high)?

**Step 4 — Objective Filter**
Before finalizing, ask: "Does this trade make sense for THIS fund's objective?"
- Runway funds: Does this protect or extend the runway? Is the risk justified?
- Growth funds: Does the expected return justify the risk relative to the target multiple?
- Income funds: Does this contribute to sustainable income generation?
- Accumulation funds: Does this help acquire the target asset efficiently?

## Output Format
In your analysis report, document the debate under a "## Investment Debate" section:
- Bull case summary (3-5 key arguments)
- Bear case summary (3-5 key arguments)
- Verdict: prevailing direction + confidence level
- How the fund's objective influenced the final judgment
`,
  },
  {
    name: "Risk Assessment Matrix",
    dirName: "risk-matrix",
    description: "Evaluate a proposed trade from aggressive, conservative, and balanced risk perspectives before executing",
    content: `# Risk Assessment Matrix (Multi-Perspective)

## When to Use
After deciding to make a trade but BEFORE executing it. This is your final check
between decision and action.

## Technique
Evaluate the proposed trade from three risk perspectives:

**Aggressive Perspective**
- What is the maximum realistic upside?
- What competitive advantages or catalysts support a larger position?
- Is the market underpricing the opportunity?
- Argue for the largest defensible position size.

**Conservative Perspective**
- What is the worst realistic downside (not black swan, but bad scenario)?
- How much capital is at risk if the stop-loss triggers?
- What is the impact on the fund's objective if this trade loses?
- How does this trade interact with existing positions (correlation risk)?
- Argue for the smallest defensible position size, or not trading at all.

**Balanced Perspective**
- What is the risk-adjusted expected return?
- What position size balances upside capture with downside protection?
- Does the reward justify the risk given the fund's current status?

**Synthesis**
After considering all three perspectives, determine:
1. Final position size (% of portfolio)
2. Stop-loss level (must respect fund's stop_loss_pct constraint)
3. Whether any hedging or risk mitigation is needed
4. Maximum acceptable loss in dollar terms for this trade

**Constraint Check**
Cross-reference against the fund's risk constraints:
- Does this position exceed max_position_pct? → Reduce
- Would a loss breach max_drawdown_pct? → Reduce or skip
- Is the portfolio too concentrated after this trade? → Diversify

## Output Format
In your analysis report, include a "## Risk Assessment" section with:
- Position size recommendation with rationale
- Stop-loss level
- Key risk factors identified
- Constraint compliance confirmation
`,
  },
  {
    name: "Trade Journal Review",
    dirName: "trade-memory",
    description: "Query trade journal history to apply past lessons before trading or during post-session reflection",
    content: `# Trade Journal Review (Historical Memory)

## When to Use
- Before any trade: Check if you have traded this asset or a similar setup before
- During post-market sessions: Review recent trades for lessons
- When market conditions remind you of a past scenario

## Technique
Query your trade journal (\`state/trade_journal.sqlite\`) to find relevant history:

**Before Trading**
1. Search for past trades in the same symbol — what happened? What did you learn?
2. Search for trades in similar market conditions — did you identify patterns?
3. Look at your success rate for this type of trade (momentum, mean-reversion, breakout, etc.)
4. Check if any past "lessons_learned" entries apply to the current situation

**During Reflection**
1. Review trades opened or closed this session
2. Compare the actual outcome with your original thesis
3. Was your entry timing good? Your position sizing appropriate?
4. Write a "lessons_learned" entry for each completed trade
5. Note any cognitive biases you may have exhibited:
   - Confirmation bias: Did you only seek supporting evidence?
   - Anchoring: Were you fixated on a specific price level?
   - Loss aversion: Did you hold a loser too long or cut a winner too short?
   - Recency bias: Did you overweight recent events?

## Output Format
When referencing trade history, include a "## Trade History Context" section:
- Relevant past trades found (symbol, date, outcome)
- Lessons applied from those trades
- How the current setup differs from past situations
`,
  },
  {
    name: "Market Regime Detection",
    dirName: "market-regime",
    description: "Classify the current market regime (risk-on/off, volatility) to inform all session decisions",
    content: `# Market Regime Detection

## When to Use
At the start of every session, especially pre-market sessions. The regime classification
should inform all subsequent analysis and trading decisions.

## Technique
Classify the current market regime using available data:

**Indicators to Check**
- VIX level and trend (below 15 = calm, 15-25 = normal, 25-35 = elevated, 35+ = crisis)
- S&P 500 / major index trend (above or below 50-day and 200-day moving averages)
- Yield curve shape (inverted = recession risk, steepening = growth expectation)
- Sector rotation patterns (defensive vs. cyclical leadership)
- Market breadth (advancing vs. declining issues, new highs vs. new lows)
- Credit spreads (widening = risk-off, tightening = risk-on)

**Regime Classifications**
- **Risk-On**: Strong market, low vol, broad participation, cyclicals leading
- **Risk-Off**: Weak market, rising vol, flight to safety, defensives leading
- **Transition**: Mixed signals, regime change underway, high uncertainty
- **High Volatility**: VIX elevated, large daily moves, potential opportunities but higher risk
- **Low Volatility**: Compressed ranges, potential for breakout, complacency risk

**Regime → Strategy Mapping**
| Regime | Runway Funds | Growth Funds | Income Funds |
|--------|-------------|-------------|-------------|
| Risk-On | Moderate positions | Full allocation | Seek yield |
| Risk-Off | Reduce exposure, raise cash | Defensive positions | Protect income streams |
| Transition | Wait for clarity | Small positions only | Hold steady |
| High Vol | Cash preservation | Selective opportunities | Avoid new positions |
| Low Vol | Normal operations | Build positions | Normal operations |

## Output Format
Start your analysis report with a "## Market Regime" section:
- Current regime classification
- Key indicators supporting the classification
- Implications for this session's trading decisions
`,
  },
  {
    name: "Position Sizing",
    dirName: "position-sizing",
    description: "Determine optimal position size using conviction level, fund objective, and risk constraints",
    content: `# Conviction-Based Position Sizing

## When to Use
Whenever determining how much capital to allocate to a trade. This works
alongside the Risk Assessment Matrix.

## Technique

**Step 1 — Assess Conviction Level**
Based on your analysis and debate, rate your conviction:
- **High conviction** (70-90% confident): Multiple signals align, strong catalyst, clear thesis
- **Medium conviction** (50-70%): Thesis is reasonable but some uncertainty remains
- **Low conviction** (30-50%): Interesting setup but significant unknowns

**Step 2 — Base Position Size by Conviction**
| Conviction | Base Size (% of portfolio) |
|-----------|--------------------------|
| High | 8-15% |
| Medium | 4-8% |
| Low | 2-4% |

**Step 3 — Adjust for Fund Objective**
- **Runway funds**: Reduce base size by 30-50%. Never risk more than 1 month of burn on a single trade.
- **Growth funds**: Use base size. Can go to upper range with high conviction.
- **Income funds**: Size based on yield contribution, not capital appreciation.
- **Accumulation funds**: Size based on target asset quantity, not portfolio percentage.

**Step 4 — Adjust for Current State**
- Current drawdown close to max_drawdown_pct? → Cut size by 50%
- Already have 3+ open positions? → Reduce to prevent over-concentration
- Portfolio already >70% invested? → Smaller new positions
- Objective nearly achieved? → Reduce risk-taking

**Step 5 — Final Constraint Check**
- Position must not exceed max_position_pct from fund config
- Total portfolio exposure must stay within acceptable range
- Stop-loss level must be set (use stop_loss_pct from fund config)
- Calculate max loss: position_size * stop_loss_pct — is this acceptable?

## Output Format
When sizing a position, document in your analysis:
- Conviction level and rationale
- Base size and adjustments applied
- Final position size with stop-loss level
- Maximum dollar loss if stop triggers
`,
  },
  {
    name: "Session Reflection",
    dirName: "session-reflection",
    description: "End-of-session review: decisions audit, bias check, journal update, and objective progress",
    content: `# Session Reflection (Post-Session Learning)

## When to Use
At the end of every session, after all trades and analysis are complete.
This is the last thing you do before the session ends.

## Technique

**Step 1 — Review Decisions**
- What trades did you execute this session? Why?
- What trades did you consider but decided against? Why?
- Did any positions hit stop-losses or targets since last session?

**Step 2 — Thesis Validation**
For each active position:
- Is your original thesis still intact?
- Has anything changed that weakens or strengthens it?
- Should you adjust your stop-loss, target, or position size?

**Step 3 — Bias Audit**
Honestly assess whether any cognitive biases influenced your decisions:
- Did you seek confirming evidence for a predetermined conclusion?
- Were you anchored to a specific price or outcome?
- Did you let a recent loss make you too cautious, or a recent win too aggressive?
- Did you trade because you felt you "should do something"?

**Step 4 — Journal Update**
For any completed trades (closed positions):
- Update trade_journal.sqlite with final outcome (pnl, pnl_pct)
- Write a lessons_learned entry — what would you do differently?
- Rate your execution: was the entry timing, sizing, and exit appropriate?

**Step 5 — Objective Progress**
- Update objective_tracker.json with current progress
- How far are you from the fund's objective?
- At current pace, are you on track? Ahead? Behind?
- Do you need to adjust strategy to stay on track?

## Output Format
End your analysis report with a "## Session Reflection" section:
- Decisions made and rationale
- Bias audit results
- Lessons learned
- Objective progress update
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
