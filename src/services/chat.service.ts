import { readFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadFundConfig, listFundNames } from "./fund.service.js";
import { loadGlobalConfig } from "../config.js";
import { readPortfolio, readTracker, readSessionLog, readActiveSession, writeActiveSession, initFundState } from "../state.js";
import { openJournal, getTradeSummary } from "../journal.js";
import { getTradeContextSummary } from "../embeddings.js";
import { buildMcpServers } from "../agent.js";
import { generateFundClaudeMd } from "../template.js";
import { ensureFundSkillFiles } from "../skills.js";
import { fundPaths, WORKSPACE, DAEMON_PID, DAEMON_LOG, MCP_SERVERS } from "../paths.js";
import type { FundConfig, Portfolio, ObjectiveTracker } from "../types.js";

// ── Types ────────────────────────────────────────────────────

export interface ChatOptions {
  fund?: string;
  model?: string;
  search?: boolean;
  readonly?: boolean;
  maxBudget?: string;
}

export interface CostTracker {
  total_cost_usd: number;
  total_turns: number;
  messages: number;
}

export interface ChatTurnResult {
  sessionId: string;
  cost_usd: number;
  num_turns: number;
  responseText: string;
}

export interface TradeSummaryData {
  total_trades: number;
  winning_trades: number;
  total_pnl: number;
  best_trade_pnl: number;
  worst_trade_pnl: number;
}

export interface ChatWelcomeData {
  fundConfig: FundConfig;
  fundName: string;
  model: string;
  isReadonly: boolean;
  portfolio: Portfolio | null;
  tracker: ObjectiveTracker | null;
  lastSession: { session_type: string; started_at: string; trades_executed: number; summary?: string } | null;
  tradeSummary: TradeSummaryData | null;
  daemon: { running: boolean; pid?: number };
  recentLogs: string[];
}

// ── FundX logo ──────────────────────────────────────────────

export const LOGO_LINES = [
  " \u2588\u2588\u2588\u2588\u2588\u2588\u2588 \u2588  \u2588 \u2588   \u2588 \u2588\u2588\u2588\u2588  \u2588   \u2588",
  " \u2588       \u2588  \u2588 \u2588\u2588  \u2588 \u2588   \u2588  \u2588 \u2588 ",
  " \u2588\u2588\u2588\u2588\u2588   \u2588  \u2588 \u2588 \u2588 \u2588 \u2588   \u2588   \u2588  ",
  " \u2588       \u2588  \u2588 \u2588  \u2588\u2588 \u2588   \u2588  \u2588 \u2588 ",
  " \u2588        \u2588\u2588  \u2588   \u2588 \u2588\u2588\u2588\u2588  \u2588   \u2588",
];

// ── Data Helpers ─────────────────────────────────────────────

/** Check if the daemon process is running */
export async function getDaemonStatus(): Promise<{ running: boolean; pid?: number }> {
  if (!existsSync(DAEMON_PID)) return { running: false };
  try {
    const pid = parseInt(await readFile(DAEMON_PID, "utf-8"), 10);
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

/** Get last few daemon log lines relevant to this fund */
export async function getRecentDaemonLogs(
  fundName: string,
  maxLines = 3,
): Promise<string[]> {
  if (!existsSync(DAEMON_LOG)) return [];
  try {
    const content = await readFile(DAEMON_LOG, "utf-8");
    const lines = content.trim().split("\n");
    return lines
      .filter((l) => l.toLowerCase().includes(fundName.toLowerCase()))
      .slice(-maxLines);
  } catch {
    return [];
  }
}

/** Format a date string relative to now */
export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Get objective label */
export function getObjectiveLabel(config: FundConfig): string {
  const t = config.objective.type;
  if (t === "runway")
    return `Runway (${(config.objective as { target_months: number }).target_months}mo)`;
  if (t === "growth") {
    const m = (config.objective as { target_multiple?: number }).target_multiple;
    return m ? `Growth (${m}x)` : "Growth";
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Get fund schedule summary */
export function getScheduleLines(config: FundConfig): string[] {
  const sessions = Object.entries(config.schedule.sessions).filter(
    ([, s]) => s.enabled,
  );
  if (sessions.length === 0) return ["No scheduled sessions"];
  return sessions.map(([name, s]) => `${name} ${s.time}`);
}

/** Load all welcome data for the chat banner. Returns null in workspace mode (no fund). */
export async function loadChatWelcomeData(
  fundName: string | null,
  model: string,
  isReadonly: boolean,
): Promise<ChatWelcomeData | null> {
  if (!fundName) return null;
  const fundConfig = await loadFundConfig(fundName);

  let portfolio: Portfolio | null = null;
  let tracker: ObjectiveTracker | null = null;
  let lastSession: ChatWelcomeData["lastSession"] = null;
  let tradeSummary: TradeSummaryData | null = null;

  try { portfolio = await readPortfolio(fundName); } catch { /* noop */ }
  try { tracker = await readTracker(fundName); } catch { /* noop */ }
  try {
    const s = await readSessionLog(fundName);
    if (s) lastSession = s;
  } catch { /* noop */ }
  try {
    const db = openJournal(fundName);
    try {
      const s = getTradeSummary(db, fundName);
      if (s.total_trades > 0) tradeSummary = s;
    } finally { db.close(); }
  } catch { /* noop */ }

  const daemon = await getDaemonStatus();
  const recentLogs = await getRecentDaemonLogs(fundName);

  return {
    fundConfig,
    fundName,
    model,
    isReadonly,
    portfolio,
    tracker,
    lastSession,
    tradeSummary,
    daemon,
    recentLogs,
  };
}

// ── Context Builders ─────────────────────────────────────────

/** Build runtime context for workspace mode.
 * Static instructions come from ~/.fundx/CLAUDE.md loaded by the Agent SDK.
 * This only provides dynamic state that changes between sessions. */
export async function buildWorkspaceContext(): Promise<string> {
  const allFunds = await listFundNames();
  const globalConfig = await loadGlobalConfig();

  return [
    `## Workspace State`,
    `Existing funds: ${allFunds.length === 0 ? "none yet" : allFunds.join(", ")}`,
    `Broker: ${globalConfig.broker.provider} (${globalConfig.broker.mode} mode)`,
    `Model: ${globalConfig.default_model ?? "sonnet"}`,
  ].join("\n");
}

/** Build full fund context for the first turn */
export async function buildChatContext(fundName: string | null): Promise<string> {
  if (!fundName) return buildWorkspaceContext();
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
    sections.push(`## Fund: ${fundName} (config unavailable)\n`);
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
          `Win rate: ${((summary.winning_trades / summary.total_trades) * 100).toFixed(0)}%`,
        );
        sections.push(`Total P&L: $${summary.total_pnl.toFixed(2)}`);
        sections.push(`Best trade: $${summary.best_trade_pnl.toFixed(2)}`);
        sections.push(`Worst trade: $${summary.worst_trade_pnl.toFixed(2)}`);
        sections.push("");
      }

      const context = getTradeContextSummary(db, fundName, 10);
      if (context) sections.push(context);
    } finally {
      db.close();
    }
  } catch {
    // Journal may not exist yet
  }

  return sections.join("\n");
}

/** Build compact context refresh for turn 2+ */
export async function buildCompactContext(fundName: string | null): Promise<string> {
  if (!fundName) return "[Workspace mode — no fund selected]";
  try {
    const portfolio = await readPortfolio(fundName);
    const posCount = portfolio.positions.length;
    return `[Fund ${fundName}: cash $${portfolio.cash.toFixed(2)}, value $${portfolio.total_value.toFixed(2)}, ${posCount} positions]`;
  } catch {
    return `[Fund ${fundName}: portfolio data unavailable]`;
  }
}

// ── Chat Turn ────────────────────────────────────────────────

/** Run a single chat turn with streaming output, returning the response text */
export async function runChatTurn(
  fundName: string | null,
  sessionId: string | undefined,
  message: string,
  context: string,
  opts: {
    model: string;
    maxBudgetUsd?: number;
    readonly: boolean;
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  },
  callbacks?: {
    onStreamStart?: () => void;
    onStreamDelta?: (text: string, totalChars: number) => void;
    onStreamEnd?: () => void;
  },
): Promise<ChatTurnResult> {
  const cwd = fundName ? fundPaths(fundName).root : WORKSPACE;

  const readonlyNote = opts.readonly
    ? "\nIMPORTANT: This is a READ-ONLY session. Do NOT execute trades or modify state files."
    : "";

  const prompt = sessionId
    ? `${context}\n${readonlyNote}\n\n${message}`
    : fundName
    ? [
        `You are an interactive assistant for the FundX investment fund "${fundName}".`,
        `You have access to MCP tools for market data and broker operations.`,
        `Be concise and helpful. Use specific numbers when available.`,
        readonlyNote,
        "",
        "## Current Fund State",
        context,
        "",
        "## User Message",
        message,
      ].join("\n")
    : [
        context,
        "",
        "## User Message",
        message,
      ].join("\n");

  let resultSessionId = sessionId ?? "";
  let costUsd = 0;
  let numTurns = 0;

  callbacks?.onStreamStart?.();
  let responseBuffer = "";
  let charCount = 0;

  for await (const msg of query({
    prompt,
    options: {
      model: opts.model,
      maxTurns: 30,
      maxBudgetUsd: opts.maxBudgetUsd,
      cwd,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      mcpServers: opts.mcpServers,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      ...(sessionId ? { resume: sessionId } : {}),
    },
  })) {
    if (
      msg.type === "system" &&
      "subtype" in msg &&
      msg.subtype === "init"
    ) {
      resultSessionId = msg.session_id;
    }

    if (msg.type === "stream_event") {
      const event = msg.event as {
        type?: string;
        delta?: { type?: string; text?: string };
      };
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          responseBuffer += event.delta.text;
          charCount += event.delta.text.length;
          callbacks?.onStreamDelta?.(event.delta.text, charCount);
        }
      }
    }

    if (msg.type === "result") {
      const result = msg as SDKResultMessage;
      costUsd = result.total_cost_usd;
      numTurns = result.num_turns;
      resultSessionId = result.session_id;
    }
  }

  callbacks?.onStreamEnd?.();

  return {
    sessionId: resultSessionId,
    cost_usd: costUsd,
    num_turns: numTurns,
    responseText: responseBuffer,
  };
}

/** Resolve which fund to use for chat.
 * Returns fundName=null when no funds exist (workspace mode). */
export async function resolveChatFund(
  fundOption?: string,
): Promise<{ fundName: string | null; allFunds: string[] }> {
  const allFunds = await listFundNames();

  if (fundOption) {
    if (!allFunds.includes(fundOption)) {
      throw new Error(`Fund '${fundOption}' not found.`);
    }
    return { fundName: fundOption, allFunds };
  }

  if (allFunds.length === 0) {
    // No funds — enter workspace mode where Claude can create one
    return { fundName: null, allFunds };
  }

  if (allFunds.length === 1) {
    return { fundName: allFunds[0], allFunds };
  }

  // Multiple funds — caller needs to prompt for selection
  return { fundName: null, allFunds };
}

/** Resolve model for chat */
export async function resolveChatModel(
  fundName: string | null,
  modelOption?: string,
): Promise<string> {
  const globalConfig = await loadGlobalConfig();
  if (!fundName) {
    return modelOption ?? globalConfig.default_model ?? "sonnet";
  }
  const fundConfig = await loadFundConfig(fundName);
  return (
    modelOption ??
    fundConfig.claude.model ??
    globalConfig.default_model ??
    "sonnet"
  );
}

/** Persist the current chat session ID so the daemon can resume it */
export async function persistChatSession(fundName: string | null, sessionId: string): Promise<void> {
  if (!fundName) return; // workspace mode — no persistence
  await writeActiveSession(fundName, {
    session_id: sessionId,
    updated_at: new Date().toISOString(),
    source: "chat",
  });
}

/** Load the active session ID (chat or daemon) for resumption.
 * Returns undefined if no session exists (ENOENT). Other errors propagate. */
export async function loadActiveSessionId(fundName: string | null): Promise<string | undefined> {
  if (!fundName) return undefined;
  const active = await readActiveSession(fundName);
  return active?.session_id;
}

/** Build MCP servers config for chat.
 * In workspace mode (null fundName) only market-data is included — no broker, no telegram. */
export async function buildChatMcpServers(
  fundName: string | null,
): Promise<Record<string, { command: string; args: string[]; env: Record<string, string> }>> {
  if (fundName) return buildMcpServers(fundName);

  const globalConfig = await loadGlobalConfig();
  const marketDataEnv: Record<string, string> = {};
  if (globalConfig.broker.api_key) marketDataEnv.ALPACA_API_KEY = globalConfig.broker.api_key;
  if (globalConfig.broker.secret_key) marketDataEnv.ALPACA_SECRET_KEY = globalConfig.broker.secret_key;
  if (globalConfig.market_data?.fmp_api_key) marketDataEnv.FMP_API_KEY = globalConfig.market_data.fmp_api_key;
  marketDataEnv.ALPACA_MODE = globalConfig.broker.mode ?? "paper";

  return {
    "market-data": {
      command: "node",
      args: [MCP_SERVERS.marketData],
      env: marketDataEnv,
    },
  };
}

/** Complete fund initialization after Claude has written a fund_config.yaml.
 * Idempotent — safe to call even if state was already initialized. */
export async function completeFundSetup(fundName: string): Promise<void> {
  const config = await loadFundConfig(fundName);
  const paths = fundPaths(fundName);

  const claudeMdExists = await access(paths.claudeMd).then(() => true).catch(() => false);
  if (!claudeMdExists) {
    await generateFundClaudeMd(config);
  }

  const portfolioExists = await access(paths.state.portfolio).then(() => true).catch(() => false);
  if (!portfolioExists) {
    await initFundState(fundName, config.capital.initial, config.objective.type);
  }

  await ensureFundSkillFiles(paths.claudeDir);
}
