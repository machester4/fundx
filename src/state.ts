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
  dailySnapshotSchema,
  notifiedMilestonesSchema,
  type DailySnapshot,
  type NotifiedMilestones,
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

/**
 * Normalize position fields written by Claude sessions (alternative field names
 * that Claude sometimes uses) to the canonical schema names. This prevents Zod
 * validation errors when Claude writes portfolio.json with non-standard field names.
 */
function normalizePositions(data: unknown): unknown {
  if (!data || typeof data !== "object" || !("positions" in data)) return data;
  const obj = data as Record<string, unknown>;
  const positions = obj.positions;
  if (!Array.isArray(positions)) return data;

  obj.positions = positions.map((pos: Record<string, unknown>) => {
    const normalized = { ...pos };
    // qty → shares
    if (normalized.qty !== undefined && normalized.shares === undefined) {
      normalized.shares = Number(normalized.qty);
    }
    // avg_entry_price → avg_cost
    if (normalized.avg_entry_price !== undefined && normalized.avg_cost === undefined) {
      normalized.avg_cost = Number(normalized.avg_entry_price);
    }
    // pct_of_portfolio → weight_pct
    if (normalized.pct_of_portfolio !== undefined && normalized.weight_pct === undefined) {
      normalized.weight_pct = Number(normalized.pct_of_portfolio);
    }
    // thesis → entry_reason
    if (normalized.thesis !== undefined && (!normalized.entry_reason || normalized.entry_reason === "")) {
      normalized.entry_reason = String(normalized.thesis);
    }
    // Ensure entry_date has a default
    if (normalized.entry_date === undefined) {
      normalized.entry_date = new Date().toISOString().split("T")[0];
    }
    return normalized;
  });

  return obj;
}

export async function readPortfolio(fundName: string): Promise<Portfolio> {
  const paths = fundPaths(fundName);
  const data = await readJson(paths.state.portfolio);
  return portfolioSchema.parse(normalizePositions(data));
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
    // Use safeParse to tolerate malformed entries written by the agent
    return arr
      .map((item) => pendingSessionSchema.safeParse(item))
      .filter((r): r is { success: true; data: PendingSession } => r.success)
      .map((r) => r.data);
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

// ── Session Handoff ────────────────────────────────────────────

export async function readSessionHandoff(fundName: string): Promise<string | null> {
  const paths = fundPaths(fundName);
  try {
    return await readFile(paths.state.sessionHandoff, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeSessionHandoff(fundName: string, content: string): Promise<void> {
  const paths = fundPaths(fundName);
  await mkdir(dirname(paths.state.sessionHandoff), { recursive: true });
  const tmp = paths.state.sessionHandoff + ".tmp";
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, paths.state.sessionHandoff);
}

// ── Daily Snapshot ────────────────────────────────────────────

export async function readDailySnapshot(fundName: string): Promise<DailySnapshot | null> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.dailySnapshot);
    return dailySnapshotSchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeDailySnapshot(fundName: string, snapshot: DailySnapshot): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.dailySnapshot, snapshot);
}

// ── Notified Milestones ──────────────────────────────────────

export async function readNotifiedMilestones(fundName: string): Promise<NotifiedMilestones> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.notifiedMilestones);
    return notifiedMilestonesSchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return notifiedMilestonesSchema.parse({});
    }
    throw err;
  }
}

export async function writeNotifiedMilestones(fundName: string, milestones: NotifiedMilestones): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.notifiedMilestones, milestones);
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
