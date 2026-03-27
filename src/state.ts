import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  portfolioSchema,
  objectiveTrackerSchema,
  sessionLogSchema,
  activeSessionSchema,
  chatHistorySchema,
  type Portfolio,
  type ObjectiveTracker,
  type SessionLog,
  type ActiveSession,
  type ChatHistory,
  type SessionHistory,
  sessionHistorySchema,
  pendingSessionSchema,
  sessionCountsSchema,
  type PendingSession,
  type SessionCounts,
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
  } catch (err: unknown) {
    // File not found is expected for new funds
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    // Re-throw corrupted JSON or schema validation errors
    throw err;
  }
}

export async function writeSessionLog(
  fundName: string,
  log: SessionLog,
): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.sessionLog, log);
}

// ── Active Session ─────────────────────────────────────────────

export async function readActiveSession(fundName: string): Promise<ActiveSession | null> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.activeSession);
    return activeSessionSchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function writeActiveSession(fundName: string, data: ActiveSession): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.activeSession, data);
}

export async function clearActiveSession(fundName: string): Promise<void> {
  const paths = fundPaths(fundName);
  try {
    await unlink(paths.state.activeSession);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}

// ── Chat History ───────────────────────────────────────────────

export async function readChatHistory(fundName: string): Promise<ChatHistory | null> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.chatHistory);
    return chatHistorySchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeChatHistory(fundName: string, history: ChatHistory): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.chatHistory, history);
}

export async function clearChatHistory(fundName: string): Promise<void> {
  const paths = fundPaths(fundName);
  try {
    await unlink(paths.state.chatHistory);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return;
    throw err;
  }
}

// ── Session History ───────────────────────────────────────────

export async function readSessionHistory(fundName: string): Promise<SessionHistory> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.sessionHistory);
    return sessionHistorySchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export async function writeSessionHistory(fundName: string, history: SessionHistory): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.sessionHistory, history);
}

// ── Pending Sessions ──────────────────────────────────────────

export async function readPendingSessions(fundName: string): Promise<PendingSession[]> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.pendingSessions);
    const arr = Array.isArray(data) ? data : [];
    return arr.map((item) => pendingSessionSchema.parse(item));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function writePendingSessions(fundName: string, sessions: PendingSession[]): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.pendingSessions, sessions);
}

// ── Session Counts ────────────────────────────────────────────

export async function readSessionCounts(fundName: string): Promise<SessionCounts> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.sessionCounts);
    return sessionCountsSchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { date: new Date().toISOString().split("T")[0], agent: 0, news: 0 };
    }
    throw err;
  }
}

export async function writeSessionCounts(fundName: string, counts: SessionCounts): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.sessionCounts, counts);
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
