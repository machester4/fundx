import { fork, spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { SUPERVISOR_PID } from "../paths.js";

const MAX_RESTARTS = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/** Calculate exponential backoff delay for restart attempt N */
export function getBackoffDelay(attempt: number): number {
  return Math.min(2000 * Math.pow(2, attempt), 32000);
}

/** Check if we should give up restarting (5 failures in 10 min window) */
export function shouldGiveUp(restartTimestamps: number[], now: number): boolean {
  const recent = restartTimestamps.filter((t) => now - t < WINDOW_MS);
  return recent.length >= MAX_RESTARTS;
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

  // Signal handlers registered ONCE at supervisor scope (not per-launch)
  async function handleShutdown() {
    stopping = true;
    if (currentChild) currentChild.kill("SIGTERM");
    setTimeout(async () => {
      await unlink(SUPERVISOR_PID).catch(() => {});
      process.exit(0);
    }, 5000);
  }
  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);

  function launchDaemon() {
    const child = fork(process.argv[1]!, ["--_daemon-mode"], {
      stdio: "inherit",
    });
    currentChild = child;

    child.on("exit", async (code) => {
      if (stopping) return;
      currentChild = null;

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
    setTimeout(() => {
      if (!stopping) attempt = 0;
    }, 60000);
  }

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
      return; // Already running
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
