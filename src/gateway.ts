import { Bot, Context } from "grammy";
import { Command } from "commander";
import chalk from "chalk";
import { loadGlobalConfig } from "./config.js";
import { listFundNames, loadFundConfig } from "./fund.js";
import { readPortfolio, readTracker, readSessionLog } from "./state.js";
import type { GlobalConfig } from "./types.js";

// ── Bot instance (module-level for use in daemon) ────────────

let bot: Bot | null = null;
let globalConfig: GlobalConfig | null = null;

// ── Quick command handlers (no Claude needed) ────────────────

async function handleStatus(ctx: Context, fundName?: string): Promise<void> {
  if (fundName) {
    await handleFundStatus(ctx, fundName);
    return;
  }

  const names = await listFundNames();
  if (names.length === 0) {
    await ctx.reply("No funds configured yet.");
    return;
  }

  let response = "<b>FundX Dashboard</b>\n\n";

  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      const portfolio = await readPortfolio(name).catch(() => null);
      const tracker = await readTracker(name).catch(() => null);

      const statusIcon = config.fund.status === "active" ? "🟢" : "🟡";
      const pnl = portfolio
        ? portfolio.total_value - config.capital.initial
        : 0;
      const pnlPct = portfolio
        ? ((pnl / config.capital.initial) * 100).toFixed(1)
        : "0.0";
      const pnlStr =
        pnl >= 0
          ? `+$${pnl.toFixed(0)} (+${pnlPct}%)`
          : `-$${Math.abs(pnl).toFixed(0)} (${pnlPct}%)`;

      response += `${statusIcon} <b>${config.fund.display_name}</b> (${name})\n`;
      response += `Capital: $${(portfolio?.total_value ?? config.capital.initial).toLocaleString()} ${pnlStr}\n`;

      if (tracker) {
        response += `Progress: ${tracker.progress_pct.toFixed(1)}% — ${tracker.status}\n`;
      }

      if (portfolio && portfolio.positions.length > 0) {
        const cashPct = ((portfolio.cash / portfolio.total_value) * 100).toFixed(0);
        response += `Positions: ${portfolio.positions.length} | Cash: ${cashPct}%\n`;
      }

      response += "\n";
    } catch {
      response += `❌ ${name} — error reading state\n\n`;
    }
  }

  await ctx.reply(response, { parse_mode: "HTML" });
}

async function handleFundStatus(ctx: Context, fundName: string): Promise<void> {
  try {
    const config = await loadFundConfig(fundName);
    const portfolio = await readPortfolio(fundName).catch(() => null);
    const tracker = await readTracker(fundName).catch(() => null);
    const lastSession = await readSessionLog(fundName);

    const statusIcon = config.fund.status === "active" ? "🟢" : "🟡";
    const pnl = portfolio
      ? portfolio.total_value - config.capital.initial
      : 0;
    const pnlPct = portfolio
      ? ((pnl / config.capital.initial) * 100).toFixed(1)
      : "0.0";
    const pnlStr =
      pnl >= 0
        ? `+$${pnl.toFixed(0)} (+${pnlPct}%)`
        : `-$${Math.abs(pnl).toFixed(0)} (${pnlPct}%)`;

    let response = `${statusIcon} <b>${config.fund.display_name}</b>\n`;
    response += `──────────────────────────\n`;
    response += `Status: ${config.fund.status}\n`;
    response += `Capital: $${config.capital.initial.toLocaleString()} → $${(portfolio?.total_value ?? config.capital.initial).toLocaleString()} ${pnlStr}\n`;
    response += `Objective: ${config.objective.type}\n`;
    response += `Risk: ${config.risk.profile}\n`;
    response += `Broker: ${config.broker.provider} (${config.broker.mode})\n`;

    if (tracker) {
      response += `\nProgress: ${tracker.progress_pct.toFixed(1)}% — ${tracker.status}\n`;
    }

    if (portfolio && portfolio.positions.length > 0) {
      const cashPct = ((portfolio.cash / portfolio.total_value) * 100).toFixed(0);
      response += `\nPositions: ${portfolio.positions.length}\n`;
      response += `Cash: ${cashPct}% | Exposure: ${(100 - parseFloat(cashPct)).toFixed(0)}%\n`;
    }

    if (lastSession) {
      response += `\nLast session: ${lastSession.session_type} (${lastSession.started_at})`;
    }

    await ctx.reply(response, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(`Fund '${fundName}' not found or error reading state.`);
  }
}

async function handlePortfolio(ctx: Context, fundName: string): Promise<void> {
  try {
    const config = await loadFundConfig(fundName);
    const portfolio = await readPortfolio(fundName);

    let response = `💼 <b>Portfolio — ${config.fund.display_name}</b>\n`;
    response += `──────────────────────────\n`;
    response += `Total: $${portfolio.total_value.toLocaleString()}\n`;
    response += `Cash: $${portfolio.cash.toLocaleString()}\n\n`;

    if (portfolio.positions.length === 0) {
      response += "No open positions.";
    } else {
      for (const pos of portfolio.positions) {
        const pnlSign = pos.unrealized_pnl >= 0 ? "+" : "";
        response += `<b>${pos.symbol}</b> — ${pos.shares} shares @ $${pos.avg_cost.toFixed(2)}\n`;
        response += `  Current: $${pos.current_price.toFixed(2)} | P&amp;L: ${pnlSign}$${pos.unrealized_pnl.toFixed(2)} (${pnlSign}${pos.unrealized_pnl_pct.toFixed(1)}%)\n`;
        response += `  Weight: ${pos.weight_pct.toFixed(1)}%`;
        if (pos.stop_loss) response += ` | Stop: $${pos.stop_loss.toFixed(2)}`;
        response += "\n\n";
      }
    }

    await ctx.reply(response, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(`Could not read portfolio for '${fundName}'.`);
  }
}

async function handleTrades(ctx: Context, fundName: string, _period?: string): Promise<void> {
  try {
    const config = await loadFundConfig(fundName);
    // For now, read from session log — full trade journal access requires importing journal.ts
    const lastSession = await readSessionLog(fundName);

    let response = `📈 <b>Trades — ${config.fund.display_name}</b>\n`;
    response += `──────────────────────────\n`;

    if (lastSession && lastSession.trades_executed > 0) {
      response += `Last session: ${lastSession.session_type}\n`;
      response += `Trades executed: ${lastSession.trades_executed}\n`;
      if (lastSession.summary) response += `Summary: ${lastSession.summary}`;
    } else {
      response += "No recent trades recorded.";
    }

    await ctx.reply(response, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(`Could not read trades for '${fundName}'.`);
  }
}

async function handlePause(ctx: Context, fundName: string): Promise<void> {
  try {
    const config = await loadFundConfig(fundName);
    if (config.fund.status === "paused") {
      await ctx.reply(`Fund '${fundName}' is already paused.`);
      return;
    }

    // We update the config by importing saveFundConfig
    const { saveFundConfig } = await import("./fund.js");
    config.fund.status = "paused";
    await saveFundConfig(config);
    await ctx.reply(`⏸ Fund '${fundName}' paused. Sessions will not run until resumed.`);
  } catch {
    await ctx.reply(`Could not pause fund '${fundName}'.`);
  }
}

async function handleResume(ctx: Context, fundName: string): Promise<void> {
  try {
    const config = await loadFundConfig(fundName);
    if (config.fund.status === "active") {
      await ctx.reply(`Fund '${fundName}' is already active.`);
      return;
    }

    const { saveFundConfig } = await import("./fund.js");
    config.fund.status = "active";
    await saveFundConfig(config);
    await ctx.reply(`▶️ Fund '${fundName}' resumed.`);
  } catch {
    await ctx.reply(`Could not resume fund '${fundName}'.`);
  }
}

async function handleNext(ctx: Context): Promise<void> {
  const names = await listFundNames();
  if (names.length === 0) {
    await ctx.reply("No funds configured.");
    return;
  }

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const currentDay = days[now.getDay()];

  interface UpcomingSession {
    fund: string;
    session: string;
    time: string;
    minutesUntil: number;
  }

  const upcoming: UpcomingSession[] = [];

  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      if (config.fund.status !== "active") continue;
      if (!config.schedule.trading_days.includes(currentDay as never)) continue;

      for (const [sessionType, session] of Object.entries(config.schedule.sessions)) {
        if (!session.enabled) continue;
        const [h, m] = session.time.split(":").map(Number);
        const sessionMinutes = h * 60 + m;
        const minutesUntil = sessionMinutes - currentMinutes;
        if (minutesUntil < 0) continue; // Already passed today

        upcoming.push({
          fund: name,
          session: sessionType,
          time: session.time,
          minutesUntil,
        });
      }
    } catch {
      // Skip funds with errors
    }
  }

  if (upcoming.length === 0) {
    await ctx.reply("No upcoming sessions for today.");
    return;
  }

  upcoming.sort((a, b) => a.minutesUntil - b.minutesUntil);

  let response = `🕐 <b>Upcoming Sessions</b>\n──────────────────────────\n`;
  for (const s of upcoming) {
    const hours = Math.floor(s.minutesUntil / 60);
    const mins = s.minutesUntil % 60;
    const inStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    response += `${s.fund} | ${s.session} | ${s.time} | in ${inStr}\n`;
  }

  await ctx.reply(response, { parse_mode: "HTML" });
}

// ── Auto-fund detection ──────────────────────────────────────

async function detectFund(text: string): Promise<string | null> {
  const names = await listFundNames();
  const lowerText = text.toLowerCase();

  // Check if a fund name is mentioned directly
  for (const name of names) {
    if (lowerText.includes(name.toLowerCase())) return name;
  }

  // Check if a ticker in a fund's universe is mentioned
  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      for (const entry of config.universe.allowed) {
        if (entry.tickers) {
          for (const ticker of entry.tickers) {
            // Match ticker as whole word (case-insensitive)
            const regex = new RegExp(`\\b${ticker}\\b`, "i");
            if (regex.test(text)) return name;
          }
        }
      }
    } catch {
      // Skip
    }
  }

  return null;
}

// ── Free question handler (wake Claude) ──────────────────────

async function handleFreeQuestion(ctx: Context): Promise<void> {
  const text = ctx.message?.text;
  if (!text) return;

  const fundName = await detectFund(text);

  if (!fundName) {
    // Could not detect fund — ask user
    const names = await listFundNames();
    if (names.length === 0) {
      await ctx.reply("No funds configured. Create one with `fundx fund create`.");
      return;
    }
    if (names.length === 1) {
      // Only one fund, use it
      await wakeClaudeForQuestion(ctx, names[0], text);
      return;
    }

    let response = "Which fund does this relate to?\n\n";
    for (const name of names) {
      response += `  /ask_${name} ${text}\n`;
    }
    response += `\nOr reply with the fund name.`;
    await ctx.reply(response);
    return;
  }

  await wakeClaudeForQuestion(ctx, fundName, text);
}

async function wakeClaudeForQuestion(
  ctx: Context,
  fundName: string,
  question: string,
): Promise<void> {
  await ctx.reply(`⏳ Waking up Claude for fund '${fundName}'...`);

  try {
    const config = await loadFundConfig(fundName);
    const global = await loadGlobalConfig();
    const { fundPaths } = await import("./paths.js");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);

    const paths = fundPaths(fundName);
    const claudePath = global.claude_path || "claude";
    const model = config.claude.model || global.default_model || "sonnet";

    const prompt = [
      `The user asked a question via Telegram about fund '${fundName}'.`,
      ``,
      `Question: "${question}"`,
      ``,
      `Read your state files and analysis archive to answer this question.`,
      `Be concise — your response will be sent via Telegram.`,
      `Keep it under 4000 characters.`,
    ].join("\n");

    // Ensure MCP settings are up to date
    const { writeMcpSettings } = await import("./session.js");
    await writeMcpSettings(fundName);

    const result = await execFileAsync(
      claudePath,
      [
        "--print",
        "--project-dir", paths.root,
        "--model", model,
        "--max-turns", "10",
        prompt,
      ],
      { timeout: 5 * 60 * 1000, env: { ...process.env, ANTHROPIC_MODEL: model } },
    );

    const answer = result.stdout.trim();
    if (answer.length > 4000) {
      // Telegram message limit is ~4096 chars
      await ctx.reply(answer.slice(0, 3990) + "\n\n[truncated]");
    } else {
      await ctx.reply(answer || "Claude did not produce a response.");
    }
  } catch (err) {
    await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Notification sender (used by daemon/session code) ────────

const TELEGRAM_API = "https://api.telegram.org";

export async function sendTelegramNotification(
  message: string,
  parseMode: "HTML" | "MarkdownV2" | "Markdown" = "HTML",
): Promise<void> {
  if (!globalConfig) globalConfig = await loadGlobalConfig();
  if (!globalConfig.telegram.bot_token || !globalConfig.telegram.chat_id) return;

  const url = `${TELEGRAM_API}/bot${globalConfig.telegram.bot_token}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: globalConfig.telegram.chat_id,
      text: message,
      parse_mode: parseMode,
    }),
  });
}

// ── Bot setup and start ──────────────────────────────────────

export async function startGateway(): Promise<Bot | null> {
  globalConfig = await loadGlobalConfig();

  if (!globalConfig.telegram.bot_token) {
    console.log(chalk.dim("  Telegram not configured. Skipping gateway."));
    return null;
  }

  if (!globalConfig.telegram.chat_id) {
    console.log(chalk.yellow("  Telegram chat_id not set. Skipping gateway."));
    return null;
  }

  const authorizedChatId = globalConfig.telegram.chat_id;
  bot = new Bot(globalConfig.telegram.bot_token);

  // ── Authorization middleware ──────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? "");
    if (chatId !== authorizedChatId) {
      await ctx.reply("Unauthorized. This bot only responds to its configured owner.");
      return;
    }
    await next();
  });

  // ── Quick commands ────────────────────────────────────────
  bot.command("status", async (ctx) => {
    const args = ctx.match?.trim();
    await handleStatus(ctx, args || undefined);
  });

  bot.command("portfolio", async (ctx) => {
    const fundName = ctx.match?.trim();
    if (!fundName) {
      await ctx.reply("Usage: /portfolio <fund>");
      return;
    }
    await handlePortfolio(ctx, fundName);
  });

  bot.command("trades", async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    if (parts.length === 0 || !parts[0]) {
      await ctx.reply("Usage: /trades <fund> [today|week]");
      return;
    }
    await handleTrades(ctx, parts[0], parts[1]);
  });

  bot.command("pause", async (ctx) => {
    const fundName = ctx.match?.trim();
    if (!fundName) {
      await ctx.reply("Usage: /pause <fund>");
      return;
    }
    await handlePause(ctx, fundName);
  });

  bot.command("resume", async (ctx) => {
    const fundName = ctx.match?.trim();
    if (!fundName) {
      await ctx.reply("Usage: /resume <fund>");
      return;
    }
    await handleResume(ctx, fundName);
  });

  bot.command("next", async (ctx) => {
    await handleNext(ctx);
  });

  // ── Dynamic fund shortcut commands (e.g. /runway) ────────
  // Register a handler that matches any command and checks if it's a fund name
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      const command = text.slice(1).split(/\s+/)[0].toLowerCase();
      // Skip already-handled commands
      const builtins = ["status", "portfolio", "trades", "pause", "resume", "next", "start", "help"];
      if (builtins.includes(command)) return next();

      // Check if it's a fund name
      const names = await listFundNames();
      const matchedFund = names.find((n) => n.toLowerCase() === command);
      if (matchedFund) {
        // Show fund-specific status
        const config = await loadFundConfig(matchedFund);
        const tracker = await readTracker(matchedFund).catch(() => null);

        if (config.objective.type === "runway" && tracker) {
          const portfolio = await readPortfolio(matchedFund).catch(() => null);
          const monthlyBurn = "monthly_burn" in config.objective ? config.objective.monthly_burn : 0;
          const monthsRemaining = portfolio
            ? portfolio.total_value / monthlyBurn
            : 0;
          await ctx.reply(
            `⏱ <b>${config.fund.display_name}</b>\nRunway: ${monthsRemaining.toFixed(1)} months remaining`,
            { parse_mode: "HTML" },
          );
        } else {
          await handleFundStatus(ctx, matchedFund);
        }
        return;
      }

      // Check if it's /ask_<fundname>
      if (command.startsWith("ask_")) {
        const fundName = command.slice(4);
        const question = text.slice(text.indexOf(" ") + 1);
        if (names.includes(fundName) && question !== text) {
          await wakeClaudeForQuestion(ctx, fundName, question);
          return;
        }
      }
    }

    // Not a command — treat as free question
    await handleFreeQuestion(ctx);
  });

  // ── Start bot ─────────────────────────────────────────────
  bot.catch((err) => {
    console.error(chalk.red(`  Telegram bot error: ${err.message}`));
  });

  // Use long polling (non-blocking)
  bot.start({
    onStart: () => {
      console.log(chalk.green("  ✓ Telegram gateway started"));
    },
  });

  return bot;
}

export async function stopGateway(): Promise<void> {
  if (bot) {
    await bot.stop();
    bot = null;
    console.log(chalk.dim("  Telegram gateway stopped."));
  }
}

// ── CLI Command ─────────────────────────────────────────────

export const gatewayCommand = new Command("gateway").description(
  "Manage Telegram gateway",
);

gatewayCommand
  .command("start")
  .description("Start the Telegram gateway bot (standalone)")
  .action(async () => {
    console.log(chalk.bold("\n  FundX Telegram Gateway\n"));
    const result = await startGateway();
    if (!result) {
      console.log(
        chalk.dim(
          "  Configure Telegram credentials with 'fundx init' or update ~/.fundx/config.yaml",
        ),
      );
    }
    // Keep process alive
    process.on("SIGINT", async () => {
      await stopGateway();
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      await stopGateway();
      process.exit(0);
    });
  });

gatewayCommand
  .command("test")
  .description("Send a test message to verify Telegram configuration")
  .action(async () => {
    try {
      await sendTelegramNotification(
        "🤖 <b>FundX Gateway</b>\n──────────────────────────\nTest message successful! Gateway is configured correctly.",
      );
      console.log(chalk.green("  ✓ Test message sent. Check your Telegram."));
    } catch (err) {
      console.log(
        chalk.red(`  ✗ Failed to send test message: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
  });
