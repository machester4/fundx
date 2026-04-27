import { listFundNames } from "./fund.service.js";
import { runAgentQuery } from "../agent.js";
import { openJournal } from "../journal.js";
import { searchTrades } from "../embeddings.js";
import { buildFundContext, sessionModePrefix } from "./chat.service.js";

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
): Promise<{
  output: string;
  costUsd: number;
  numTurns: number;
  toolHistory: Array<{ name: string; elapsed: number }>;
  tokensIn: number;
  tokensOut: number;
}> {
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
    `This is a read-only query — do NOT execute any trades or modify state files.`,
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
    toolHistory: result.toolHistory,
    tokensIn: result.tokens_in,
    tokensOut: result.tokens_out,
  };
}
