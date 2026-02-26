import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SHARED_DIR } from "./paths.js";

/**
 * Built-in analysis skills derived from the TradingAgents framework (arXiv:2412.20138).
 *
 * Skills are markdown instructions that get injected into the per-fund CLAUDE.md.
 * The autonomous agent reads them at session start and decides when/how to apply
 * each technique — replacing the rigid 5-stage pipeline with agent-directed reasoning.
 */

export interface Skill {
  name: string;
  filename: string;
  content: string;
}

export const BUILTIN_SKILLS: Skill[] = [
  {
    name: "Investment Debate",
    filename: "investment-debate.md",
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
    filename: "risk-matrix.md",
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
    filename: "trade-memory.md",
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
    filename: "market-regime.md",
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
    filename: "position-sizing.md",
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
    filename: "session-reflection.md",
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

/** Get the names of all built-in skills */
export function getAllSkillNames(): string[] {
  return BUILTIN_SKILLS.map((s) => s.name);
}

/** Get the content of a specific skill by name */
export function getSkillContent(skillName: string): string | undefined {
  return BUILTIN_SKILLS.find((s) => s.name === skillName)?.content;
}

/**
 * Generate a formatted section for inclusion in per-fund CLAUDE.md.
 *
 * Includes the full content of each skill so Claude has complete instructions
 * available at session start without needing to read external files.
 */
export function getSkillsSummaryForTemplate(): string {
  const sections: string[] = [
    `## Advanced Analysis Skills`,
    ``,
    `These are analysis techniques you may apply at your discretion during sessions.`,
    `You decide when each is appropriate based on the situation — you do NOT need to`,
    `use all of them every session. Use what the situation demands.`,
    ``,
    `Available skills:`,
  ];

  for (const skill of BUILTIN_SKILLS) {
    const whenMatch = skill.content.match(
      /## When to Use\n([\s\S]*?)(?=\n## )/,
    );
    const whenSummary = whenMatch
      ? whenMatch[1].trim().split("\n")[0]
      : "See details below";
    sections.push(`- **${skill.name}**: ${whenSummary}`);
  }

  sections.push("");

  for (const skill of BUILTIN_SKILLS) {
    sections.push(`---`);
    sections.push(``);
    sections.push(skill.content.trim());
    sections.push(``);
  }

  return sections.join("\n");
}

/** Path to the shared skills directory */
const SKILLS_DIR = join(SHARED_DIR, "skills");

/**
 * Write built-in skill files to ~/.fundx/shared/skills/ if they don't exist.
 * Called during `fundx init` to make skills browsable and editable by the user.
 */
export async function ensureSkillFiles(): Promise<void> {
  await mkdir(SKILLS_DIR, { recursive: true });

  for (const skill of BUILTIN_SKILLS) {
    const filePath = join(SKILLS_DIR, skill.filename);
    if (!existsSync(filePath)) {
      await writeFile(filePath, skill.content, "utf-8");
    }
  }
}
