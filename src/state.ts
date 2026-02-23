import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  portfolioSchema,
  objectiveTrackerSchema,
  sessionLogSchema,
  type Portfolio,
  type ObjectiveTracker,
  type SessionLog,
} from "./types.js";
import { fundPaths } from "./paths.js";

/** Write JSON atomically: write to .tmp then rename */
async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmp, filePath);
}

async function readJson(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

// ── Portfolio ──────────────────────────────────────────────────

export async function readPortfolio(fundName: string): Promise<Portfolio> {
  const paths = fundPaths(fundName);
  const data = await readJson(paths.state.portfolio);
  return portfolioSchema.parse(data);
}

export async function writePortfolio(
  fundName: string,
  portfolio: Portfolio,
): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.portfolio, portfolio);
}

// ── Objective Tracker ──────────────────────────────────────────

export async function readTracker(
  fundName: string,
): Promise<ObjectiveTracker> {
  const paths = fundPaths(fundName);
  const data = await readJson(paths.state.tracker);
  return objectiveTrackerSchema.parse(data);
}

export async function writeTracker(
  fundName: string,
  tracker: ObjectiveTracker,
): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.tracker, tracker);
}

// ── Session Log ────────────────────────────────────────────────

export async function readSessionLog(
  fundName: string,
): Promise<SessionLog | null> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.sessionLog);
    return sessionLogSchema.parse(data);
  } catch {
    return null;
  }
}

export async function writeSessionLog(
  fundName: string,
  log: SessionLog,
): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.sessionLog, log);
}

// ── Initialize state for a new fund ────────────────────────────

export async function initFundState(
  fundName: string,
  initialCapital: number,
  objectiveType: string,
): Promise<void> {
  const paths = fundPaths(fundName);

  await mkdir(paths.state.dir, { recursive: true });
  await mkdir(paths.analysis, { recursive: true });
  await mkdir(paths.scripts, { recursive: true });
  await mkdir(join(paths.reports, "daily"), { recursive: true });
  await mkdir(join(paths.reports, "weekly"), { recursive: true });
  await mkdir(join(paths.reports, "monthly"), { recursive: true });

  const now = new Date().toISOString();

  await writePortfolio(fundName, {
    last_updated: now,
    cash: initialCapital,
    total_value: initialCapital,
    positions: [],
  });

  await writeTracker(fundName, {
    type: objectiveType,
    initial_capital: initialCapital,
    current_value: initialCapital,
    progress_pct: 0,
    status: "on_track",
  });
}
