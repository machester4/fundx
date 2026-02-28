import { writeFile, readFile, appendFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import cron from "node-cron";
import { DAEMON_PID, DAEMON_LOG } from "../paths.js";
import { listFundNames, loadFundConfig } from "./fund.service.js";
import { runFundSession } from "./session.service.js";
import { startGateway, stopGateway } from "./gateway.service.js";
import { checkSpecialSessions } from "./special-sessions.service.js";
import { generateDailyReport, generateWeeklyReport, generateMonthlyReport } from "./reports.service.js";
import { syncPortfolio } from "../sync.js";
import { checkStopLosses, executeStopLosses } from "../stoploss.js";

// ── Schedule Constants ────────────────────────────────────────

const DAILY_REPORT_TIME = "18:30";
const WEEKLY_REPORT_TIME = "19:00";
const MONTHLY_REPORT_TIME = "19:00";
const PORTFOLIO_SYNC_TIME = "09:30";
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MINUTE = 30;
const MARKET_CLOSE_HOUR = 16;
const STOPLOSS_CHECK_INTERVAL_MINUTES = 5;

/** Append a timestamped line to the daemon log file */
async function log(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);
  await appendFile(DAEMON_LOG, line, "utf-8").catch(() => {});
}

/** Check if daemon is already running */
export async function isDaemonRunning(): Promise<boolean> {
  if (!existsSync(DAEMON_PID)) return false;
  try {
    const pid = parseInt(await readFile(DAEMON_PID, "utf-8"), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    await unlink(DAEMON_PID).catch(() => {});
    return false;
  }
}

/** Spawn a detached background daemon process (auto-start from dashboard) */
export async function forkDaemon(): Promise<void> {
  if (await isDaemonRunning()) return;
  const child = spawn(
    process.execPath,
    [...process.execArgv, process.argv[1]!, "--_daemon-mode"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

/** Start the scheduler daemon */
export async function startDaemon(): Promise<void> {
  if (await isDaemonRunning()) {
    throw new Error("Daemon is already running.");
  }

  await writeFile(DAEMON_PID, String(process.pid), "utf-8");
  await log(`Daemon started (PID ${process.pid})`);

  await startGateway();

  cron.schedule("* * * * *", async () => {
    const names = await listFundNames();
    const now = new Date();

    for (const name of names) {
      try {
        const config = await loadFundConfig(name);
        if (config.fund.status !== "active") continue;

        const tz = config.schedule.timezone || "UTC";
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "2-digit",
          minute: "2-digit",
          weekday: "short",
          hour12: false,
        }).formatToParts(now);
        const currentTime = `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
        const days: Record<string, string> = { Sun: "SUN", Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT" };
        const currentDay = days[parts.find((p) => p.type === "weekday")!.value] ?? "SUN";

        if (!config.schedule.trading_days.includes(currentDay as never))
          continue;

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

        const specialMatches = checkSpecialSessions(config);
        for (const special of specialMatches) {
          if (special.time !== currentTime) continue;

          const specialType = `special_${special.trigger.replace(/\s+/g, "_").toLowerCase()}`;
          await log(`Running special session for '${name}': ${special.trigger}...`);
          runFundSession(name, specialType, { focus: special.focus }).catch(async (err) => {
            await log(`Special session error (${name}/${specialType}): ${err}`);
          });
        }

        if (currentTime === DAILY_REPORT_TIME) {
          generateDailyReport(name).catch(async (err) => {
            await log(`Daily report error (${name}): ${err}`);
          });
        }
        if (currentDay === "FRI" && currentTime === WEEKLY_REPORT_TIME) {
          generateWeeklyReport(name).catch(async (err) => {
            await log(`Weekly report error (${name}): ${err}`);
          });
        }
        const dayOfMonth = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(now), 10);
        if (dayOfMonth === 1 && currentTime === MONTHLY_REPORT_TIME) {
          generateMonthlyReport(name).catch(async (err) => {
            await log(`Monthly report error (${name}): ${err}`);
          });
        }

        if (currentTime === PORTFOLIO_SYNC_TIME) {
          syncPortfolio(name).catch(async (err) => {
            await log(`Portfolio sync error (${name}): ${err}`);
          });
        }

        const hour = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
        const minute = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
        const duringMarket =
          (hour > MARKET_OPEN_HOUR || (hour === MARKET_OPEN_HOUR && minute >= MARKET_OPEN_MINUTE)) &&
          hour < MARKET_CLOSE_HOUR;
        if (duringMarket && minute % STOPLOSS_CHECK_INTERVAL_MINUTES === 0) {
          void (async () => {
            try {
              const triggered = await checkStopLosses(name);
              if (triggered.length > 0) {
                await log(
                  `Stop-loss triggered for '${name}': ${triggered.map((t) => t.symbol).join(", ")}`,
                );
                await executeStopLosses(name, triggered);
              }
            } catch (err) {
              await log(`Stop-loss check error (${name}): ${err}`);
            }
          })();
        }
      } catch (err) {
        await log(`Error checking fund '${name}': ${err}`);
      }
    }
  });

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
export async function stopDaemon(): Promise<{ stopped: boolean; pid?: number }> {
  if (!existsSync(DAEMON_PID)) {
    return { stopped: false };
  }
  try {
    const pid = parseInt(await readFile(DAEMON_PID, "utf-8"), 10);
    process.kill(pid, "SIGTERM");
    return { stopped: true, pid };
  } catch {
    await unlink(DAEMON_PID).catch(() => {});
    return { stopped: false };
  }
}
