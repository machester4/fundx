import { readFile } from "node:fs/promises";
import { fundPaths } from "../paths.js";
import { openJournal, getRecentTrades } from "../journal.js";
import { openWatchlistDb, queryWatchlist } from "./watchlist.service.js";

const TOP_TRADES = 10;
const TOP_WATCHLIST = 10;

async function readOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return fallback;
  }
}

function tryRecentTrades(fundName: string): string {
  let db: ReturnType<typeof openJournal> | undefined;
  try {
    db = openJournal(fundName);
    const trades = getRecentTrades(db, fundName, TOP_TRADES);
    if (trades.length === 0) return "(empty)";
    return JSON.stringify(trades, null, 2);
  } catch (err) {
    console.warn(
      `[snapshot] journal query failed for ${fundName}:`,
      err instanceof Error ? err.message : err,
    );
    return `(empty — ${err instanceof Error ? err.message : "query failed"})`;
  } finally {
    db?.close?.();
  }
}

function tryWatchlistTop(fundName: string): string {
  let db: ReturnType<typeof openWatchlistDb> | undefined;
  try {
    db = openWatchlistDb();
    const rows = queryWatchlist(db, {
      fund: fundName,
      status: ["candidate", "watching"],
      limit: TOP_WATCHLIST,
    });
    if (rows.length === 0) return "(empty)";
    return JSON.stringify(rows, null, 2);
  } catch (err) {
    console.warn(
      `[snapshot] watchlist query failed for ${fundName}:`,
      err instanceof Error ? err.message : err,
    );
    return `(empty — ${err instanceof Error ? err.message : "query failed"})`;
  } finally {
    db?.close?.();
  }
}

/**
 * Build an XML envelope with the fund's current state for prompt pre-population.
 * Robustness: never throws — missing files emit `(none)`, query failures emit `(empty)`.
 * See docs/superpowers/specs/2026-04-27-harness-phase-2-design.md Component 1.
 */
export async function buildStateSnapshot(fundName: string): Promise<string> {
  const paths = fundPaths(fundName);

  const handoff = await readOr(paths.state.sessionHandoff, "(none — first session)");
  const portfolio = await readOr(paths.state.portfolio, "(none)");
  const tracker = await readOr(paths.state.tracker, "(none)");
  const pendingSessions = await readOr(paths.state.pendingSessions, "(none)");
  const recentTrades = tryRecentTrades(fundName);
  const watchlist = tryWatchlistTop(fundName);

  return [
    `<state_snapshot>`,
    `<session_handoff>${handoff === "(none — first session)" ? "(none — first session)" : `\n${handoff.trim()}\n`}</session_handoff>`,
    `<portfolio>${portfolio === "(none)" ? "(none)" : `\n${portfolio.trim()}\n`}</portfolio>`,
    `<objective_tracker>${tracker === "(none)" ? "(none)" : `\n${tracker.trim()}\n`}</objective_tracker>`,
    `<pending_sessions>${pendingSessions === "(none)" ? "(none)" : `\n${pendingSessions.trim()}\n`}</pending_sessions>`,
    `<recent_trades count="${TOP_TRADES}">${recentTrades.startsWith("(") ? recentTrades : `\n${recentTrades}\n`}</recent_trades>`,
    `<watchlist top="${TOP_WATCHLIST}">${watchlist.startsWith("(") ? watchlist : `\n${watchlist}\n`}</watchlist>`,
    `</state_snapshot>`,
  ].join("\n");
}
