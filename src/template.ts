import { writeFile } from "node:fs/promises";
import type { FundConfig } from "./types.js";
import { fundPaths } from "./paths.js";
import { getSkillsSummaryForTemplate } from "./skills.js";

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

${getSkillsSummaryForTemplate()}

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

### MCP Servers
- **broker-alpaca**: Execute trades, manage positions, check account
  - \`get_account\` — Account balance, equity, buying power
  - \`get_positions\` / \`get_position\` — Current positions with P&L
  - \`place_order\` — Place buy/sell orders (market, limit, stop, etc.)
  - \`cancel_order\` — Cancel open orders
  - \`get_orders\` — List open/closed orders
  - \`get_quote\` — Latest bid/ask quote
  - \`get_bars\` — Historical OHLCV bars
  - \`get_snapshot\` — Comprehensive symbol snapshot
- **market-data**: Price data, news, market analysis, and fundamental research
  - \`get_latest_trade\` / \`get_latest_quote\` — Real-time prices and NBBO (Alpaca)
  - \`get_bars\` / \`get_multi_bars\` — Historical OHLCV price data (Alpaca)
  - \`get_snapshot\` / \`get_multi_snapshots\` — Symbol snapshots with trade + quote + bars (Alpaca)
  - \`get_news\` — Financial news (FMP preferred, Alpaca fallback)
  - \`get_market_movers\` — Top gainers/losers (FMP preferred, Alpaca fallback)
  - \`get_most_active\` — Most actively traded symbols (Alpaca)
  - \`get_quote\` — Real-time quote with PE, market cap, 52w range, EPS (FMP)
  - \`get_company_profile\` — Sector, industry, CEO, description, market cap, beta (FMP)
  - \`get_income_statement\` — Revenue, net income, EPS by quarter/annual (FMP)
  - \`get_financial_ratios\` — P/E, P/B, ROE, debt ratios, dividend yield (FMP)
  - \`get_earnings_calendar\` — Upcoming earnings dates and estimates (FMP)
  - \`get_economic_calendar\` — FOMC, CPI, NFP, GDP macro events (FMP)
  - \`get_sector_performance\` — All 11 GICS sector % changes today (FMP)
  - \`search_symbol\` — Find ticker by company name (FMP)
  - \`get_options_chain\` — Options chain with calls, puts, strikes, IV, delta (Yahoo Finance, always available)
  Note: FMP tools return an informational message if FMP is not configured. Alpaca tools require broker credentials. Yahoo Finance tools (get_options_chain, and fallbacks for get_bars/get_snapshot/get_latest_trade/get_quote etc.) are always available without configuration.
- **telegram-notify**: Send notifications to the user via Telegram
  - \`send_message\` — Send any text message (supports HTML formatting)
  - \`send_trade_alert\` — Formatted trade execution notification
  - \`send_stop_loss_alert\` — Stop-loss triggered alert (always sends, even in quiet hours)
  - \`send_daily_digest\` — End-of-day summary with P&L, trades, and metrics
  - \`send_milestone_alert\` — Objective milestone notification

## Memory
Your \`state/trade_journal.sqlite\` contains all past trades with:
- Entry/exit prices and dates
- Your reasoning at the time
- Outcome and lessons learned

Use this to learn from your own history. Before making a trade, check
if you've seen a similar setup before and what happened.

## Trading Protocol
1. ALWAYS check current positions and account before placing orders
2. ALWAYS set stop-loss for every new position
3. ALWAYS log trades with reasoning in the trade journal
4. NEVER exceed position size limits from risk constraints
5. After executing a trade, update \`state/portfolio.json\`
6. After any changes, update \`state/objective_tracker.json\`
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
