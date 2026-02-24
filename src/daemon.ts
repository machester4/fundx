import { writeFile, readFile, appendFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import cron from "node-cron";
import { Command } from "commander";
import chalk from "chalk";
import { DAEMON_PID, DAEMON_LOG } from "./paths.js";
import { listFundNames, loadFundConfig } from "./fund.js";
import { runFundSession } from "./session.js";
import { startGateway, stopGateway } from "./gateway.js";
import { checkSpecialSessions } from "./special-sessions.js";
import { generateDailyReport, generateWeeklyReport, generateMonthlyReport } from "./reports.js";

/** Append a timestamped line to the daemon log file */
async function log(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);
  await appendFile(DAEMON_LOG, line, "utf-8").catch(() => {});
}

/** Check if daemon is already running */
async function isDaemonRunning(): Promise<boolean> {
  if (!existsSync(DAEMON_PID)) return false;
  try {
    const pid = parseInt(await readFile(DAEMON_PID, "utf-8"), 10);
    process.kill(pid, 0); // signal 0 = check if process exists
    return true;
  } catch {
    await unlink(DAEMON_PID).catch(() => {});
    return false;
  }
}

/** Start the scheduler daemon */
async function startDaemon(): Promise<void> {
  if (await isDaemonRunning()) {
    console.log(chalk.yellow("  Daemon is already running."));
    return;
  }

  await writeFile(DAEMON_PID, String(process.pid), "utf-8");
  await log(`Daemon started (PID ${process.pid})`);

  // Start Telegram gateway alongside scheduler
  await startGateway();

  // Check every minute for pending sessions
  cron.schedule("* * * * *", async () => {
    const names = await listFundNames();
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
    const currentDay = days[now.getDay()];

    for (const name of names) {
      try {
        const config = await loadFundConfig(name);
        if (config.fund.status !== "active") continue;
        if (!config.schedule.trading_days.includes(currentDay as never))
          continue;

        // Regular sessions
        for (const [sessionType, session] of Object.entries(
          config.schedule.sessions,
        )) {
          if (!session.enabled) continue;
          if (session.time !== currentTime) continue;

          await log(`Running ${sessionType} for '${name}'...`);
          runFundSession(name, sessionType).catch(async (err) => {
            await log(`Session error (${name}/${sessionType}): ${err}`);
          });
        }

        // Special sessions (event-triggered)
        const specialMatches = checkSpecialSessions(config);
        for (const special of specialMatches) {
          if (special.time !== currentTime) continue;

          const specialType = `special_${special.trigger.replace(/\s+/g, "_").toLowerCase()}`;
          await log(`Running special session for '${name}': ${special.trigger}...`);
          runFundSession(name, specialType, { focus: special.focus }).catch(async (err) => {
            await log(`Special session error (${name}/${specialType}): ${err}`);
          });
        }

        // Auto-reports: daily at 18:30, weekly on Fri, monthly on 1st
        if (currentTime === "18:30") {
          generateDailyReport(name).catch(async (err) => {
            await log(`Daily report error (${name}): ${err}`);
          });
        }
        if (currentDay === "FRI" && currentTime === "19:00") {
          generateWeeklyReport(name).catch(async (err) => {
            await log(`Weekly report error (${name}): ${err}`);
          });
        }
        if (now.getDate() === 1 && currentTime === "19:00") {
          generateMonthlyReport(name).catch(async (err) => {
            await log(`Monthly report error (${name}): ${err}`);
          });
        }
      } catch (err) {
        await log(`Error checking fund '${name}': ${err}`);
      }
    }
  });

  // Keep process alive
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

async function cleanup() {
  await stopGateway();
  await unlink(DAEMON_PID).catch(() => {});
  await log("Daemon stopped.");
  process.exit(0);
}

/** Stop the daemon */
async function stopDaemon(): Promise<void> {
  if (!existsSync(DAEMON_PID)) {
    console.log(chalk.dim("  Daemon is not running."));
    return;
  }
  try {
    const pid = parseInt(await readFile(DAEMON_PID, "utf-8"), 10);
    process.kill(pid, "SIGTERM");
    console.log(chalk.green(`  ✓ Daemon stopped (PID ${pid})`));
  } catch {
    await unlink(DAEMON_PID).catch(() => {});
    console.log(chalk.dim("  Daemon was not running. Cleaned up PID file."));
  }
}

// ── CLI Commands ───────────────────────────────────────────────

export const startCommand = new Command("start")
  .description("Start the daemon scheduler + Telegram gateway")
  .action(startDaemon);

export const stopCommand = new Command("stop")
  .description("Stop the daemon scheduler + Telegram gateway")
  .action(stopDaemon);
