import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fundPaths } from "../paths.js";
import { writeJsonAtomic } from "../state.js";
import { notifyDaemonEvent } from "./daemon.service.js";
import type { DailyUsage } from "./session-history.service.js";

interface DailyCapState {
  alerted_for_date?: string;
}

function todayUtcDateString(): string {
  return new Date().toISOString().split("T")[0]!;
}

async function readDailyCapState(fundName: string): Promise<DailyCapState> {
  const path = fundPaths(fundName).state.dailyCapState;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as DailyCapState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Corrupt JSON (partial write, manual edit, disk error) must not block
    // session start forever — treat as fresh state and let next alert overwrite.
    if (err instanceof SyntaxError) {
      console.warn(
        `[daily-cap] corrupt state file for ${fundName}, resetting:`,
        err.message,
      );
      return {};
    }
    throw err;
  }
}

async function writeDailyCapState(fundName: string, state: DailyCapState): Promise<void> {
  const path = fundPaths(fundName).state.dailyCapState;
  await mkdir(dirname(path), { recursive: true });
  await writeJsonAtomic(path, state);
}

/** Send a one-shot per-day OS notification when a fund reaches its daily cap.
 *  If already alerted today (per fund), this is a no-op. */
export async function notifyDailyCapReached(
  fundName: string,
  capUsd: number,
  usage: DailyUsage,
): Promise<void> {
  const today = todayUtcDateString();
  const state = await readDailyCapState(fundName);
  if (state.alerted_for_date === today) return;

  const subject = `Daily cap reached — ${fundName}`;
  const body = `Fund ${fundName} reached daily cap $${capUsd} ($${usage.totalUsd.toFixed(2)} used in ${usage.sessionCount} sessions). Sessions will resume at 00:00 UTC tomorrow.`;
  await notifyDaemonEvent(subject, body);

  await writeDailyCapState(fundName, { alerted_for_date: today });
}

/** Clear the alerted_for_date so a fresh alert can fire on the next cap hit.
 *  Called by the daily cron tick at midnight UTC. */
export async function clearDailyCapAlertState(fundName: string): Promise<void> {
  await writeDailyCapState(fundName, {});
}
