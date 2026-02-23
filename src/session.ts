import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadFundConfig } from "./fund.js";
import { loadGlobalConfig } from "./config.js";
import { writeSessionLog } from "./state.js";
import { fundPaths } from "./paths.js";
import type { SessionLog } from "./types.js";

const execFileAsync = promisify(execFile);

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
    `3. Send Telegram notifications for trades or important insights`,
    `4. Update objective_tracker.json`,
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
