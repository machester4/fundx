import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { DAEMON_LOG } from "./paths.js";
import { listFundNames, loadFundConfig } from "./fund.js";
import { readSessionLog } from "./state.js";

export const logsCommand = new Command("logs")
  .description("View daemon and session logs")
  .option("-f, --fund <name>", "Show logs for a specific fund")
  .option("-n, --lines <count>", "Number of daemon log lines to show", "20")
  .option("--daemon", "Show only daemon logs")
  .action(async (opts: { fund?: string; lines: string; daemon?: boolean }) => {
    if (opts.daemon || !opts.fund) {
      await showDaemonLogs(parseInt(opts.lines, 10));
    }

    if (!opts.daemon) {
      if (opts.fund) {
        await showFundSessionLog(opts.fund);
      } else {
        await showAllSessionLogs();
      }
    }
  });

async function showDaemonLogs(lines: number): Promise<void> {
  console.log(chalk.bold("\n  Daemon Logs\n"));

  if (!existsSync(DAEMON_LOG)) {
    console.log(chalk.dim("  No daemon log found. Start the daemon with 'fundx start'.\n"));
    return;
  }

  try {
    const content = await readFile(DAEMON_LOG, "utf-8");
    const allLines = content.trim().split("\n");
    const tail = allLines.slice(-lines);

    if (tail.length === 0) {
      console.log(chalk.dim("  Daemon log is empty.\n"));
      return;
    }

    for (const line of tail) {
      console.log(`  ${line}`);
    }
    console.log();
  } catch {
    console.log(chalk.dim("  Could not read daemon log.\n"));
  }
}

async function showFundSessionLog(fundName: string): Promise<void> {
  console.log(chalk.bold(`\n  Session Log: ${fundName}\n`));

  try {
    const config = await loadFundConfig(fundName);
    const log = await readSessionLog(fundName);

    if (!log) {
      console.log(chalk.dim("  No session has been run yet.\n"));
      return;
    }

    console.log(`  Fund:     ${config.fund.display_name}`);
    console.log(`  Session:  ${log.session_type}`);
    console.log(`  Started:  ${log.started_at}`);
    if (log.ended_at) {
      console.log(`  Ended:    ${log.ended_at}`);
    }
    console.log(`  Trades:   ${log.trades_executed}`);
    if (log.summary) {
      console.log(`  Summary:  ${log.summary}`);
    }
    console.log();
  } catch {
    console.log(chalk.red(`  Could not read logs for fund '${fundName}'.\n`));
  }
}

async function showAllSessionLogs(): Promise<void> {
  const names = await listFundNames();

  if (names.length === 0) {
    return;
  }

  console.log(chalk.bold("\n  Recent Sessions\n"));

  let found = false;
  for (const name of names) {
    try {
      const log = await readSessionLog(name);
      if (!log) continue;

      found = true;
      const config = await loadFundConfig(name);
      const elapsed = log.ended_at
        ? formatDuration(new Date(log.started_at), new Date(log.ended_at))
        : "in progress";

      console.log(
        `  ${chalk.bold(config.fund.display_name)} (${name})`,
      );
      console.log(
        `    ${log.session_type} — ${log.started_at} (${elapsed}) — ${log.trades_executed} trades`,
      );
      if (log.summary) {
        console.log(chalk.dim(`    ${log.summary.slice(0, 120)}`));
      }
      console.log();
    } catch {
      // Skip funds with read errors
    }
  }

  if (!found) {
    console.log(chalk.dim("  No sessions have been run yet.\n"));
  }
}

function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
