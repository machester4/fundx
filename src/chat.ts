import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { marked, type MarkedExtension } from "marked";
// @ts-expect-error -- marked-terminal has no type declarations
import { markedTerminal } from "marked-terminal";
import { select } from "@inquirer/prompts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadFundConfig, listFundNames } from "./fund.js";
import { loadGlobalConfig } from "./config.js";
import { readPortfolio, readTracker, readSessionLog } from "./state.js";
import { openJournal, getTradeSummary } from "./journal.js";
import { getTradeContextSummary } from "./embeddings.js";
import { buildMcpServers } from "./agent.js";
import { fundPaths, DAEMON_PID, DAEMON_LOG } from "./paths.js";
import type { FundConfig, Portfolio, ObjectiveTracker, SessionLog } from "./types.js";

// ── Types ────────────────────────────────────────────────────

interface ChatOptions {
  fund?: string;
  model?: string;
  search?: boolean;
  readonly?: boolean;
  maxBudget?: string;
}

interface CostTracker {
  total_cost_usd: number;
  total_turns: number;
  messages: number;
}

// ── Layout Helpers ───────────────────────────────────────────

const MARGIN = 2; // left margin spaces
const COL_GAP = 4;

/** Get current terminal width, with sensible fallback */
function termWidth(): number {
  return process.stdout.columns || 100;
}

/** Usable width inside margins */
function contentWidth(): number {
  return termWidth() - MARGIN * 2;
}

/** Left column width (~half minus gap) */
function leftColWidth(): number {
  return Math.floor((contentWidth() - COL_GAP) / 2);
}

/** Strip ANSI escape codes for visible-width measurement */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Pad a string to a visible width, accounting for ANSI codes */
function padEnd(str: string, width: number): string {
  const visible = stripAnsi(str).length;
  const padding = Math.max(0, width - visible);
  return str + " ".repeat(padding);
}

/** Merge two column arrays into formatted lines */
function twoColumns(left: string[], right: string[]): string {
  const lw = leftColWidth();
  const maxLen = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    lines.push(`${" ".repeat(MARGIN)}${padEnd(l, lw)}${" ".repeat(COL_GAP)}${r}`);
  }
  return lines.join("\n");
}

/** Horizontal rule spanning full terminal width */
function rule(label?: string): string {
  const w = termWidth();
  if (!label) return chalk.dim("─".repeat(w));
  const text = ` ${label} `;
  const left = 2;
  const right = Math.max(0, w - left - text.length);
  return chalk.dim("─".repeat(left)) + chalk.dim(text) + chalk.dim("─".repeat(right));
}

// Configure marked with terminal renderer at module level
marked.use(markedTerminal({ tab: 2, reflowText: true }) as MarkedExtension);

/** FundX logo - compact block letters */
const LOGO_LINES = [
  " ███████ █  █ █   █ ████  █   █",
  " █       █  █ ██  █ █   █  █ █ ",
  " █████   █  █ █ █ █ █   █   █  ",
  " █       █  █ █  ██ █   █  █ █ ",
  " █        ██  █   █ ████  █   █",
];

// ── Data Helpers ─────────────────────────────────────────────

/** Check if the daemon process is running */
async function isDaemonRunning(): Promise<{ running: boolean; pid?: number }> {
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
async function getRecentDaemonLogs(
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
function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Render objective progress bar */
function renderProgressBar(pct: number, width = 20): string {
  const clamped = Math.min(100, Math.max(0, pct));
  const filled = Math.round((clamped / 100) * width);
  const color = pct >= 75 ? chalk.green : pct >= 40 ? chalk.yellow : chalk.red;
  return (
    color("█".repeat(filled)) +
    chalk.dim("░".repeat(width - filled)) +
    ` ${pct.toFixed(1)}%`
  );
}

/** Get fund schedule summary lines */
function getScheduleLines(config: FundConfig): string[] {
  const sessions = Object.entries(config.schedule.sessions).filter(
    ([, s]) => s.enabled,
  );
  if (sessions.length === 0) return [chalk.dim("No scheduled sessions")];
  return sessions.map(([name, s]) => chalk.dim(`${name} ${s.time}`));
}

/** Get objective label */
function getObjectiveLabel(config: FundConfig): string {
  const t = config.objective.type;
  if (t === "runway")
    return `Runway (${(config.objective as { target_months: number }).target_months}mo)`;
  if (t === "growth") {
    const m = (config.objective as { target_multiple?: number }).target_multiple;
    return m ? `Growth (${m}x)` : "Growth";
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── Welcome Banner ───────────────────────────────────────────

/** Print the full welcome banner with two-column layout */
async function printWelcome(
  fundName: string,
  fundConfig: FundConfig,
  model: string,
  isReadonly: boolean,
): Promise<void> {
  console.log();

  // ── Header rule ────────────────────
  console.log(rule(`FundX v0.1.0`));
  console.log();

  // ── Load all data upfront ──────────
  let portfolio: Portfolio | null = null;
  let tracker: ObjectiveTracker | null = null;
  let lastSession: SessionLog | null = null;
  let tradeSummary: {
    total_trades: number;
    winning_trades: number;
    total_pnl: number;
    best_trade_pnl: number;
    worst_trade_pnl: number;
  } | null = null;

  try { portfolio = await readPortfolio(fundName); } catch { /* noop */ }
  try { tracker = await readTracker(fundName); } catch { /* noop */ }
  try { lastSession = await readSessionLog(fundName); } catch { /* noop */ }
  try {
    const db = openJournal(fundName);
    try {
      const s = getTradeSummary(db, fundName);
      if (s.total_trades > 0) tradeSummary = s;
    } finally { db.close(); }
  } catch { /* noop */ }

  const daemon = await isDaemonRunning();
  const recentLogs = await getRecentDaemonLogs(fundName);
  const rColWidth = Math.max(30, leftColWidth());

  // ── Row 0: Logo + Fund identity ────
  const statusIcon =
    fundConfig.fund.status === "active" ? chalk.green("●")
    : fundConfig.fund.status === "paused" ? chalk.yellow("◐")
    : chalk.red("○");

  const modeTag = isReadonly
    ? chalk.bgYellow.black(" READ-ONLY ")
    : fundConfig.broker.mode === "live"
      ? chalk.bgRed.white(" LIVE ")
      : chalk.bgBlue.white(" PAPER ");

  // Right side: fund identity + automation stacked
  const rightHeader: string[] = [
    `${statusIcon} ${chalk.bold.white(fundConfig.fund.display_name)}  ${modeTag}`,
    chalk.dim(`${fundName} · ${fundConfig.risk.profile} · ${fundConfig.broker.provider}`),
  ];
  if (fundConfig.fund.description) {
    rightHeader.push(chalk.dim(fundConfig.fund.description.slice(0, rColWidth)));
  }
  rightHeader.push("");

  // Automation block
  const daemonLabel = daemon.running
    ? chalk.green("●") + chalk.green(` running`) + chalk.dim(` (PID ${daemon.pid})`)
    : chalk.dim("○ stopped");
  const schedLines = getScheduleLines(fundConfig);
  rightHeader.push(chalk.bold("Automation"));
  rightHeader.push(`Daemon: ${daemonLabel}`);
  for (const s of schedLines) rightHeader.push(s);

  // Left side: logo lines padded to match
  const leftLogo: string[] = [
    ...LOGO_LINES.map((l) => chalk.cyan(l)),
  ];
  // Pad logo to match right side length
  while (leftLogo.length < rightHeader.length) {
    leftLogo.push("");
  }

  console.log(twoColumns(leftLogo, rightHeader));
  console.log();

  // ── Row 1: Portfolio + Recent activity ──
  const leftPortfolio: string[] = [chalk.bold("Portfolio")];
  const rightActivity: string[] = [chalk.bold("Recent activity")];

  if (portfolio) {
    const pnl = portfolio.total_value - (tracker?.initial_capital ?? portfolio.total_value);
    const pnlPct = tracker?.initial_capital
      ? ((pnl / tracker.initial_capital) * 100)
      : 0;
    const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
    const pnlSign = pnl >= 0 ? "+" : "";
    const cashPct = portfolio.total_value > 0
      ? ((portfolio.cash / portfolio.total_value) * 100).toFixed(0)
      : "0";

    leftPortfolio.push(
      `${chalk.bold(`$${portfolio.total_value.toLocaleString()}`)}  ${pnlColor(`${pnlSign}$${Math.abs(pnl).toFixed(0)} (${pnlSign}${pnlPct.toFixed(1)}%)`)}`,
    );
    leftPortfolio.push(
      chalk.dim(`Cash $${portfolio.cash.toLocaleString()} (${cashPct}%) · ${portfolio.positions.length} positions`),
    );

    // Top positions (compact)
    if (portfolio.positions.length > 0) {
      leftPortfolio.push("");
      const sorted = [...portfolio.positions].sort(
        (a, b) => b.market_value - a.market_value,
      );
      for (const p of sorted.slice(0, 5)) {
        const pc = p.unrealized_pnl >= 0 ? chalk.green : chalk.red;
        const sign = p.unrealized_pnl >= 0 ? "+" : "";
        leftPortfolio.push(
          `${chalk.bold(p.symbol.padEnd(6))} ${p.shares.toString().padStart(5)}sh  ${pc(`${sign}${p.unrealized_pnl_pct.toFixed(1)}%`.padStart(7))}`,
        );
      }
      if (sorted.length > 5) {
        leftPortfolio.push(chalk.dim(`+${sorted.length - 5} more`));
      }
    }
  } else {
    leftPortfolio.push(chalk.dim("No portfolio data yet"));
  }
  leftPortfolio.push("");

  // Right: Recent activity
  if (lastSession) {
    const ago = timeAgo(lastSession.started_at);
    const trades = lastSession.trades_executed > 0
      ? chalk.cyan(`${lastSession.trades_executed} trades`)
      : chalk.dim("0 trades");
    rightActivity.push(`${lastSession.session_type} · ${ago} · ${trades}`);
    if (lastSession.summary) {
      const maxLen = Math.min(rColWidth, 50);
      const trunc = lastSession.summary.slice(0, maxLen);
      rightActivity.push(chalk.dim(`${trunc}${lastSession.summary.length > maxLen ? "..." : ""}`));
    }
  } else {
    rightActivity.push(chalk.dim("No sessions yet"));
  }

  if (recentLogs.length > 0) {
    rightActivity.push("");
    for (const line of recentLogs) {
      const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (match) {
        const ago = timeAgo(match[1]);
        const maxLen = Math.min(rColWidth - 12, 40);
        rightActivity.push(chalk.dim(`${ago}: ${match[2].slice(0, maxLen)}`));
      } else {
        rightActivity.push(chalk.dim(line.slice(0, rColWidth)));
      }
    }
  }
  rightActivity.push("");

  console.log(twoColumns(leftPortfolio, rightActivity));

  // ── Row 2: Objective + Trades ──────
  const leftObjective: string[] = [chalk.bold("Objective")];
  const rightTrades: string[] = [chalk.bold("Trades")];

  if (tracker) {
    const label = getObjectiveLabel(fundConfig);
    const statusColor =
      tracker.status === "ahead" ? chalk.green
      : tracker.status === "on_track" ? chalk.cyan
      : tracker.status === "behind" ? chalk.yellow
      : chalk.green;
    leftObjective.push(`${label} · ${statusColor(tracker.status.replace("_", " "))}`);
    const barWidth = Math.min(leftColWidth() - 10, 25);
    leftObjective.push(renderProgressBar(tracker.progress_pct, barWidth));
  } else {
    leftObjective.push(chalk.dim("No objective data yet"));
  }
  leftObjective.push("");

  if (tradeSummary) {
    const winRate = ((tradeSummary.winning_trades / tradeSummary.total_trades) * 100).toFixed(0);
    const pnlColor = tradeSummary.total_pnl >= 0 ? chalk.green : chalk.red;
    const pnlSign = tradeSummary.total_pnl >= 0 ? "+" : "";
    rightTrades.push(
      `${tradeSummary.total_trades} closed · Win ${chalk.bold(winRate + "%")}`,
    );
    rightTrades.push(
      `P&L: ${pnlColor(`${pnlSign}$${tradeSummary.total_pnl.toFixed(2)}`)}`,
    );
    rightTrades.push(
      chalk.dim(`Best +$${tradeSummary.best_trade_pnl.toFixed(0)} · Worst $${tradeSummary.worst_trade_pnl.toFixed(0)}`),
    );
  } else {
    rightTrades.push(chalk.dim("No closed trades yet"));
  }
  rightTrades.push("");

  console.log(twoColumns(leftObjective, rightTrades));

  // ── Footer ─────────────────────────
  console.log(rule());
  console.log(
    chalk.dim(`  ${model} · ${fundConfig.risk.profile} · ${fundConfig.broker.provider} (${isReadonly ? "read-only" : fundConfig.broker.mode}) · /help for commands`),
  );
  console.log(rule());
  console.log();
}

function printCostSummary(tracker: CostTracker): void {
  console.log();
  console.log(rule());
  console.log(`  Cost: ${chalk.bold(`$${tracker.total_cost_usd.toFixed(4)}`)}  ${chalk.dim(`│`)}  Messages: ${tracker.messages}  ${chalk.dim(`│`)}  Turns: ${tracker.total_turns}`);
  console.log(rule());
  console.log();
}

// ── Context Builders ─────────────────────────────────────────

/** Build full fund context for the first turn */
async function buildChatContext(fundName: string): Promise<string> {
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
          `  - ${p.symbol}: ${p.shares} shares @ $${p.avg_cost.toFixed(2)} → $${p.current_price.toFixed(2)} (${pnlSign}${p.unrealized_pnl_pct.toFixed(1)}%)`,
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
async function buildCompactContext(fundName: string): Promise<string> {
  try {
    const portfolio = await readPortfolio(fundName);
    const posCount = portfolio.positions.length;
    return `[Fund ${fundName}: cash $${portfolio.cash.toFixed(2)}, value $${portfolio.total_value.toFixed(2)}, ${posCount} positions]`;
  } catch {
    return `[Fund ${fundName}: portfolio data unavailable]`;
  }
}

// ── Chat Turn ────────────────────────────────────────────────

/** Run a single chat turn with streaming output */
async function runChatTurn(
  fundName: string,
  sessionId: string | undefined,
  message: string,
  context: string,
  opts: {
    model: string;
    maxBudgetUsd?: number;
    readonly: boolean;
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  },
): Promise<{ sessionId: string; cost_usd: number; num_turns: number }> {
  const paths = fundPaths(fundName);

  const readonlyNote = opts.readonly
    ? "\nIMPORTANT: This is a READ-ONLY session. Do NOT execute trades or modify state files."
    : "";

  const prompt = sessionId
    ? `${context}\n${readonlyNote}\n\n${message}`
    : [
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
      ].join("\n");

  let resultSessionId = sessionId ?? "";
  let costUsd = 0;
  let numTurns = 0;

  const spinner = ora({ text: chalk.cyan("Thinking..."), indent: 2 }).start();
  let responseBuffer = "";
  let charCount = 0;

  for await (const msg of query({
    prompt,
    options: {
      model: opts.model,
      maxTurns: 30,
      maxBudgetUsd: opts.maxBudgetUsd,
      cwd: paths.root,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
      mcpServers: opts.mcpServers,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      ...(sessionId ? { resume: sessionId } : {}),
    },
  })) {
    // Capture session_id from init
    if (
      msg.type === "system" &&
      "subtype" in msg &&
      msg.subtype === "init"
    ) {
      resultSessionId = msg.session_id;
    }

    // Accumulate text deltas
    if (msg.type === "stream_event") {
      const event = msg.event as {
        type?: string;
        delta?: { type?: string; text?: string };
      };
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          responseBuffer += event.delta.text;
          charCount += event.delta.text.length;
          spinner.text = chalk.cyan(`Generating response... ${charCount} chars`);
        }
      }
    }

    // Capture result
    if (msg.type === "result") {
      const result = msg as SDKResultMessage;
      costUsd = result.total_cost_usd;
      numTurns = result.num_turns;
      resultSessionId = result.session_id;
    }
  }

  spinner.stop();

  if (responseBuffer) {
    console.log(`\n  ${chalk.cyan("●")} ${chalk.bold.cyan("fundx")}\n`);
    const formatted = (marked.parse(responseBuffer) as string).trimEnd();
    const indented = formatted
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    console.log(indented);
  }

  return { sessionId: resultSessionId, cost_usd: costUsd, num_turns: numTurns };
}

// ── Slash Commands ───────────────────────────────────────────

async function handleSlashCommand(
  input: string,
  fundName: string,
  costTracker: CostTracker,
  fundConfig: FundConfig,
  model: string,
  isReadonly: boolean,
): Promise<"continue" | "clear" | "exit" | null> {
  const cmd = input.trim().toLowerCase();

  if (cmd === "/help") {
    console.log(chalk.bold("\n  Chat Commands"));
    console.log(`    ${chalk.cyan("/help")}      Show this help`);
    console.log(`    ${chalk.cyan("/status")}    Show fund status summary`);
    console.log(`    ${chalk.cyan("/cost")}      Show session cost`);
    console.log(`    ${chalk.cyan("/clear")}     Reset conversation (new session)`);
    console.log(`    ${chalk.cyan("/q")}         Exit chat`);
    console.log();
    console.log(chalk.dim("    You can also type 'exit' or 'quit' to leave."));
    console.log();
    return "continue";
  }

  if (cmd === "/cost") {
    printCostSummary(costTracker);
    return "continue";
  }

  if (cmd === "/status") {
    await printStatusCard(fundName, fundConfig, model, isReadonly, costTracker);
    return "continue";
  }

  if (cmd === "/clear") {
    console.log(chalk.yellow("\n  Session cleared. Starting fresh.\n"));
    return "clear";
  }

  if (cmd === "/q") {
    return "exit";
  }

  if (cmd.startsWith("/")) {
    console.log(chalk.yellow(`  Unknown command: ${cmd}. Type /help for options.`));
    return "continue";
  }

  return null;
}

/** Inline status card for /status command */
async function printStatusCard(
  fundName: string,
  fundConfig: FundConfig,
  model: string,
  isReadonly: boolean,
  costTracker: CostTracker,
): Promise<void> {
  console.log();
  console.log(rule("Status"));

  const statusIcon =
    fundConfig.fund.status === "active" ? chalk.green("●") : chalk.yellow("◐");
  const modeLabel = isReadonly ? "read-only" : fundConfig.broker.mode;

  const leftLines: string[] = [
    `${statusIcon} ${chalk.bold(fundConfig.fund.display_name)} ${chalk.dim(`[${modeLabel}]`)}`,
  ];
  const rightLines: string[] = [];

  try {
    const portfolio = await readPortfolio(fundName);
    const tracker = await readTracker(fundName).catch(() => null);
    const pnl = portfolio.total_value - (tracker?.initial_capital ?? portfolio.total_value);
    const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
    const pnlSign = pnl >= 0 ? "+" : "";
    leftLines.push(
      `$${portfolio.total_value.toLocaleString()} ${pnlColor(`${pnlSign}$${Math.abs(pnl).toFixed(0)}`)}`,
    );
    leftLines.push(
      chalk.dim(`Cash $${portfolio.cash.toLocaleString()} · ${portfolio.positions.length} pos`),
    );
    if (tracker) {
      leftLines.push(renderProgressBar(tracker.progress_pct, 15));
    }
  } catch {
    leftLines.push(chalk.dim("Portfolio data unavailable"));
  }

  const daemon = await isDaemonRunning();
  rightLines.push(chalk.dim(`Model: ${model}`));
  rightLines.push(chalk.dim(`Messages: ${costTracker.messages} · Cost: $${costTracker.total_cost_usd.toFixed(4)}`));
  rightLines.push(chalk.dim(`Daemon: ${daemon.running ? "running" : "stopped"}`));

  console.log(twoColumns(leftLines, rightLines));
  console.log(rule());
  console.log();
}

// ── Main Chat Loop ───────────────────────────────────────────

async function runChat(options: ChatOptions): Promise<void> {
  // Resolve fund
  const allFunds = await listFundNames();
  if (allFunds.length === 0) {
    console.log(
      chalk.yellow("  No funds found. Create one first: fundx fund create"),
    );
    return;
  }

  let fundName: string;
  if (options.fund) {
    if (!allFunds.includes(options.fund)) {
      console.log(chalk.red(`  Fund '${options.fund}' not found.`));
      return;
    }
    fundName = options.fund;
  } else if (allFunds.length === 1) {
    fundName = allFunds[0];
  } else {
    fundName = await select({
      message: "Select a fund:",
      choices: allFunds.map((f) => ({ name: f, value: f })),
    });
  }

  const fundConfig = await loadFundConfig(fundName);
  const globalConfig = await loadGlobalConfig();
  const mcpServers = await buildMcpServers(fundName);
  const model =
    options.model ??
    fundConfig.claude.model ??
    globalConfig.default_model ??
    "sonnet";
  const isReadonly = options.readonly ?? false;
  const maxBudgetUsd = options.maxBudget ? parseFloat(options.maxBudget) : undefined;

  await printWelcome(fundName, fundConfig, model, isReadonly);

  // State
  let sessionId: string | undefined;
  let turnCount = 0;
  const costTracker: CostTracker = { total_cost_usd: 0, total_turns: 0, messages: 0 };

  // Readline REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `  ${chalk.green("●")} `,
  });

  const promptUser = (): void => {
    rl.prompt();
  };

  rl.on("line", async (line: string) => {
    const trimmed = line.trim();

    // Skip empty input
    if (!trimmed) {
      promptUser();
      return;
    }

    // Handle exit keywords
    if (trimmed === "exit" || trimmed === "quit") {
      rl.close();
      return;
    }

    // Handle slash commands
    const slashResult = await handleSlashCommand(
      trimmed,
      fundName,
      costTracker,
      fundConfig,
      model,
      isReadonly,
    );
    if (slashResult === "exit") {
      rl.close();
      return;
    }
    if (slashResult === "clear") {
      sessionId = undefined;
      turnCount = 0;
      promptUser();
      return;
    }
    if (slashResult === "continue") {
      promptUser();
      return;
    }

    // Build context
    try {
      const context =
        turnCount === 0
          ? await buildChatContext(fundName)
          : await buildCompactContext(fundName);

      const result = await runChatTurn(fundName, sessionId, trimmed, context, {
        model,
        maxBudgetUsd,
        readonly: isReadonly,
        mcpServers,
      });

      sessionId = result.sessionId;
      turnCount++;
      costTracker.total_cost_usd += result.cost_usd;
      costTracker.total_turns += result.num_turns;
      costTracker.messages++;

      console.log(
        chalk.dim(`  [$${result.cost_usd.toFixed(4)} | ${result.num_turns} turns]`),
      );
    } catch (err) {
      console.log(
        chalk.red(`\n  Error: ${err instanceof Error ? err.message : String(err)}\n`),
      );
    }

    promptUser();
  });

  rl.on("close", () => {
    console.log();
    printCostSummary(costTracker);
    console.log(chalk.dim("  Goodbye!\n"));
    process.exit(0);
  });

  // Handle Ctrl+C
  rl.on("SIGINT", () => {
    rl.close();
  });

  promptUser();
}

// ── CLI Command ──────────────────────────────────────────────

export const chatCommand = new Command("chat")
  .description("Interactive chat with a fund's AI agent")
  .option("-f, --fund <name>", "Fund to chat with")
  .option("-m, --model <model>", "Claude model (sonnet, opus, haiku)")
  .option("-s, --search", "Enable trade history search in context")
  .option("-r, --readonly", "Read-only mode (no trades)")
  .option("--max-budget <usd>", "Maximum budget in USD for the session")
  .action(async (opts: ChatOptions) => {
    try {
      await runChat(opts);
    } catch (err) {
      console.error(chalk.red(`Chat failed: ${err}`));
      process.exit(1);
    }
  });
