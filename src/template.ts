import { writeFile } from "node:fs/promises";
import type { FundConfig } from "./types.js";
import { fundPaths } from "./paths.js";

/** Generate the per-fund CLAUDE.md from its config */
export async function generateFundClaudeMd(config: FundConfig): Promise<void> {
  const paths = fundPaths(config.fund.name);
  const content = buildClaudeMd(config);
  await writeFile(paths.claudeMd, content, "utf-8");
}

function buildClaudeMd(c: FundConfig): string {
  const objectiveDesc = describeObjective(c);
  const universeDesc = c.universe.allowed
    .flatMap((a) => a.tickers ?? [])
    .join(", ") || "Any allowed assets";
  const forbiddenDesc = c.universe.forbidden
    .map((f) => f.type ?? f.tickers?.join(", "))
    .join(", ") || "None";

  return `# Fund: ${c.fund.name}

## Identity
You are the AI fund manager for "${c.fund.display_name}".
${c.claude.personality}

## Objective
${objectiveDesc}

## Current State
- Read \`state/portfolio.json\` for current holdings
- Read \`state/objective_tracker.json\` for progress toward goal
- Read \`state/session_log.json\` for what happened last session
- Browse \`analysis/\` for past analyses you've written

## Constraints
- Max drawdown: ${c.risk.max_drawdown_pct}%
- Max position size: ${c.risk.max_position_pct}%
- Stop loss: ${c.risk.stop_loss_pct}% per position
- Allowed assets: ${universeDesc}
- Forbidden: ${forbiddenDesc}
${c.risk.custom_rules.map((r) => `- ${r}`).join("\n")}

## Decision Framework
${c.claude.decision_framework}

## Session Protocol
1. ALWAYS start by reading your current state files
2. NEVER trade without updating state files after
3. ALWAYS write an analysis report to \`analysis/{date}_{session}.md\`
4. ALWAYS update \`state/objective_tracker.json\` with current progress
5. Send Telegram notification for any trade or significant insight
6. If uncertain about a trade, DON'T do it. Document why in analysis.

## Tools Available
- Create and execute TypeScript/JavaScript scripts for any analysis
- Use web search for news, macro data, sentiment
- Launch sub-agents for parallel analysis (macro, technical, sentiment, risk)
- Read and write to your persistent state

## Memory
Your \`state/trade_journal.sqlite\` contains all past trades with:
- Entry/exit prices and dates
- Your reasoning at the time
- Outcome and lessons learned

Use this to learn from your own history. Before making a trade, check
if you've seen a similar setup before and what happened.
`;
}

function describeObjective(c: FundConfig): string {
  const obj = c.objective;
  switch (obj.type) {
    case "runway":
      return `Sustain $${obj.monthly_burn}/month for ${obj.target_months} months. Keep minimum ${obj.min_reserve_months} months in cash reserve.`;
    case "growth":
      return `Grow capital${obj.target_multiple ? ` ${obj.target_multiple}x` : ""}${obj.target_amount ? ` to $${obj.target_amount}` : ""}${obj.timeframe_months ? ` within ${obj.timeframe_months} months` : ""}.`;
    case "accumulation":
      return `Accumulate ${obj.target_amount} ${obj.target_asset}${obj.deadline ? ` by ${obj.deadline}` : ""}.`;
    case "income":
      return `Generate $${obj.target_monthly_income}/month in passive income.`;
    case "custom":
      return obj.description;
  }
}
