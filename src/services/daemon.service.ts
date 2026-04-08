import { writeFile, readFile, appendFile, unlink, stat, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
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
  fundPaths,
} from "../paths.js";
import { listFundNames, loadFundConfig } from "./fund.service.js";
import { runFundSession } from "./session.service.js";
import { startGateway, stopGateway } from "./gateway.service.js";
import { checkSpecialSessions } from "./special-sessions.service.js";
import { fetchAllFeeds, checkBreakingNews, cleanOldArticles } from "./news.service.js";
import { generateDailyReport, generateWeeklyReport, generateMonthlyReport } from "./reports.service.js";
import { checkStopLosses, executeStopLosses } from "../stoploss.js";
import { loadGlobalConfig } from "../config.js";
import { acquireFundLock, releaseFundLock, withTimeout } from "../lock.js";
import { readSessionHistory, readPendingSessions, writePendingSessions, readSessionCounts, writeSessionCounts, readPortfolio, readTracker, readDailySnapshot, writeDailySnapshot, readNotifiedMilestones, writeNotifiedMilestones } from "../state.js";
import { isInQuietHoursEnv } from "../mcp/broker-local-notify.js";

// ── Schedule Constants ────────────────────────────────────────

const DAILY_REPORT_TIME = "18:30";
const WEEKLY_REPORT_TIME = "19:00";
const MONTHLY_REPORT_TIME = "19:00";
const MARKET_OPEN_HOUR = 9;
const MARKET_OPEN_MINUTE = 30;
const MARKET_CLOSE_HOUR = 16;
const STOPLOSS_CHECK_INTERVAL_MINUTES = 5;

const HEARTBEAT_STALE_MS = 3 * 60 * 1000; // 3 minutes
const SESSION_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

let isProcessing = false;

// ── Notification Helpers ─────────────────────────────────────

export async function sendDailyDigest(fundName: string): Promise<void> {
  const config = await loadFundConfig(fundName);
  if (!config.notifications.telegram.enabled || !config.notifications.telegram.daily_digest) return;

  const qh = config.notifications.quiet_hours;
  if (qh.enabled && isInQuietHoursEnv(qh.start, qh.end)) return;

  const portfolio = await readPortfolio(fundName);
  const tracker = await readTracker(fundName).catch(() => null);
  const snapshot = await readDailySnapshot(fundName);

  const today = new Date().toISOString().split("T")[0];
  let pnlLine = "";
  if (snapshot && snapshot.date === today) {
    const pnl = portfolio.total_value - snapshot.total_value;
    const pnlPct = snapshot.total_value > 0 ? (pnl / snapshot.total_value) * 100 : 0;
    const sign = pnl >= 0 ? "+" : "";
    pnlLine = `P&amp;L: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`;
  } else {
    pnlLine = `Value: $${portfolio.total_value.toFixed(2)}`;
  }

  const cashPct = portfolio.total_value > 0
    ? ((portfolio.cash / portfolio.total_value) * 100).toFixed(1)
    : "100.0";

  let topMover = "";
  if (portfolio.positions.length > 0) {
    const best = portfolio.positions.reduce((a, b) =>
      Math.abs(a.unrealized_pnl_pct) > Math.abs(b.unrealized_pnl_pct) ? a : b);
    const sign = best.unrealized_pnl_pct >= 0 ? "+" : "";
    topMover = `\nTop mover: ${best.symbol} ${sign}${best.unrealized_pnl_pct.toFixed(1)}%`;
  }

  const objectiveLine = tracker
    ? `\nObjective: ${tracker.progress_pct.toFixed(1)}% toward goal`
    : "";

  const displayName = config.fund.display_name;
  const message = [
    `📊 <b>${displayName}</b> — Daily Digest (${today})`,
    pnlLine,
    `Portfolio: $${portfolio.total_value.toFixed(2)}`,
    `Cash: ${cashPct}% | Positions: ${portfolio.positions.length}`,
  ].join("\n") + topMover + objectiveLine;

  const { sendTelegramNotification } = await import("./gateway.service.js");
  await sendTelegramNotification(message);
}

export async function sendWeeklyDigest(fundName: string): Promise<void> {
  const config = await loadFundConfig(fundName);
  if (!config.notifications.telegram.enabled || !config.notifications.telegram.weekly_digest) return;

  const qh = config.notifications.quiet_hours;
  if (qh.enabled && isInQuietHoursEnv(qh.start, qh.end)) return;

  const portfolio = await readPortfolio(fundName);
  const tracker = await readTracker(fundName).catch(() => null);

  const { openJournal, getTradesInDays } = await import("../journal.js");
  const db = openJournal(fundName);
  let trades: Array<{ pnl?: number | null }> = [];
  try {
    trades = getTradesInDays(db, fundName, 7);
  } finally {
    db.close();
  }

  const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;
  const bestPnl = trades.reduce((max, t) => Math.max(max, t.pnl ?? 0), 0);
  const worstPnl = trades.reduce((min, t) => Math.min(min, t.pnl ?? 0), 0);
  const weeklyPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekRange = `${weekAgo.toISOString().split("T")[0]} – ${today.toISOString().split("T")[0]}`;

  const pnlLine = weeklyPnl !== 0
    ? `\nRealized P&amp;L: ${weeklyPnl >= 0 ? "+" : ""}$${weeklyPnl.toFixed(2)}`
    : "";

  const objectiveLine = tracker
    ? `\nObjective: ${tracker.progress_pct.toFixed(1)}% toward goal`
    : "";

  const displayName = config.fund.display_name;
  const message = [
    `📅 <b>${displayName}</b> — Weekly Digest (${weekRange})`,
    `Portfolio: $${portfolio.total_value.toFixed(2)}`,
    `Trades: ${trades.length} (${wins} wins, ${losses} losses)`,
    `Best: $${bestPnl.toFixed(2)} | Worst: $${worstPnl.toFixed(2)}`,
  ].join("\n") + pnlLine + objectiveLine;

  const { sendTelegramNotification } = await import("./gateway.service.js");
  await sendTelegramNotification(message);
}

const MILESTONE_THRESHOLDS = [10, 25, 50, 75, 100];
const DRAWDOWN_BUDGET_THRESHOLDS = [50, 75];

export async function checkMilestonesAndDrawdown(fundName: string): Promise<void> {
  const config = await loadFundConfig(fundName);
  if (!config.notifications.telegram.enabled) return;

  const portfolio = await readPortfolio(fundName);
  const tracker = await readTracker(fundName).catch(() => null);
  const milestones = await readNotifiedMilestones(fundName);

  const displayName = config.fund.display_name;
  const { sendTelegramNotification } = await import("./gateway.service.js");

  // Update peak value
  if (portfolio.total_value > milestones.peak_value) {
    milestones.peak_value = portfolio.total_value;
    milestones.drawdown_thresholds_notified = [];
  }

  // Milestone check
  if (tracker && config.notifications.telegram.milestone_alerts) {
    const qh = config.notifications.quiet_hours;
    const suppressed = qh.enabled && isInQuietHoursEnv(qh.start, qh.end);

    if (!suppressed) {
      for (const threshold of MILESTONE_THRESHOLDS) {
        if (
          tracker.progress_pct >= threshold &&
          !milestones.thresholds_notified.includes(threshold)
        ) {
          milestones.thresholds_notified.push(threshold);
          const gain = portfolio.total_value - tracker.initial_capital;
          const sign = gain >= 0 ? "+" : "";
          await sendTelegramNotification(
            `🎯 <b>${displayName}</b> — Milestone: ${threshold}% of objective reached\n` +
            `$${tracker.initial_capital.toLocaleString("en-US")} → $${portfolio.total_value.toLocaleString("en-US")} (${sign}$${gain.toFixed(2)})`,
          );
        }
      }
    }
  }

  // Drawdown check (CRITICAL — bypasses quiet hours with allow_critical)
  if (config.notifications.telegram.drawdown_alerts && milestones.peak_value > 0) {
    const drawdownPct = ((milestones.peak_value - portfolio.total_value) / milestones.peak_value) * 100;
    const maxDrawdown = config.risk.max_drawdown_pct;
    const budgetUsed = maxDrawdown > 0 ? (drawdownPct / maxDrawdown) * 100 : 0;

    const qh = config.notifications.quiet_hours;
    const inQuiet = qh.enabled && isInQuietHoursEnv(qh.start, qh.end);
    const allowCrit = qh.allow_critical;
    const suppressed = inQuiet && !allowCrit;

    if (!suppressed) {
      for (const threshold of DRAWDOWN_BUDGET_THRESHOLDS) {
        if (
          budgetUsed >= threshold &&
          !milestones.drawdown_thresholds_notified.includes(threshold)
        ) {
          milestones.drawdown_thresholds_notified.push(threshold);
          const action = threshold >= 75
            ? "No new positions, reduce-only mode"
            : "Half sizing on new positions";
          await sendTelegramNotification(
            `📉 <b>${displayName}</b> — Drawdown Warning\n` +
            `-$${(milestones.peak_value - portfolio.total_value).toFixed(2)} (-${drawdownPct.toFixed(1)}%) from peak $${milestones.peak_value.toLocaleString("en-US")}\n` +
            `Drawdown budget: ${budgetUsed.toFixed(0)}% used (max -${maxDrawdown}%)\n` +
            `Action: ${action}`,
          );
        }
      }
    }
  }

  milestones.last_checked = new Date().toISOString();
  await writeNotifiedMilestones(fundName, milestones);
}

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

/** Check if daemon is already running (robust version, read-only — does NOT delete PID files) */
export async function isDaemonRunning(): Promise<boolean> {
  if (!existsSync(DAEMON_PID)) return false;

  try {
    const content = await readFile(DAEMON_PID, "utf-8");
    const info = parsePidFile(content);
    if (!info) {
      return false;
    }

    // Check process exists
    try {
      process.kill(info.pid, 0);
    } catch {
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
        return false;
      }
    } catch {
      // No heartbeat file — don't fail, could be newly started
    }

    return true;
  } catch {
    return false;
  }
}

/** Clean up stale PID and heartbeat files. Call only from startDaemon / stopSupervisor. */
export async function cleanStalePidFiles(): Promise<void> {
  if (!existsSync(DAEMON_PID)) return;

  try {
    const content = await readFile(DAEMON_PID, "utf-8");
    const info = parsePidFile(content);
    if (!info) {
      await unlink(DAEMON_PID).catch(() => {});
      return;
    }

    let alive = false;
    try {
      process.kill(info.pid, 0);
      alive = true;
    } catch {
      // Process is dead
    }

    if (!alive) {
      await unlink(DAEMON_PID).catch(() => {});
      await unlink(DAEMON_HEARTBEAT).catch(() => {});
      return;
    }

    // Check heartbeat freshness
    try {
      const hbStat = await stat(DAEMON_HEARTBEAT);
      const age = Date.now() - hbStat.mtimeMs;
      if (age > HEARTBEAT_STALE_MS) {
        await unlink(DAEMON_PID).catch(() => {});
        await unlink(DAEMON_HEARTBEAT).catch(() => {});
      }
    } catch {
      // No heartbeat file — don't clean up, could be newly started
    }
  } catch {
    await unlink(DAEMON_PID).catch(() => {});
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

/** Remove analysis files older than 30 days from all fund analysis/ directories */
export async function cleanOldAnalysisFiles(): Promise<void> {
  const fundNames = await listFundNames();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const name of fundNames) {
    const analysisDir = fundPaths(name).analysis;
    try {
      const files = await readdir(analysisDir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = join(analysisDir, file);
        const stats = await stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await unlink(filePath);
        }
      }
    } catch {
      // analysis dir may not exist for new funds
    }
  }
}

/** Start the scheduler daemon */
export async function startDaemon(): Promise<void> {
  if (await isDaemonRunning()) {
    throw new Error("Daemon is already running.");
  }

  // Clean up stale PID/heartbeat files before writing new ones
  await cleanStalePidFiles();

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
              generateDailyReport(name).then(async () => {
                try { await sendDailyDigest(name); } catch (err) {
                  await log(`Daily digest error (${name}): ${err}`);
                }
              }).catch(async (err) => {
                await log(`Daily report error (${name}): ${err}`);
              });
            }
            if (currentDay === "FRI" && currentTime === WEEKLY_REPORT_TIME) {
              generateWeeklyReport(name).then(async () => {
                try { await sendWeeklyDigest(name); } catch (err) {
                  await log(`Weekly digest error (${name}): ${err}`);
                }
              }).catch(async (err) => {
                await log(`Weekly report error (${name}): ${err}`);
              });
            }
            const dayOfMonth = parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(now), 10);
            if (dayOfMonth === 1 && currentTime === MONTHLY_REPORT_TIME) {
              generateMonthlyReport(name).catch(async (err) => {
                await log(`Monthly report error (${name}): ${err}`);
              });
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
                  // Write daily snapshot at first check of the day
                  try {
                    const today = new Date().toISOString().split("T")[0];
                    const snap = await readDailySnapshot(name);
                    if (!snap || snap.date !== today) {
                      const port = await readPortfolio(name);
                      await writeDailySnapshot(name, { date: today, total_value: port.total_value });
                    }
                  } catch { /* non-critical */ }

                  const triggered = await checkStopLosses(name);
                  if (triggered.length > 0) {
                    await log(
                      `Stop-loss triggered for '${name}': ${triggered.map((t) => t.symbol).join(", ")}`,
                    );
                    await executeStopLosses(name, triggered);
                  }
                  clearError(name, "stoploss");

                  // Check milestones and drawdown
                  try {
                    await checkMilestonesAndDrawdown(name);
                  } catch (err) {
                    await log(`Milestone/drawdown check error (${name}): ${err}`);
                  }
                } catch (err) {
                  trackError(name, "stoploss", err);
                } finally {
                  await releaseFundLock(name);
                }
              }
            }

            // ── Pending sessions (proactive: news reactions, agent follow-ups) ──
            try {
              let pending = await readPendingSessions(name);
              if (pending.length === 0) { /* skip */ }
              else {
                const nowMs = Date.now();
                const nowIso = new Date().toISOString();
                const today = nowIso.split("T")[0];

                // Discard stale (>1h past) and too-far-future (>24h) entries
                pending = pending.filter((s) => {
                  const schedMs = new Date(s.scheduled_at).getTime();
                  if (nowMs - schedMs > 60 * 60 * 1000) return false; // stale
                  if (schedMs - nowMs > 24 * 60 * 60 * 1000) return false; // too far
                  return true;
                });

                // Find due entries
                const due = pending
                  .filter((s) => new Date(s.scheduled_at).getTime() <= nowMs)
                  .sort((a, b) => {
                    const prio = (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1);
                    if (prio !== 0) return prio;
                    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
                  });

                if (due.length > 0) {
                  const session = due[0]!;
                  let counts = await readSessionCounts(name);

                  // Reset counts if date changed
                  if (counts.date !== today) {
                    counts = { date: today, agent: 0, news: 0 };
                  }

                  // Check source-specific limits
                  let withinLimits = true;
                  if (session.source === "agent") {
                    if (counts.agent >= 5) withinLimits = false;
                    if (counts.last_agent_at) {
                      const elapsed = nowMs - new Date(counts.last_agent_at).getTime();
                      if (elapsed < 5 * 60 * 1000) withinLimits = false;
                    }
                  } else if (session.source === "news") {
                    if (counts.news >= 5) withinLimits = false;
                    if (counts.last_news_at) {
                      const elapsed = nowMs - new Date(counts.last_news_at).getTime();
                      if (elapsed < 60 * 60 * 1000) withinLimits = false;
                    }
                  }

                  let shouldRemove = false;

                  if (withinLimits) {
                    const locked = await acquireFundLock(name, session.type);
                    if (locked) {
                      shouldRemove = true;
                      try {
                        await log(`[proactive] Running ${session.type} for '${name}' (source: ${session.source})`);
                        await withTimeout(
                          runFundSession(name, session.type, {
                            focus: session.focus,
                            maxTurns: session.max_turns,
                            maxDurationMinutes: session.max_duration_minutes,
                          }),
                          (session.max_duration_minutes ?? 5) * 60 * 1000,
                        );

                        // Update counts
                        if (session.source === "agent") {
                          counts.agent += 1;
                          counts.last_agent_at = nowIso;
                        } else {
                          counts.news += 1;
                          counts.last_news_at = nowIso;
                        }
                        await writeSessionCounts(name, counts);
                      } catch (err) {
                        await log(`[proactive] Error in ${session.type} for '${name}': ${err}`);
                      } finally {
                        await releaseFundLock(name);
                      }
                    }
                    // else: lock held — leave in queue for next tick
                  } else {
                    shouldRemove = true;
                    await log(`[proactive] Limit reached for '${name}' (${session.source}), skipping ${session.type}`);
                  }

                  if (shouldRemove) {
                    pending = pending.filter((s) => s.id !== session.id);
                  }
                }

                // Write back cleaned pending list
                await writePendingSessions(name, pending);
              }
            } catch (err) {
              await log(`[proactive] Error processing pending sessions for '${name}': ${err}`);
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

  // News feed fetcher — every 5 min, reduced off-hours
  let lastNewsFetchAt = 0;
  cron.schedule("*/5 * * * *", async () => {
    const hour = new Date().getUTCHours();
    const isMarketHours = hour >= 8 && hour < 19;
    const elapsed = Date.now() - lastNewsFetchAt;

    if (!isMarketHours && elapsed < 30 * 60 * 1000) return;

    lastNewsFetchAt = Date.now();
    try {
      const newArticles = await fetchAllFeeds();
      if (newArticles.length > 0) {
        await log(`[news] Fetched ${newArticles.length} new articles`);
        await checkBreakingNews(newArticles);
      }
    } catch (err) {
      await log(`[news] Fetch error: ${err}`);
    }
  });

  // Daily cleanup of old news articles and analysis files
  cron.schedule("0 0 * * *", async () => {
    try {
      await cleanOldArticles();
      await log("[news] Old articles cleaned up");
    } catch (err) {
      await log(`[news] Cleanup error: ${err}`);
    }
    try {
      await cleanOldAnalysisFiles();
      await log("[analysis] Old analysis files cleaned up");
    } catch (err) {
      await log(`[analysis] Cleanup error: ${err}`);
    }
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
  // Clean stale files before attempting to stop
  await cleanStalePidFiles();

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
