import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fundPaths } from "./paths.js";
import { runAgentQuery } from "./agent.js";
import type { SubAgentConfig, SubAgentResult } from "./types.js";

/**
 * Sub-agent parallel execution system.
 *
 * Launches multiple Claude Agent SDK queries in parallel, each focused on a
 * specific analysis domain (macro, technical, sentiment, risk). Results are
 * collected and merged into a combined analysis document.
 */

/** Default analysis sub-agents for a standard session */
export function getDefaultSubAgents(fundName: string): SubAgentConfig[] {
  return [
    {
      type: "macro",
      name: "Macro Analyst",
      prompt: [
        `You are the macro analysis sub-agent for fund '${fundName}'.`,
        ``,
        `Your job is to analyze macroeconomic conditions relevant to this fund's holdings and universe.`,
        `Focus on:`,
        `- Interest rates, Fed policy, and yield curve analysis`,
        `- GDP, employment, inflation data and trends`,
        `- Sector rotation and market regime (risk-on vs risk-off)`,
        `- Geopolitical events affecting markets`,
        `- Currency movements and correlations`,
        ``,
        `Use the market-data MCP tools to gather current data.`,
        `Output a concise analysis in markdown format with clear conclusions and actionable insights.`,
        `End with a MACRO_SIGNAL: bullish | neutral | bearish`,
      ].join("\n"),
      max_turns: 15,
    },
    {
      type: "technical",
      name: "Technical Analyst",
      prompt: [
        `You are the technical analysis sub-agent for fund '${fundName}'.`,
        ``,
        `Your job is to perform technical analysis on the fund's current holdings and watchlist.`,
        `Focus on:`,
        `- Price action and trend analysis (moving averages, support/resistance)`,
        `- Volume patterns and momentum indicators`,
        `- Chart patterns and breakout/breakdown levels`,
        `- Relative strength vs. benchmarks (SPY)`,
        `- Key price levels for entry/exit decisions`,
        ``,
        `Use the market-data MCP tools to fetch historical bars and current quotes.`,
        `Output a concise analysis in markdown format for each ticker.`,
        `End with a TECHNICAL_SIGNAL: bullish | neutral | bearish for each symbol.`,
      ].join("\n"),
      max_turns: 15,
    },
    {
      type: "sentiment",
      name: "Sentiment Analyst",
      prompt: [
        `You are the sentiment analysis sub-agent for fund '${fundName}'.`,
        ``,
        `Your job is to analyze market sentiment and news relevant to this fund.`,
        `Focus on:`,
        `- Recent news headlines affecting holdings and watchlist`,
        `- Market breadth and volatility (VIX, put/call ratios)`,
        `- Earnings surprises and guidance changes`,
        `- Analyst upgrades/downgrades`,
        `- Social and institutional sentiment shifts`,
        ``,
        `Use the market-data MCP tools (get_news, get_market_movers, get_most_active).`,
        `Output a concise sentiment report in markdown format.`,
        `End with a SENTIMENT_SIGNAL: bullish | neutral | bearish`,
      ].join("\n"),
      max_turns: 15,
    },
    {
      type: "news",
      name: "News Analyst",
      prompt: [
        `You are the news analysis sub-agent for fund '${fundName}'.`,
        ``,
        `Your job is to analyze recent news, world events, and macroeconomic developments relevant to this fund.`,
        `Focus on:`,
        `- Breaking news affecting holdings or watchlist companies`,
        `- Major world events (geopolitical, regulatory, policy changes)`,
        `- Industry and sector-specific developments`,
        `- Insider transactions and institutional activity`,
        `- Upcoming catalysts (earnings, FDA approvals, product launches)`,
        ``,
        `Use the market-data MCP tools (get_news, get_market_movers) to gather current data.`,
        `Output a concise news analysis in markdown format with impact assessments.`,
        `End with a NEWS_SIGNAL: bullish | neutral | bearish`,
      ].join("\n"),
      max_turns: 15,
    },
    {
      type: "risk",
      name: "Risk Manager",
      prompt: [
        `You are the risk management sub-agent for fund '${fundName}'.`,
        ``,
        `Your job is to assess portfolio risk and ensure compliance with fund constraints.`,
        `Focus on:`,
        `- Current portfolio exposure and concentration risk`,
        `- Stop-loss levels and position sizing validation`,
        `- Drawdown analysis vs. fund limits`,
        `- Correlation between holdings`,
        `- Liquidity risk assessment`,
        `- Distance to objective milestones`,
        ``,
        `Read the fund's portfolio.json, objective_tracker.json, and risk constraints from CLAUDE.md.`,
        `Use broker-alpaca MCP tools to check current positions and account status.`,
        `Output a risk report in markdown format.`,
        `End with RISK_LEVEL: low | moderate | elevated | high`,
      ].join("\n"),
      max_turns: 15,
    },
  ];
}

/**
 * Run a single sub-agent via the Agent SDK and return its result.
 */
async function runSingleSubAgent(
  fundName: string,
  agent: SubAgentConfig,
  model: string | undefined,
  timeout: number,
): Promise<SubAgentResult> {
  const startedAt = new Date().toISOString();

  try {
    const result = await runAgentQuery({
      fundName,
      prompt: agent.prompt,
      model: agent.model ?? model,
      maxTurns: agent.max_turns,
      timeoutMs: timeout,
      maxBudgetUsd: 2.0,
    });

    return {
      type: agent.type,
      name: agent.name,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      status: result.status === "success" ? "success" : result.status === "timeout" ? "timeout" : "error",
      output: result.output,
      error: result.error,
    };
  } catch (err) {
    return {
      type: agent.type,
      name: agent.name,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      status: "error",
      output: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run multiple sub-agents in parallel and collect results.
 * Each agent runs as an independent Agent SDK query.
 */
export async function runSubAgents(
  fundName: string,
  agents: SubAgentConfig[],
  options?: {
    timeoutMinutes?: number;
    model?: string;
  },
): Promise<SubAgentResult[]> {
  const timeout = (options?.timeoutMinutes ?? 10) * 60 * 1000;

  // Launch all sub-agents in parallel
  const promises = agents.map((agent) =>
    runSingleSubAgent(fundName, agent, options?.model, timeout),
  );

  const results = await Promise.allSettled(promises);

  return results.map((r, i) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return {
      type: agents[i].type,
      name: agents[i].name,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      status: "error" as const,
      output: "",
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });
}

/**
 * Merge sub-agent results into a combined analysis markdown document.
 */
export function mergeSubAgentResults(results: SubAgentResult[]): string {
  const sections: string[] = [
    `# Combined Sub-Agent Analysis`,
    ``,
    `Generated: ${new Date().toISOString()}`,
    `Agents: ${results.length}`,
    ``,
  ];

  // Summary table
  sections.push(`## Agent Summary\n`);
  sections.push(`| Agent | Status | Duration |`);
  sections.push(`|-------|--------|----------|`);

  for (const r of results) {
    const started = new Date(r.started_at).getTime();
    const ended = new Date(r.ended_at).getTime();
    const durationSec = ((ended - started) / 1000).toFixed(0);
    const statusIcon =
      r.status === "success" ? "OK" : r.status === "timeout" ? "TIMEOUT" : "ERR";
    sections.push(`| ${r.name} | ${statusIcon} | ${durationSec}s |`);
  }

  sections.push("");

  // Individual agent outputs
  for (const r of results) {
    sections.push(`---`);
    sections.push(`## ${r.name} (${r.type})`);
    sections.push(`Status: ${r.status}`);
    sections.push("");

    if (r.status === "success") {
      sections.push(r.output);
    } else {
      sections.push(`> **Error:** ${r.error ?? "Unknown error"}`);
    }
    sections.push("");
  }

  // Extract signals
  sections.push(`---`);
  sections.push(`## Consolidated Signals\n`);
  for (const r of results) {
    if (r.status !== "success") continue;
    const signalMatch = r.output.match(
      /(?:MACRO_SIGNAL|TECHNICAL_SIGNAL|SENTIMENT_SIGNAL|NEWS_SIGNAL|RISK_LEVEL):\s*(\w+)/gi,
    );
    if (signalMatch) {
      for (const sig of signalMatch) {
        sections.push(`- ${sig}`);
      }
    }
  }

  return sections.join("\n");
}

/**
 * Save sub-agent analysis to the fund's analysis directory.
 */
export async function saveSubAgentAnalysis(
  fundName: string,
  results: SubAgentResult[],
  sessionType: string,
): Promise<string> {
  const paths = fundPaths(fundName);
  const date = new Date().toISOString().split("T")[0];
  const filename = `${date}_${sessionType}_subagents.md`;
  const filePath = join(paths.analysis, filename);

  const combined = mergeSubAgentResults(results);

  await mkdir(paths.analysis, { recursive: true });
  await writeFile(filePath, combined, "utf-8");

  return filePath;
}
