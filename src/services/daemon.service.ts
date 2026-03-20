import { writeFile, readFile, appendFile, unlink, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import cron from "node-cron";
import {
  DAEMON_PID,
  DAEMON_LOG,
  SUPERVISOR_PID,
  DAEMON_HEARTBEAT,
  DAEMON_LOG_MAX_SIZE,
  DAEMON_LOG_MAX_FILES,
} from "../paths.js";
import { listFundNames, loadFundConfig } from "./fund.service.js";
import { runFundSession } from "./session.service.js";
import { startGateway, stopGateway } from "./gateway.service.js";
import { checkSpecialSessions } from "./special-sessions.service.js";
import { generateDailyReport, generateWeeklyReport, generateMonthlyReport } from "./reports.service.js";
import { syncPortfolio } from "../sync.js";
import { checkStopLosses, executeStopLosses } from "../stoploss.js";
import { loadGlobalConfig } from "../config.js";
import { acquireFundLock, releaseFundLock, withTimeout } from "../lock.js";
import { readSessionHistory } from "../state.js";

// ── Schedule Constants ────────────────────────────────────────

const DAILY_REPORT_TIME = "18:30";
const WEEKLY_REPORT_TIME = "19:00";
const MONTHLY_REPORT_TIME = "19:00";
const PORTFOLIO_SYNC_TIME = "09:30";
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MINUTE = 30;
const MARKET_CLOSE_HOUR = 16;
const STOPLOSS_CHECK_INTERVAL_MINUTES = 5;

const HEARTBEAT_STALE_MS = 3 * 60 * 1000; // 3 minutes
const SESSION_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

let isProcessing = false;

/** Append a timestamped line to the daemon log file */
async function log(message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);
  await appendFile(DAEMON_LOG, line, "utf-8").catch(() => {});
}

// ── PID Helpers ──────────────────────────────────────────────

interface PidInfo {
  pid: number;
  startedAt?: string;
  version?: string;
}

/** Parse PID file content — supports JSON format and legacy plain-text */
function parsePidFile(content: string): PidInfo | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.pid === "number") return parsed as PidInfo;
    } catch {
      return null;
    }
  }
  // Legacy plain-text fallback
  const pid = parseInt(trimmed, 10);
  return isNaN(pid) ? null : { pid };
}

/** Read and return the daemon PID from the JSON PID file (with legacy fallback) */
export async function getDaemonPid(): Promise<number | null> {
  if (!existsSync(DAEMON_PID)) return null;
  try {
    const content = await readFile(DAEMON_PID, "utf-8");
    const info = parsePidFile(content);
    return info?.pid ?? null;
  } catch {
    return null;
  }
}

/** Check if daemon is already running (robust version) */
export async function isDaemonRunning(): Promise<boolean> {
  if (!existsSync(DAEMON_PID)) return false;

  try {
    const content = await readFile(DAEMON_PID, "utf-8");
    const info = parsePidFile(content);
    if (!info) {
      await unlink(DAEMON_PID).catch(() => {});
      return false;
    }

    // Check process exists
    try {
      process.kill(info.pid, 0);
    } catch {
      await unlink(DAEMON_PID).catch(() => {});
      return false;
    }

    // Best-effort: verify process is fundx
    try {
      const output = execFileSync("ps", ["-p", String(info.pid), "-o", "command="], {
        encoding: "utf-8",
        timeout: 2000,
      });
      const cmd = output.trim().toLowerCase();
      if (cmd && !cmd.includes("fundx") && !cmd.includes("node") && !cmd.includes("tsx")) {
        await unlink(DAEMON_PID).catch(() => {});
        return false;
      }
    } catch {
      // ps failed — skip verification, don't treat as not running
    }

    // Check heartbeat freshness
    try {
      const hbStat = await stat(DAEMON_HEARTBEAT);
      const age = Date.now() - hbStat.mtimeMs;
      if (age > HEARTBEAT_STALE_MS) {
        await log(`Daemon heartbeat stale (${Math.round(age / 1000)}s old), treating as hung`);
        await unlink(DAEMON_PID).catch(() => {});
        await unlink(DAEMON_HEARTBEAT).catch(() => {});
        return false;
      }
    } catch {
      // No heartbeat file — don't fail, could be newly started
    }

    return true;
  } catch {
    await unlink(DAEMON_PID).catch(() => {});
    return false;
  }
}

/** Write heartbeat with timestamp and fund count */
export async function updateHeartbeat(fundsChecked: number): Promise<void> {
  const data = { timestamp: new Date().toISOString(), fundsChecked };
  await writeFile(DAEMON_HEARTBEAT, JSON.stringify(data), "utf-8").catch(() => {});
}

// ── Log Rotation ─────────────────────────────────────────────

/** Rotate daemon log file if it exceeds max size */
export async function rotateLogIfNeeded(): Promise<void> {
  try {
    const logStat = await stat(DAEMON_LOG);
    if (logStat.size <= DAEMON_LOG_MAX_SIZE) return;

    // Shift existing rotated logs: .2→.3, .1→.2
    for (let i = DAEMON_LOG_MAX_FILES - 1; i >= 1; i--) {
      const from = `${DAEMON_LOG}.${i}`;
      const to = `${DAEMON_LOG}.${i + 1}`;
      await rename(from, to).catch(() => {});
    }

    // Rename current log to .1
    await rename(DAEMON_LOG, `${DAEMON_LOG}.1`).catch(() => {});

    // Truncate current log (create empty)
    await writeFile(DAEMON_LOG, "", "utf-8");

    await log("Log rotated");
  } catch {
    // stat failed (ENOENT) — nothing to rotate
  }
}

// ── Notifications & Error Tracking ──────────────────────────

const lastAlertByType = new Map<string, number>();
const ALERT_DEDUP_MS = 30 * 60 * 1000; // 30 minutes

/** Send a daemon event notification (deduped, best-effort Telegram) */
export async function notifyDaemonEvent(event: string, details: string): Promise<void> {
  const now = Date.now();
  const lastSent = lastAlertByType.get(event) ?? 0;
  if (now - lastSent < ALERT_DEDUP_MS) return;

  lastAlertByType.set(event, now);
  await log(`[ALERT] ${event}: ${details}`);

  // Best-effort Telegram notification
  try {
    const { sendTelegramNotification } = await import("./gateway.service.js");
    await sendTelegramNotification(`<b>[Daemon]</b> ${event}\n${details}`);
  } catch {
    // Telegram not available — already logged
  }
}

// Error tracking: consecutive failures per fund:errorType
const errorCounts = new Map<string, number>();

/** Track a consecutive error for a fund operation */
export function trackError(fundName: string, errorType: string, error: unknown): void {
  const key = `${fundName}:${errorType}`;
  const count = (errorCounts.get(key) ?? 0) + 1;
  errorCounts.set(key, count);
  log(`Error [${key}] (${count}x): ${error}`).catch(() => {});
  if (count === 3) {
    notifyDaemonEvent(
      `Repeated failure: ${fundName}/${errorType}`,
      `Failed ${count} consecutive times. Last error: ${error}`,
    ).catch(() => {});
  }
}

/** Clear error counter on success */
export function clearError(fundName: string, errorType: string): void {
  const key = `${fundName}:${errorType}`;
  errorCounts.delete(key);
}

async function checkSwsTokenExpiry(): Promise<void> {
  const config = await loadGlobalConfig();
  const expiresAt = config.sws?.token_expires_at;
  if (!expiresAt) return;

  const hoursLeft = (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60);

  if (!config.telegram.bot_token || !config.telegram.chat_id) return;

  const { sendTelegramNotification } = await import("./gateway.service.js");

  if (hoursLeft <= 0) {
    await sendTelegramNotification(
      "⚠️ <b>SWS token expired.</b> Data de Simply Wall St deshabilitada. Ejecuta <code>fundx sws login</code> para renovar.",
    );
  } else if (hoursLeft <= 48) {
    await sendTelegramNotification(
      `⚠️ SWS token expira en ${Math.round(hoursLeft)} horas. Ejecuta <code>fundx sws login</code> para renovar.`,
    );
  }
}

// ── Missed Session Catch-up ──────────────────────────────────

const CATCHUP_TOLERANCE_MS = 60 * 60 * 1000; // 60 minutes

/** Get the timezone offset in ms for a given IANA timezone (relative to UTC) */
function getTimezoneOffsetMs(tz: string): number {
  const now = new Date();
  const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = now.toLocaleString("en-US", { timeZone: tz });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}

/**
 * Check for missed sessions and run catch-up for the most recent one per fund.
 * Called on daemon startup to recover from downtime.
 */
export async function checkMissedSessions(): Promise<void> {
  const names = await listFundNames();
  const now = Date.now();

  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      if (config.fund.status !== "active") continue;

      const history = await readSessionHistory(name);
      const tz = config.schedule.timezone || "UTC";
      const offsetMs = getTimezoneOffsetMs(tz);

      // Find the most recent missed session (only one per fund)
      let bestMissed: { sessionType: string; scheduledAt: number; focus: string } | null = null;

      for (const [sessionType, session] of Object.entries(config.schedule.sessions)) {
        if (!session.enabled) continue;

        const lastRun = history[sessionType];
        const lastRunMs = lastRun ? new Date(lastRun).getTime() : 0;

        // Parse session time (HH:MM) into today's date in the fund's timezone
        const [hourStr, minStr] = session.time.split(":");
        const hour = parseInt(hourStr!, 10);
        const min = parseInt(minStr!, 10);

        // Build today's scheduled time in UTC
        const todayUtc = new Date(now);
        todayUtc.setUTCHours(0, 0, 0, 0);
        const scheduledMs = todayUtc.getTime() + (hour * 60 + min) * 60 * 1000 - offsetMs;

        // Check if today is a trading day
        const scheduledDate = new Date(scheduledMs);
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          weekday: "short",
        }).formatToParts(scheduledDate);
        const days: Record<string, string> = { Sun: "SUN", Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT" };
        const dayStr = days[parts.find((p) => p.type === "weekday")!.value] ?? "SUN";
        if (!config.schedule.trading_days.includes(dayStr as never)) continue;

        // Check if session was missed: scheduled time is in the past, within tolerance, and not already run
        if (
          scheduledMs < now &&
          now - scheduledMs <= CATCHUP_TOLERANCE_MS &&
          lastRunMs < scheduledMs
        ) {
          if (!bestMissed || scheduledMs > bestMissed.scheduledAt) {
            bestMissed = { sessionType, scheduledAt: scheduledMs, focus: session.focus };
          }
        }
      }

      if (!bestMissed) continue;

      // Try to run catch-up
      const locked = await acquireFundLock(name, `catchup_${bestMissed.sessionType}`);
      if (!locked) {
        await log(`Skipping catch-up for '${name}/${bestMissed.sessionType}' (lock held)`);
        continue;
      }

      try {
        const catchupType = `catchup_${bestMissed.sessionType}`;
        await log(`Running catch-up session for '${name}': ${bestMissed.sessionType} (missed by ${Math.round((now - bestMissed.scheduledAt) / 60000)}min)`);

        await notifyDaemonEvent(
          `Missed session: ${name}/${bestMissed.sessionType}`,
          `Catching up — was scheduled ${Math.round((now - bestMissed.scheduledAt) / 60000)} minutes ago`,
        );

        await withTimeout(
          runFundSession(name, catchupType, {
            focus: `[CATCH-UP] ${bestMissed.focus} — This is a retroactive session; the daemon was down when it was scheduled.`,
          }),
          SESSION_TIMEOUT_MS,
        );
      } catch (err) {
        await log(`Catch-up session error (${name}/${bestMissed.sessionType}): ${err}`);
      } finally {
        await releaseFundLock(name);
      }
    } catch (err) {
      await log(`Error checking missed sessions for '${name}': ${err}`);
    }
  }
}

/** Start the scheduler daemon */
export async function startDaemon(): Promise<void> {
  if (await isDaemonRunning()) {
    throw new Error("Daemon is already running.");
  }

  // Write JSON PID file
  const pidInfo = { pid: process.pid, startedAt: new Date().toISOString(), version: "0.1.0" };
  await writeFile(DAEMON_PID, JSON.stringify(pidInfo), "utf-8");
  await updateHeartbeat(0);
  await log(`Daemon started (PID ${process.pid})`);

  // Defensively stop gateway before starting
  await stopGateway().catch(() => {});
  await startGateway();

  await rotateLogIfNeeded();
  await checkMissedSessions();

  cron.schedule("* * * * *", async () => {
    // Backpressure: skip if previous tick is still running
    if (isProcessing) {
      await log("Cron tick skipped (previous tick still processing)");
      return;
    }
    isProcessing = true;

    try {
      const names = await listFundNames();
      const now = new Date();

      await updateHeartbeat(names.length);

      await Promise.allSettled(
        names.map(async (name) => {
          try {
            const config = await loadFundConfig(name);
            if (config.fund.status !== "active") return;

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
              return;

            // ── Scheduled sessions (lock-gated) ──
            for (const [sessionType, session] of Object.entries(
              config.schedule.sessions,
            )) {
              if (!session.enabled) continue;
              if (session.time !== currentTime) continue;

              const locked = await acquireFundLock(name, sessionType);
              if (!locked) {
                await log(`Skipping ${sessionType} for '${name}' (lock held)`);
                await notifyDaemonEvent("Lock conflict", `${name}/${sessionType} — another session is running`);
                continue;
              }
              try {
                await log(`Running ${sessionType} for '${name}'...`);
                await withTimeout(runFundSession(name, sessionType), SESSION_TIMEOUT_MS);
                clearError(name, `session:${sessionType}`);
              } catch (err) {
                trackError(name, `session:${sessionType}`, err);
              } finally {
                await releaseFundLock(name);
              }
            }

            // ── Special sessions (lock-gated) ──
            const specialMatches = checkSpecialSessions(config);
            for (const special of specialMatches) {
              if (special.time !== currentTime) continue;

              const specialType = `special_${special.trigger.replace(/\s+/g, "_").toLowerCase()}`;
              const locked = await acquireFundLock(name, specialType);
              if (!locked) {
                await log(`Skipping special session for '${name}': ${special.trigger} (lock held)`);
                continue;
              }
              try {
                await log(`Running special session for '${name}': ${special.trigger}...`);
                await withTimeout(
                  runFundSession(name, specialType, { focus: special.focus }),
                  SESSION_TIMEOUT_MS,
                );
                clearError(name, `special:${specialType}`);
              } catch (err) {
                trackError(name, `special:${specialType}`, err);
              } finally {
                await releaseFundLock(name);
              }
            }

            // ── Reports (fire-and-forget, no lock) ──
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

            // ── Portfolio sync (lock-gated) ──
            if (currentTime === PORTFOLIO_SYNC_TIME) {
              const locked = await acquireFundLock(name, "portfolio_sync");
              if (locked) {
                try {
                  await syncPortfolio(name);
                  clearError(name, "portfolio_sync");
                } catch (err) {
                  trackError(name, "portfolio_sync", err);
                } finally {
                  await releaseFundLock(name);
                }
              }
            }

            // ── Stop-loss checks (lock-gated) ──
            const hour = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
            const minute = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
            const duringMarket =
              (hour > MARKET_OPEN_HOUR || (hour === MARKET_OPEN_HOUR && minute >= MARKET_OPEN_MINUTE)) &&
              hour < MARKET_CLOSE_HOUR;
            if (duringMarket && minute % STOPLOSS_CHECK_INTERVAL_MINUTES === 0) {
              const locked = await acquireFundLock(name, "stoploss");
              if (locked) {
                try {
                  const triggered = await checkStopLosses(name);
                  if (triggered.length > 0) {
                    await log(
                      `Stop-loss triggered for '${name}': ${triggered.map((t) => t.symbol).join(", ")}`,
                    );
                    await executeStopLosses(name, triggered);
                  }
                  clearError(name, "stoploss");
                } catch (err) {
                  trackError(name, "stoploss", err);
                } finally {
                  await releaseFundLock(name);
                }
              }
            }
          } catch (err) {
            await log(`Error checking fund '${name}': ${err}`);
          }
        }),
      );
    } finally {
      isProcessing = false;
    }
  });

  // SWS token expiry check — daily at 09:00
  cron.schedule("0 9 * * *", () => {
    checkSwsTokenExpiry().catch(async (err) => {
      await log(`SWS token check error: ${err}`);
    });
  });

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

async function cleanup() {
  await stopGateway();
  await unlink(DAEMON_PID).catch(() => {});
  await unlink(DAEMON_HEARTBEAT).catch(() => {});
  await log("Daemon stopped.");
  process.exit(0);
}

/** Stop the supervisor (or daemon). Reads SUPERVISOR_PID first, falls back to DAEMON_PID. */
export async function stopSupervisor(): Promise<{ stopped: boolean; pid?: number }> {
  // Try supervisor PID first, then daemon PID
  for (const pidFile of [SUPERVISOR_PID, DAEMON_PID]) {
    if (!existsSync(pidFile)) continue;
    try {
      const content = await readFile(pidFile, "utf-8");
      const info = parsePidFile(content);
      if (!info) {
        await unlink(pidFile).catch(() => {});
        continue;
      }
      process.kill(info.pid, "SIGTERM");
      return { stopped: true, pid: info.pid };
    } catch {
      await unlink(pidFile).catch(() => {});
    }
  }
  return { stopped: false };
}

/** Stop the daemon (alias for stopSupervisor) */
export const stopDaemon = stopSupervisor;

/** @deprecated Will be replaced by forkSupervisor() in supervisor module */
export async function forkDaemon(): Promise<void> {
  // No-op stub — supervisor replaces this
}
