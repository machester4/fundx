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

/** Truncate `s` to at most `max` characters; if truncated, append a marker
 *  noting how many characters were dropped. */
function clip(s: string, max: number, label: string): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated, ${s.length - max} chars omitted from ${label}]`;
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

  const [handoff, portfolio, tracker, pendingSessions] = await Promise.all([
    readOr(paths.state.sessionHandoff, "(none — first session)"),
    readOr(paths.state.portfolio, "(none)"),
    readOr(paths.state.tracker, "(none)"),
    readOr(paths.state.pendingSessions, "(none)"),
  ]);
  const recentTrades = tryRecentTrades(fundName);
  const watchlist = tryWatchlistTop(fundName);

  const hasHandoff = handoff !== "(none — first session)";
  // Framing for the inherited handoff. Without it, agents anchor on the prior
  // session's self-authored "gates" / "do not enter" language as if it were a
  // standing order, producing perpetual cash-holding. Sits in the same message
  // as the handoff so it counters the anchoring at decision time.
  const handoffGuidance = hasHandoff
    ? `<handoff_guidance>
The session_handoff above is your prior self's working notes — context, not standing orders. Any "gates", checklists, price "zones", or "do not enter" conditions in it are judgment calls to re-validate against today's data and the objective, NOT hard constraints. Only the risk limits in fund_config are binding. A self-authored condition that has blocked action for several sessions running — especially one that can never be cleanly satisfied (e.g. "no geopolitical risk in 24h") — is functioning as an excuse: discard it or size around it with a tighter stop, don't treat it as a veto. Decide fresh this session, and weigh the opportunity cost of staying in cash against the objective.
</handoff_guidance>`
    : "";

  return [
    `<state_snapshot>`,
    `<session_handoff>${hasHandoff ? `\n${clip(handoff.trim(), 8_000, "session-handoff")}\n` : "(none — first session)"}</session_handoff>`,
    ...(handoffGuidance ? [handoffGuidance] : []),
    `<portfolio>${portfolio === "(none)" ? "(none)" : `\n${clip(portfolio.trim(), 8_000, "portfolio")}\n`}</portfolio>`,
    `<objective_tracker>${tracker === "(none)" ? "(none)" : `\n${clip(tracker.trim(), 4_000, "objective_tracker")}\n`}</objective_tracker>`,
    `<pending_sessions>${pendingSessions === "(none)" ? "(none)" : `\n${clip(pendingSessions.trim(), 4_000, "pending_sessions")}\n`}</pending_sessions>`,
    `<recent_trades count="${TOP_TRADES}">${recentTrades.startsWith("(") ? recentTrades : `\n${clip(recentTrades, 12_000, "recent_trades")}\n`}</recent_trades>`,
    `<watchlist top="${TOP_WATCHLIST}">${watchlist.startsWith("(") ? watchlist : `\n${clip(watchlist, 8_000, "watchlist")}\n`}</watchlist>`,
    `</state_snapshot>`,
  ].join("\n");
}
