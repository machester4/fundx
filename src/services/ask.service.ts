import { loadFundConfig, listFundNames } from "./fund.service.js";
import { readPortfolio, readTracker } from "../state.js";
import { runAgentQuery } from "../agent.js";
import { openJournal, getTradeSummary } from "../journal.js";
import { searchTrades, getTradeContextSummary } from "../embeddings.js";

/** Build context for a single fund */
export async function buildFundContext(fundName: string): Promise<string> {
  const sections: string[] = [];

  try {
    const config = await loadFundConfig(fundName);
    sections.push(`## Fund: ${config.fund.display_name} (${fundName})`);
    sections.push(`Status: ${config.fund.status}`);
    sections.push(`Objective: ${config.objective.type}`);
    sections.push(`Risk: ${config.risk.profile}`);
    sections.push(`Broker: ${config.broker.provider} (${config.broker.mode})`);
    sections.push("");
  } catch {
    sections.push(`## Fund: ${fundName} (config unavailable)`);
    sections.push("");
  }

  try {
    const portfolio = await readPortfolio(fundName);
    sections.push(`### Portfolio`);
    sections.push(`Cash: $${portfolio.cash.toFixed(2)}`);
    sections.push(`Total Value: $${portfolio.total_value.toFixed(2)}`);
    sections.push(`Positions: ${portfolio.positions.length}`);
    if (portfolio.positions.length > 0) {
      for (const p of portfolio.positions) {
        const pnlSign = p.unrealized_pnl >= 0 ? "+" : "";
        sections.push(
          `  - ${p.symbol}: ${p.shares} shares @ $${p.avg_cost.toFixed(2)} \u2192 $${p.current_price.toFixed(2)} (${pnlSign}${p.unrealized_pnl_pct.toFixed(1)}%)`,
        );
      }
    }
    sections.push("");
  } catch {
    sections.push("### Portfolio: unavailable\n");
  }

  try {
    const tracker = await readTracker(fundName);
    sections.push(`### Objective Progress`);
    sections.push(`Progress: ${tracker.progress_pct.toFixed(1)}%`);
    sections.push(`Status: ${tracker.status}`);
    sections.push(
      `Value: $${tracker.current_value.toFixed(2)} (initial: $${tracker.initial_capital.toFixed(2)})`,
    );
    sections.push("");
  } catch {
    sections.push("### Objective: unavailable\n");
  }

  try {
    const db = openJournal(fundName);
    try {
      const summary = getTradeSummary(db, fundName);
      if (summary.total_trades > 0) {
        sections.push(`### Trade Summary`);
        sections.push(`Total closed trades: ${summary.total_trades}`);
        sections.push(
          `Win rate: ${summary.total_trades > 0 ? ((summary.winning_trades / summary.total_trades) * 100).toFixed(0) : 0}%`,
        );
        sections.push(`Total P&L: $${summary.total_pnl.toFixed(2)}`);
        sections.push(`Best trade: $${summary.best_trade_pnl.toFixed(2)}`);
        sections.push(`Worst trade: $${summary.worst_trade_pnl.toFixed(2)}`);
        sections.push("");
      }

      const context = getTradeContextSummary(db, fundName, 10);
      sections.push(context);
    } finally {
      db.close();
    }
  } catch {
    // Journal may not exist yet
  }

  return sections.join("\n");
}

/** Search trade history for relevant trades */
export function searchTradeHistory(
  fundName: string,
  queryText: string,
): string {
  try {
    const db = openJournal(fundName);
    try {
      const results = searchTrades(db, queryText, fundName, 10);
      if (results.length === 0) return "";

      const lines: string[] = [`### Relevant Trades from ${fundName}\n`];
      for (const r of results) {
        const date = r.timestamp.split("T")[0];
        const pnlStr =
          r.pnl != null ? ` | P&L: $${r.pnl.toFixed(2)}` : "";
        lines.push(
          `- [#${r.trade_id}] ${date} ${r.side.toUpperCase()} ${r.symbol}${pnlStr}`,
        );
        if (r.reasoning) lines.push(`  Reasoning: ${r.reasoning}`);
        if (r.lessons_learned) lines.push(`  Lessons: ${r.lessons_learned}`);
      }
      return lines.join("\n");
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

export interface AskOptions {
  fund?: string;
  all?: boolean;
  search?: boolean;
  model?: string;
}

/** Run the ask query and return the result string + metadata */
export async function runAskQuery(
  question: string,
  options: AskOptions,
): Promise<{ output: string; costUsd: number; numTurns: number }> {
  const allFunds = await listFundNames();
  if (allFunds.length === 0) {
    throw new Error("No funds found. Create one first: fundx fund create");
  }

  let targetFunds: string[];
  if (options.fund) {
    if (!allFunds.includes(options.fund)) {
      throw new Error(`Fund '${options.fund}' not found.`);
    }
    targetFunds = [options.fund];
  } else if (options.all || allFunds.length === 1) {
    targetFunds = allFunds;
  } else {
    targetFunds = allFunds;
  }

  const contextParts: string[] = [];

  for (const fundName of targetFunds) {
    const ctx = await buildFundContext(fundName);
    contextParts.push(ctx);

    if (options.search) {
      const searchResults = searchTradeHistory(fundName, question);
      if (searchResults) {
        contextParts.push(searchResults);
      }
    }
  }

  const isCrossFund = targetFunds.length > 1;
  const context = contextParts.join("\n\n---\n\n");

  const prompt = [
    `You are answering a question about ${isCrossFund ? "multiple funds" : `the fund '${targetFunds[0]}'`}.`,
    `This is a read-only query \u2014 do NOT execute any trades or modify state files.`,
    ``,
    `## Question`,
    question,
    ``,
    `## Context`,
    context,
    ``,
    isCrossFund
      ? `Compare and analyze across all funds where relevant. Highlight differences in strategy, performance, and risk.`
      : `Focus your answer on this specific fund's data, history, and context.`,
    ``,
    `Be concise and actionable. Use specific numbers from the context.`,
    `If you need more data, use the MCP market-data tools.`,
  ].join("\n");

  const result = await runAgentQuery({
    fundName: targetFunds[0],
    prompt,
    model: options.model,
    maxTurns: 30,
    timeoutMs: 5 * 60 * 1000,
    maxBudgetUsd: 2.0,
  });

  return {
    output: result.output,
    costUsd: result.cost_usd,
    numTurns: result.num_turns,
  };
}
