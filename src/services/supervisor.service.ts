import { fork, spawn } from "node:child_process";
import { readFile, writeFile, unlink, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { SUPERVISOR_PID, DAEMON_NEEDS_RESTART, DAEMON_HEARTBEAT } from "../paths.js";

const MAX_RESTARTS = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

/** Calculate exponential backoff delay for restart attempt N */
export function getBackoffDelay(attempt: number): number {
  return Math.min(2000 * Math.pow(2, attempt), 32000);
}

/** Check if we should give up restarting (5 failures in 10 min window) */
export function shouldGiveUp(restartTimestamps: number[], now: number): boolean {
  const recent = restartTimestamps.filter((t) => now - t < WINDOW_MS);
  return recent.length >= MAX_RESTARTS;
}

export interface HeartbeatEvalInput {
  now: number;
  heartbeatMtimeMs: number;
  heartbeatExists: boolean;
  daemonLaunchedAt: number;
  daemonRunning: boolean;
  previouslyAlerted: boolean;
  /** Wall-clock time since the supervisor's previous tick fired. Used to detect
   *  OS-level suspension (laptop sleep): if our own setInterval lagged, the
   *  daemon's missed heartbeat is almost certainly the same cause, not a wedge.
   *  Omit on the very first tick. */
  wallClockDeltaMs?: number;
  /** Nominal interval between supervisor ticks (e.g., 60_000). Required when
   *  `wallClockDeltaMs` is provided. */
  intervalMs?: number;
}

export interface HeartbeatEvalResult {
  shouldAlert: boolean;
  shouldRecover: boolean;
  stale: boolean;
  ageMs: number;
  /** True when the supervisor's own wall-clock drift suggests the host was
   *  suspended (sleep, app nap). When true with a stale heartbeat, the alert
   *  is suppressed for this tick — the daemon will catch up on its next cron
   *  fire, and if it doesn't a subsequent tick (with normal wallClockDelta)
   *  will raise the real alarm. */
  suspectedSuspension: boolean;
}

/** Pure: decide whether to alert / recover based on heartbeat freshness.
 *  - If daemon not running: no alerts ever.
 *  - If heartbeat exists: stale = (now - mtime) > HEARTBEAT_STALE_MS.
 *  - If heartbeat missing: stale = (now - daemonLaunchedAt) > HEARTBEAT_STALE_MS (grace period).
 *  - shouldAlert: stale AND not previouslyAlerted AND NOT suspectedSuspension.
 *  - shouldRecover: not stale AND previouslyAlerted (regardless of suspension —
 *    a fresh heartbeat is unambiguous).
 *  - suspectedSuspension: wallClockDeltaMs > 2 * intervalMs (when both provided). */
export function evaluateHeartbeatStaleness(input: HeartbeatEvalInput): HeartbeatEvalResult {
  if (!input.daemonRunning) {
    return { shouldAlert: false, shouldRecover: false, stale: false, ageMs: 0, suspectedSuspension: false };
  }

  let stale = false;
  let ageMs = 0;
  if (input.heartbeatExists) {
    ageMs = input.now - input.heartbeatMtimeMs;
    stale = ageMs > HEARTBEAT_STALE_MS;
  } else {
    const sinceLaunchMs = input.now - input.daemonLaunchedAt;
    stale = sinceLaunchMs > HEARTBEAT_STALE_MS;
    ageMs = sinceLaunchMs;
  }

  const suspectedSuspension =
    input.wallClockDeltaMs !== undefined &&
    input.intervalMs !== undefined &&
    input.wallClockDeltaMs > 2 * input.intervalMs;

  const shouldAlert = stale && !input.previouslyAlerted && !suspectedSuspension;
  const shouldRecover = !stale && input.previouslyAlerted;
  return { shouldAlert, shouldRecover, stale, ageMs, suspectedSuspension };
}

/**
 * Start the supervisor process (blocking -- runs until stopped).
 * Forks the daemon as a child and restarts it on crash.
 */
export async function startSupervisor(): Promise<void> {
  await writeFile(SUPERVISOR_PID, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");

  const restartTimestamps: number[] = [];
  let attempt = 0;
  let stopping = false;
  let currentChild: ReturnType<typeof fork> | null = null;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  let daemonLaunchedAt = Date.now();

  // Signal handlers registered ONCE at supervisor scope (not per-launch)
  async function handleShutdown() {
    stopping = true;
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    if (currentChild) currentChild.kill("SIGTERM");
    setTimeout(async () => {
      await unlink(SUPERVISOR_PID).catch(() => {});
      process.exit(0);
    }, 5000);
  }
  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);

  function launchDaemon() {
    daemonLaunchedAt = Date.now();
    const child = fork(process.argv[1]!, ["--_daemon-mode"], {
      stdio: "inherit",
    });
    currentChild = child;

    child.on("exit", async (code) => {
      if (stopping) return;
      currentChild = null;

      // Clear any pending reset timer from the previous launch
      if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }

      const now = Date.now();
      restartTimestamps.push(now);

      if (shouldGiveUp(restartTimestamps, now)) {
        try {
          const { notifyDaemonEvent } = await import("./daemon.service.js");
          await notifyDaemonEvent(
            "Max restarts exceeded",
            `Daemon crashed ${MAX_RESTARTS} times in 10 min. Giving up. Manual restart needed.`,
          );
        } catch {
          /* best effort */
        }
        await unlink(SUPERVISOR_PID).catch(() => {});
        process.exit(1);
      }

      // Prune old timestamps outside the window
      const cutoff = now - WINDOW_MS;
      while (restartTimestamps.length > 0 && restartTimestamps[0]! < cutoff) {
        restartTimestamps.shift();
      }

      const delay = getBackoffDelay(attempt);
      attempt++;

      try {
        const { notifyDaemonEvent } = await import("./daemon.service.js");
        await notifyDaemonEvent(
          "Daemon crashed",
          `Exit code ${code}. Restarting in ${delay / 1000}s (attempt ${attempt}/${MAX_RESTARTS})`,
        );
      } catch {
        /* best effort */
      }

      setTimeout(() => {
        launchDaemon();
      }, delay);
    });

    // Reset attempt counter on successful run (child alive for > 60s)
    resetTimer = setTimeout(() => {
      if (!stopping) attempt = 0;
      resetTimer = null;
    }, 60000);
  }

  // Periodically check if the daemon needs a restart (e.g., expired auth token).
  // The session runner writes daemon.needs-restart on auth failure.
  const restartCheckInterval = setInterval(async () => {
    if (stopping || !currentChild) return;
    if (existsSync(DAEMON_NEEDS_RESTART)) {
      await unlink(DAEMON_NEEDS_RESTART).catch(() => {});
      // Don't count auth restarts against the crash budget — reset attempt counter
      attempt = 0;
      currentChild.kill("SIGTERM");
      // The child's "exit" handler will re-launch after backoff
    }
  }, 60_000);

  process.on("SIGTERM", () => clearInterval(restartCheckInterval));
  process.on("SIGINT", () => clearInterval(restartCheckInterval));

  // Phase 4: heartbeat freshness watch — proactively alert if daemon's event loop is hung
  let heartbeatAlerted = false;
  // Wall-clock anchor for OS-suspension detection. When the laptop sleeps,
  // setInterval pauses; the gap between two consecutive ticks lets us
  // distinguish "host was suspended" from "daemon is genuinely wedged".
  let lastHeartbeatTickAt = 0;
  const HEARTBEAT_INTERVAL_MS = 60_000;

  const heartbeatCheckInterval = setInterval(async () => {
    if (stopping) return;
    const tickNow = Date.now();
    const wallClockDeltaMs = lastHeartbeatTickAt > 0 ? tickNow - lastHeartbeatTickAt : undefined;
    lastHeartbeatTickAt = tickNow;

    let mtimeMs = 0;
    let exists = false;
    if (existsSync(DAEMON_HEARTBEAT)) {
      try {
        const s = await stat(DAEMON_HEARTBEAT);
        mtimeMs = s.mtimeMs;
        exists = true;
      } catch {
        // read error → treat as missing (use grace-period semantics)
      }
    }

    const result = evaluateHeartbeatStaleness({
      now: tickNow,
      heartbeatMtimeMs: mtimeMs,
      heartbeatExists: exists,
      daemonLaunchedAt,
      daemonRunning: currentChild !== null,
      previouslyAlerted: heartbeatAlerted,
      wallClockDeltaMs,
      intervalMs: HEARTBEAT_INTERVAL_MS,
    });

    if (result.stale && result.suspectedSuspension && !heartbeatAlerted) {
      // Log silently so post-mortems can see we skipped the alert intentionally;
      // do NOT notify the user — the daemon will catch up on its next tick.
      try {
        const { logDaemonLine } = await import("./daemon.service.js");
        await logDaemonLine(
          `[supervisor] suppressed stale alert: wallClockDelta=${Math.round(wallClockDeltaMs! / 1000)}s suggests OS suspension`,
        );
      } catch {
        /* best effort */
      }
    }

    if (result.shouldAlert) {
      try {
        const { logDaemonEvent, logDaemonLine } = await import("./daemon.service.js");
        const { notifySupervisorStale } = await import("./notify.service.js");
        const subject = "Daemon heartbeat stale";
        const details = `Heartbeat ${Math.round(result.ageMs / 1000)}s old. Sessions may be missed.`;
        if (logDaemonEvent(subject)) {
          await logDaemonLine(`[ALERT] ${subject}: ${details}`);
          notifySupervisorStale("daemon", new Date(Date.now() - result.ageMs));
        }
        heartbeatAlerted = true;
      } catch (err) {
        console.error("[supervisor] heartbeat notify failed:", err);
      }
    } else if (result.shouldRecover) {
      try {
        const { notifyDaemonEvent } = await import("./daemon.service.js");
        await notifyDaemonEvent(
          "Daemon heartbeat recovered",
          "Heartbeat fresh again after stale period.",
        );
        heartbeatAlerted = false;
      } catch (err) {
        console.error("[supervisor] heartbeat notify failed:", err);
      }
    }
  }, 60_000);

  process.on("SIGTERM", () => clearInterval(heartbeatCheckInterval));
  process.on("SIGINT", () => clearInterval(heartbeatCheckInterval));

  launchDaemon();
}

/**
 * Fork a detached supervisor process (non-blocking -- returns immediately).
 * Used by `fundx start` and the dashboard.
 */
export async function forkSupervisor(): Promise<void> {
  if (existsSync(SUPERVISOR_PID)) {
    try {
      const raw = JSON.parse(await readFile(SUPERVISOR_PID, "utf-8"));
      process.kill(raw.pid, 0);

      // If a restart is needed (token expired), kill the old supervisor so a fresh
      // one inherits the current CLAUDE_CODE_OAUTH_TOKEN from this Claude Code session.
      if (existsSync(DAEMON_NEEDS_RESTART)) {
        process.kill(raw.pid, "SIGTERM");
        await unlink(SUPERVISOR_PID).catch(() => {});
        await unlink(DAEMON_NEEDS_RESTART).catch(() => {});
        // Fall through to fork a new supervisor below
      } else {
        return; // Already running, no restart needed
      }
    } catch {
      await unlink(SUPERVISOR_PID).catch(() => {});
    }
  }

  const { isDaemonRunning } = await import("./daemon.service.js");
  if (await isDaemonRunning()) return; // Daemon running without supervisor (legacy)

  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "--_supervisor-mode"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
