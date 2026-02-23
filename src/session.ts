import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { Command } from "commander";
import ora from "ora";
import { loadFundConfig } from "./fund.js";
import { loadGlobalConfig } from "./config.js";
import { writeSessionLog } from "./state.js";
import { fundPaths, MCP_SERVERS } from "./paths.js";
import type { SessionLog } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Write .claude/settings.json for a fund so Claude Code can use MCP servers.
 * Called before each session to ensure config is up-to-date.
 */
async function writeMcpSettings(fundName: string): Promise<void> {
  const paths = fundPaths(fundName);
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(fundName);

  const env: Record<string, string> = {};
  if (globalConfig.broker.api_key) env.ALPACA_API_KEY = globalConfig.broker.api_key;
  if (globalConfig.broker.secret_key) env.ALPACA_SECRET_KEY = globalConfig.broker.secret_key;
  env.ALPACA_MODE = fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";

  const settings = {
    mcpServers: {
      "broker-alpaca": {
        command: "node",
        args: [MCP_SERVERS.brokerAlpaca],
        env,
      },
      "market-data": {
        command: "node",
        args: [MCP_SERVERS.marketData],
        env,
      },
    },
  };

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
    `5. Update objective_tracker.json`,
    `6. Log all trades in state/trade_journal.sqlite`,
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

// ── CLI Commands ───────────────────────────────────────────────

export const sessionCommand = new Command("session").description(
  "Manage Claude Code sessions",
);

sessionCommand
  .command("run")
  .description("Manually trigger a session")
  .argument("<fund>", "Fund name")
  .argument("<type>", "Session type (pre_market, mid_session, post_market)")
  .action(async (fund: string, type: string) => {
    const spinner = ora(`Running ${type} session for '${fund}'...`).start();
    try {
      await runFundSession(fund, type);
      spinner.succeed(`Session complete for '${fund}'.`);
    } catch (err) {
      spinner.fail(`Session failed: ${err}`);
    }
  });
