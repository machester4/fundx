import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadFundConfig } from "./fund.js";
import { loadGlobalConfig } from "./config.js";
import { writeSessionLog } from "./state.js";
import { fundPaths, MCP_SERVERS } from "./paths.js";
import {
  runSubAgents,
  getDefaultSubAgents,
  mergeSubAgentResults,
  saveSubAgentAnalysis,
} from "./subagent.js";
import type { SessionLog } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Write .claude/settings.json for a fund so Claude Code can use MCP servers.
 * Called before each session to ensure config is up-to-date.
 */
export async function writeMcpSettings(fundName: string): Promise<void> {
  const paths = fundPaths(fundName);
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(fundName);

  const brokerEnv: Record<string, string> = {};
  if (globalConfig.broker.api_key) brokerEnv.ALPACA_API_KEY = globalConfig.broker.api_key;
  if (globalConfig.broker.secret_key) brokerEnv.ALPACA_SECRET_KEY = globalConfig.broker.secret_key;
  brokerEnv.ALPACA_MODE = fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";

  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    "broker-alpaca": {
      command: "node",
      args: [MCP_SERVERS.brokerAlpaca],
      env: brokerEnv,
    },
    "market-data": {
      command: "node",
      args: [MCP_SERVERS.marketData],
      env: brokerEnv,
    },
  };

  // Add telegram-notify MCP server if Telegram is configured
  if (
    globalConfig.telegram.bot_token &&
    globalConfig.telegram.chat_id &&
    fundConfig.notifications.telegram.enabled
  ) {
    const telegramEnv: Record<string, string> = {
      TELEGRAM_BOT_TOKEN: globalConfig.telegram.bot_token,
      TELEGRAM_CHAT_ID: globalConfig.telegram.chat_id,
    };
    if (fundConfig.notifications.quiet_hours.enabled) {
      telegramEnv.QUIET_HOURS_START = fundConfig.notifications.quiet_hours.start;
      telegramEnv.QUIET_HOURS_END = fundConfig.notifications.quiet_hours.end;
    }
    mcpServers["telegram-notify"] = {
      command: "node",
      args: [MCP_SERVERS.telegramNotify],
      env: telegramEnv,
    };
  }

  const settings = { mcpServers };

  await mkdir(paths.claudeDir, { recursive: true });
  await writeFile(paths.claudeSettings, JSON.stringify(settings, null, 2), "utf-8");
}

/** Launch a Claude Code session for a fund */
export async function runFundSession(
  fundName: string,
  sessionType: string,
): Promise<void> {
  const config = await loadFundConfig(fundName);
  const global = await loadGlobalConfig();
  const paths = fundPaths(fundName);

  const sessionConfig = config.schedule.sessions[sessionType];
  if (!sessionConfig) {
    throw new Error(
      `Session type '${sessionType}' not found in fund '${fundName}'`,
    );
  }

  // Ensure MCP servers are configured for this fund
  await writeMcpSettings(fundName);

  const today = new Date().toISOString().split("T")[0];

  const prompt = [
    `You are running a ${sessionType} session for fund '${fundName}'.`,
    ``,
    `Focus: ${sessionConfig.focus}`,
    ``,
    `Start by reading your state files, then proceed with analysis`,
    `and actions as appropriate. Remember to:`,
    `1. Update state files after any changes`,
    `2. Write analysis to analysis/${today}_${sessionType}.md`,
    `3. Use MCP broker-alpaca tools for trading and position management`,
    `4. Use MCP market-data tools for price data and market analysis`,
    `5. Use MCP telegram-notify tools to send trade alerts, digests, and notifications (if available)`,
    `6. Update objective_tracker.json`,
    `7. Log all trades in state/trade_journal.sqlite`,
  ].join("\n");

  const claudePath = global.claude_path || "claude";
  const model = config.claude.model || global.default_model || "sonnet";
  const timeout = (sessionConfig.max_duration_minutes ?? 15) * 60 * 1000;

  const startedAt = new Date().toISOString();

  const result = await execFileAsync(
    claudePath,
    [
      "--print",
      "--project-dir", paths.root,
      "--model", model,
      "--max-turns", "50",
      prompt,
    ],
    { timeout },
  );

  const log: SessionLog = {
    fund: fundName,
    session_type: sessionType,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    trades_executed: 0,
    summary: result.stdout.slice(0, 500),
  };

  await writeSessionLog(fundName, log);
}

/**
 * Launch a fund session with parallel sub-agents for analysis.
 *
 * Sub-agents (macro, technical, sentiment, risk) run in parallel first,
 * then a main session incorporates their combined analysis.
 */
export async function runFundSessionWithSubAgents(
  fundName: string,
  sessionType: string,
): Promise<void> {
  const config = await loadFundConfig(fundName);
  const global = await loadGlobalConfig();
  const paths = fundPaths(fundName);

  const sessionConfig = config.schedule.sessions[sessionType];
  if (!sessionConfig) {
    throw new Error(
      `Session type '${sessionType}' not found in fund '${fundName}'`,
    );
  }

  await writeMcpSettings(fundName);

  const today = new Date().toISOString().split("T")[0];
  const startedAt = new Date().toISOString();

  // Phase 1: Run sub-agents in parallel
  const agents = getDefaultSubAgents(fundName);
  const results = await runSubAgents(fundName, agents, {
    timeoutMinutes: 8,
    model: config.claude.model || global.default_model || "sonnet",
  });

  // Save sub-agent analysis
  const analysisPath = await saveSubAgentAnalysis(fundName, results, sessionType);
  const combinedAnalysis = mergeSubAgentResults(results);

  // Phase 2: Run main decision-making session with sub-agent context
  const prompt = [
    `You are running a ${sessionType} session for fund '${fundName}'.`,
    ``,
    `Focus: ${sessionConfig.focus}`,
    ``,
    `## Sub-Agent Analysis`,
    `Your analysis team has completed their research. Here is their combined output:`,
    ``,
    combinedAnalysis.slice(0, 8000),
    ``,
    `## Your Task`,
    `Review the sub-agent analysis above and make trading decisions.`,
    `Start by reading your state files, then:`,
    `1. Synthesize the macro, technical, sentiment, and risk analysis`,
    `2. Decide on trades that align with all signals and fund constraints`,
    `3. Execute trades via MCP broker-alpaca tools`,
    `4. Update state files after any changes`,
    `5. Write your synthesis to analysis/${today}_${sessionType}.md`,
    `6. Use MCP telegram-notify tools to send alerts (if available)`,
    `7. Update objective_tracker.json`,
    `8. Log all trades in state/trade_journal.sqlite`,
  ].join("\n");

  const claudePath = global.claude_path || "claude";
  const model = config.claude.model || global.default_model || "sonnet";
  const timeout = (sessionConfig.max_duration_minutes ?? 15) * 60 * 1000;

  const result = await execFileAsync(
    claudePath,
    [
      "--print",
      "--project-dir", paths.root,
      "--model", model,
      "--max-turns", "50",
      prompt,
    ],
    { timeout },
  );

  const successCount = results.filter((r) => r.status === "success").length;

  const log: SessionLog = {
    fund: fundName,
    session_type: `${sessionType}_parallel`,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    trades_executed: 0,
    analysis_file: analysisPath,
    summary: `Sub-agents: ${successCount}/${results.length} OK. ${result.stdout.slice(0, 300)}`,
  };

  await writeSessionLog(fundName, log);
}

// ── CLI Commands ───────────────────────────────────────────────

export const sessionCommand = new Command("session").description(
  "Manage Claude Code sessions",
);

sessionCommand
  .command("run")
  .description("Manually trigger a session")
  .argument("<fund>", "Fund name")
  .argument("<type>", "Session type (pre_market, mid_session, post_market)")
  .option("-p, --parallel", "Use sub-agent parallel analysis")
  .action(async (fund: string, type: string, opts: { parallel?: boolean }) => {
    const useParallel = opts.parallel ?? false;
    const mode = useParallel ? "parallel" : "standard";
    const spinner = ora(
      `Running ${type} session for '${fund}' (${mode})...`,
    ).start();
    try {
      if (useParallel) {
        spinner.text = `Running sub-agent analysis for '${fund}'...`;
        await runFundSessionWithSubAgents(fund, type);
        spinner.succeed(
          `Parallel session complete for '${fund}'.`,
        );
      } else {
        await runFundSession(fund, type);
        spinner.succeed(`Session complete for '${fund}'.`);
      }
    } catch (err) {
      spinner.fail(`Session failed: ${err}`);
    }
  });

sessionCommand
  .command("agents")
  .description("Run only the sub-agent analysis (no trading)")
  .argument("<fund>", "Fund name")
  .option("-m, --model <model>", "Claude model (sonnet or opus)")
  .action(async (fund: string, opts: { model?: string }) => {
    const spinner = ora(
      `Running sub-agent analysis for '${fund}'...`,
    ).start();
    try {
      const agents = getDefaultSubAgents(fund);
      spinner.text = `Launching ${agents.length} sub-agents in parallel...`;

      const results = await runSubAgents(fund, agents, {
        model: opts.model,
      });

      const analysisPath = await saveSubAgentAnalysis(fund, results, "manual");

      const successCount = results.filter((r) => r.status === "success").length;
      const errorCount = results.filter((r) => r.status === "error").length;
      const timeoutCount = results.filter((r) => r.status === "timeout").length;

      spinner.succeed(`Sub-agent analysis complete.`);
      console.log();

      for (const r of results) {
        const icon =
          r.status === "success"
            ? chalk.green("OK")
            : r.status === "timeout"
              ? chalk.yellow("TIMEOUT")
              : chalk.red("ERR");
        const started = new Date(r.started_at).getTime();
        const ended = new Date(r.ended_at).getTime();
        const dur = ((ended - started) / 1000).toFixed(0);
        console.log(`  ${icon}  ${r.name} (${dur}s)`);
      }

      console.log();
      console.log(
        chalk.dim(
          `  ${successCount} succeeded, ${errorCount} errors, ${timeoutCount} timeouts`,
        ),
      );
      console.log(chalk.dim(`  Analysis saved: ${analysisPath}`));
    } catch (err) {
      spinner.fail(`Sub-agent analysis failed: ${err}`);
    }
  });
