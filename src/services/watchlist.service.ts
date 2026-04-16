import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ScreenRun,
  type ScoreRow,
  type ScoreMetadata,
  type WatchlistEntry,
  type WatchlistStatus,
  type ScreenName,
  type StatusTransition,
  type UniverseResolution,
  watchlistStatusSchema,
  screenNameSchema,
  statusTransitionSchema,
} from "../types.js";
import { isInUniverse } from "./universe.service.js";
import { WATCHLIST_DB } from "../paths.js";

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS screen_runs (
     id               INTEGER PRIMARY KEY,
     screen_name      TEXT    NOT NULL,
     universe         TEXT    NOT NULL,
     ran_at           INTEGER NOT NULL,
     tickers_scored   INTEGER NOT NULL,
     tickers_passed   INTEGER NOT NULL,
     duration_ms      INTEGER NOT NULL,
     parameters_json  TEXT    NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS scores (
     id             INTEGER PRIMARY KEY,
     run_id         INTEGER NOT NULL REFERENCES screen_runs(id),
     ticker         TEXT    NOT NULL,
     screen_name    TEXT    NOT NULL,
     score          REAL    NOT NULL,
     passed         INTEGER NOT NULL,
     metadata_json  TEXT    NOT NULL,
     scored_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_scores_ticker_time ON scores(ticker, scored_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scores_screen_time ON scores(screen_name, scored_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scores_run ON scores(run_id)`,
  `CREATE TABLE IF NOT EXISTS watchlist (
     ticker                TEXT    PRIMARY KEY,
     status                TEXT    NOT NULL,
     first_surfaced_at     INTEGER NOT NULL,
     last_evaluated_at     INTEGER NOT NULL,
     current_screens_json  TEXT    NOT NULL,
     peak_score            REAL,
     peak_score_at         INTEGER,
     notes                 TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS watchlist_fund_tags (
     ticker      TEXT    NOT NULL,
     fund_name   TEXT    NOT NULL,
     compatible  INTEGER NOT NULL,
     tagged_at   INTEGER NOT NULL,
     PRIMARY KEY (ticker, fund_name)
   )`,
  `CREATE TABLE IF NOT EXISTS status_transitions (
     id                INTEGER PRIMARY KEY,
     ticker            TEXT    NOT NULL,
     from_status       TEXT,
     to_status         TEXT    NOT NULL,
     reason            TEXT    NOT NULL,
     transitioned_at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_transitions_ticker ON status_transitions(ticker, transitioned_at DESC)`,
];

export function openWatchlistDb(path: string = WATCHLIST_DB): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  for (const stmt of DDL) db.prepare(stmt).run();
  return db;
}

export function insertScreenRun(
  db: Database.Database,
  run: Omit<ScreenRun, "id">,
): number {
  const stmt = db.prepare(
    "INSERT INTO screen_runs (screen_name, universe, ran_at, tickers_scored, tickers_passed, duration_ms, parameters_json) " +
      "VALUES (@screen_name, @universe, @ran_at, @tickers_scored, @tickers_passed, @duration_ms, @parameters_json)",
  );
  const res = stmt.run(run);
  return Number(res.lastInsertRowid);
}

export function insertScore(
  db: Database.Database,
  score: Omit<ScoreRow, "id"> & { metadata: ScoreMetadata },
): number {
  const stmt = db.prepare(
    "INSERT INTO scores (run_id, ticker, screen_name, score, passed, metadata_json, scored_at) " +
      "VALUES (@run_id, @ticker, @screen_name, @score, @passed, @metadata_json, @scored_at)",
  );
  const res = stmt.run({
    run_id: score.run_id,
    ticker: score.ticker,
    screen_name: score.screen_name,
    score: score.score,
    passed: score.passed ? 1 : 0,
    metadata_json: JSON.stringify(score.metadata),
    scored_at: score.scored_at,
  });
  return Number(res.lastInsertRowid);
}

export function getWatchlistEntry(
  db: Database.Database,
  ticker: string,
): WatchlistEntry | null {
  const row = db
    .prepare("SELECT * FROM watchlist WHERE ticker = ?")
    .get(ticker) as
    | {
        ticker: string;
        status: string;
        first_surfaced_at: number;
        last_evaluated_at: number;
        current_screens_json: string;
        peak_score: number | null;
        peak_score_at: number | null;
        notes: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    ticker: row.ticker,
    status: watchlistStatusSchema.parse(row.status),
    first_surfaced_at: row.first_surfaced_at,
    last_evaluated_at: row.last_evaluated_at,
    current_screens: JSON.parse(row.current_screens_json).map((s: string) =>
      screenNameSchema.parse(s),
    ),
    peak_score: row.peak_score,
    peak_score_at: row.peak_score_at,
    notes: row.notes,
  };
}

export interface WatchlistQuery {
  status?: WatchlistStatus[];
  screen?: ScreenName;
  fund?: string;
  ticker?: string;
  limit?: number;
}

export function queryWatchlist(
  db: Database.Database,
  q: WatchlistQuery,
): WatchlistEntry[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.status && q.status.length > 0) {
    where.push(`w.status IN (${q.status.map((_, i) => `@status_${i}`).join(",")})`);
    q.status.forEach((s, i) => (params[`status_${i}`] = s));
  }
  if (q.screen) {
    where.push("w.current_screens_json LIKE @screen_pat");
    params.screen_pat = `%"${q.screen}"%`;
  }
  if (q.ticker) {
    where.push("w.ticker = @ticker");
    params.ticker = q.ticker;
  }
  if (q.fund) {
    where.push(
      "w.ticker IN (SELECT ticker FROM watchlist_fund_tags WHERE fund_name = @fund AND compatible = 1)",
    );
    params.fund = q.fund;
  }
  const sql =
    "SELECT * FROM watchlist w" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY w.last_evaluated_at DESC" +
    (q.limit ? ` LIMIT ${Math.min(q.limit, 1000)}` : "");
  const rows = db.prepare(sql).all(params) as Array<{
    ticker: string;
    status: string;
    first_surfaced_at: number;
    last_evaluated_at: number;
    current_screens_json: string;
    peak_score: number | null;
    peak_score_at: number | null;
    notes: string | null;
  }>;
  return rows.map((row) => ({
    ticker: row.ticker,
    status: watchlistStatusSchema.parse(row.status),
    first_surfaced_at: row.first_surfaced_at,
    last_evaluated_at: row.last_evaluated_at,
    current_screens: JSON.parse(row.current_screens_json).map((s: string) =>
      screenNameSchema.parse(s),
    ),
    peak_score: row.peak_score,
    peak_score_at: row.peak_score_at,
    notes: row.notes,
  }));
}

// ─── State transition logic ───────────────────────────────────────────────────

const PEAK_WINDOW_MS = 60 * 24 * 3600 * 1000;
const STALE_MS = 90 * 24 * 3600 * 1000;
const REJECT_MAX_DAYS_WITHOUT_PASS = 30;
const REJECT_CONSECUTIVE_FAILS = 3;
const FADING_DROP_THRESHOLD = 0.2;
const REENTRY_WITHIN_OF_PEAK = 0.1;

interface ScoreRecord {
  ticker: string;
  score: number;
  passed: boolean;
  scored_at: number;
  screen_name: ScreenName;
}

export function applyTransitionsForRun(
  db: Database.Database,
  runId: number,
  now: number,
): void {
  const scores = db
    .prepare(
      "SELECT ticker, score, passed, scored_at, screen_name FROM scores WHERE run_id = ?",
    )
    .all(runId) as Array<{
    ticker: string;
    score: number;
    passed: number;
    scored_at: number;
    screen_name: string;
  }>;

  const tx = db.transaction(() => {
    const touched = new Set<string>();
    for (const s of scores) {
      touched.add(s.ticker);
      const rec: ScoreRecord = {
        ticker: s.ticker,
        score: s.score,
        passed: s.passed === 1,
        scored_at: s.scored_at,
        screen_name: screenNameSchema.parse(s.screen_name),
      };
      upsertFromScore(db, rec);
    }
    // Stale sweep: runs LAST, only for tickers not touched in this run
    const stale = db
      .prepare(
        "SELECT ticker FROM watchlist WHERE status != 'stale' AND status != 'rejected' AND last_evaluated_at < ?",
      )
      .all(now - STALE_MS) as Array<{ ticker: string }>;
    for (const r of stale) {
      if (touched.has(r.ticker)) continue;
      transitionTo(db, r.ticker, "stale", "auto:no_update_90d", now);
    }
  });
  tx();
}

function upsertFromScore(
  db: Database.Database,
  rec: ScoreRecord,
): void {
  const existing = getWatchlistEntry(db, rec.ticker);

  if (!existing) {
    if (!rec.passed) return;
    db.prepare(
      "INSERT INTO watchlist (ticker, status, first_surfaced_at, last_evaluated_at, current_screens_json, peak_score, peak_score_at, notes) " +
        "VALUES (?, 'candidate', ?, ?, ?, ?, ?, NULL)",
    ).run(
      rec.ticker,
      rec.scored_at,
      rec.scored_at,
      JSON.stringify([rec.screen_name]),
      rec.score,
      rec.scored_at,
    );
    insertStatusTransition(db, {
      ticker: rec.ticker,
      from_status: null,
      to_status: "candidate",
      reason: `passed_screen_${rec.screen_name}`,
      transitioned_at: rec.scored_at,
    });
    return;
  }

  // Update peak score within the window
  const peakActive =
    existing.peak_score != null &&
    existing.peak_score_at != null &&
    rec.scored_at - existing.peak_score_at <= PEAK_WINDOW_MS;
  let newPeak = existing.peak_score;
  let newPeakAt = existing.peak_score_at;
  if (!peakActive || rec.score > (existing.peak_score ?? -Infinity)) {
    newPeak = rec.score;
    newPeakAt = rec.scored_at;
  }

  const currentScreens = new Set(existing.current_screens);
  if (rec.passed) currentScreens.add(rec.screen_name);
  else currentScreens.delete(rec.screen_name);

  db.prepare(
    "UPDATE watchlist SET last_evaluated_at = ?, current_screens_json = ?, peak_score = ?, peak_score_at = ? WHERE ticker = ?",
  ).run(
    rec.scored_at,
    JSON.stringify([...currentScreens]),
    newPeak,
    newPeakAt,
    rec.ticker,
  );

  const next = nextStatus(existing.status, rec, newPeak, newPeakAt, db);
  if (next.status !== existing.status) {
    transitionTo(db, rec.ticker, next.status, next.reason, rec.scored_at);
  }
}

function nextStatus(
  current: WatchlistStatus,
  rec: ScoreRecord,
  peak: number | null,
  peakAt: number | null,
  db: Database.Database,
): { status: WatchlistStatus; reason: string } {
  if (current === "candidate" && rec.passed) {
    const count = countConsecutivePasses(db, rec.ticker, rec.screen_name);
    if (count >= 2) return { status: "watching", reason: "two_consecutive_passes" };
  }
  if (current === "watching" && peak != null && peakAt != null) {
    const withinWindow = rec.scored_at - peakAt <= PEAK_WINDOW_MS;
    if (withinWindow && (peak - rec.score) / peak >= FADING_DROP_THRESHOLD) {
      return { status: "fading", reason: "score_drop_20pct_from_peak" };
    }
  }
  if (current === "fading") {
    if (
      rec.passed &&
      peak != null &&
      (peak - rec.score) / peak <= REENTRY_WITHIN_OF_PEAK
    ) {
      return { status: "watching", reason: "reentry_within_10pct_of_peak" };
    }
    const fails = countConsecutiveFails(db, rec.ticker, rec.screen_name);
    if (fails >= REJECT_CONSECUTIVE_FAILS) {
      return {
        status: "rejected",
        reason: `${REJECT_CONSECUTIVE_FAILS}_consecutive_fails`,
      };
    }
    const lastPass = lastPassAt(db, rec.ticker, rec.screen_name);
    if (
      lastPass != null &&
      rec.scored_at - lastPass >= REJECT_MAX_DAYS_WITHOUT_PASS * 24 * 3600 * 1000
    ) {
      return { status: "rejected", reason: "30_days_without_pass" };
    }
  }
  return { status: current, reason: "" };
}

function countConsecutivePasses(
  db: Database.Database,
  ticker: string,
  screen: ScreenName,
): number {
  const rows = db
    .prepare(
      "SELECT passed FROM scores WHERE ticker = ? AND screen_name = ? ORDER BY scored_at DESC",
    )
    .all(ticker, screen) as Array<{ passed: number }>;
  let n = 0;
  for (const r of rows) {
    if (r.passed === 1) n++;
    else break;
  }
  return n;
}

function countConsecutiveFails(
  db: Database.Database,
  ticker: string,
  screen: ScreenName,
): number {
  const rows = db
    .prepare(
      "SELECT passed FROM scores WHERE ticker = ? AND screen_name = ? ORDER BY scored_at DESC",
    )
    .all(ticker, screen) as Array<{ passed: number }>;
  let n = 0;
  for (const r of rows) {
    if (r.passed === 0) n++;
    else break;
  }
  return n;
}

function lastPassAt(
  db: Database.Database,
  ticker: string,
  screen: ScreenName,
): number | null {
  const row = db
    .prepare(
      "SELECT scored_at FROM scores WHERE ticker = ? AND screen_name = ? AND passed = 1 ORDER BY scored_at DESC LIMIT 1",
    )
    .get(ticker, screen) as { scored_at: number } | undefined;
  return row?.scored_at ?? null;
}

function transitionTo(
  db: Database.Database,
  ticker: string,
  to: WatchlistStatus,
  reason: string,
  at: number,
): void {
  const existing = getWatchlistEntry(db, ticker);
  const from = existing?.status ?? null;
  db.prepare(
    "UPDATE watchlist SET status = ?, last_evaluated_at = ? WHERE ticker = ?",
  ).run(to, at, ticker);
  insertStatusTransition(db, {
    ticker,
    from_status: from,
    to_status: to,
    reason,
    transitioned_at: at,
  });
}

export function insertStatusTransition(
  db: Database.Database,
  t: Omit<StatusTransition, "id">,
): number {
  const res = db
    .prepare(
      "INSERT INTO status_transitions (ticker, from_status, to_status, reason, transitioned_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(t.ticker, t.from_status, t.to_status, t.reason, t.transitioned_at);
  return Number(res.lastInsertRowid);
}

export function tagManually(
  db: Database.Database,
  ticker: string,
  status: WatchlistStatus,
  reason: string,
  at: number,
): void {
  const tx = db.transaction(() => {
    const existing = getWatchlistEntry(db, ticker);
    if (!existing) {
      db.prepare(
        "INSERT INTO watchlist (ticker, status, first_surfaced_at, last_evaluated_at, current_screens_json, peak_score, peak_score_at, notes) " +
          "VALUES (?, ?, ?, ?, '[]', NULL, NULL, NULL)",
      ).run(ticker, status, at, at);
      insertStatusTransition(db, {
        ticker,
        from_status: null,
        to_status: status,
        reason,
        transitioned_at: at,
      });
      return;
    }
    transitionTo(db, ticker, status, reason, at);
  });
  tx();
}

export interface Trajectory {
  ticker: string;
  entry: WatchlistEntry | null;
  scores: Array<{
    scored_at: number;
    score: number;
    passed: boolean;
    screen_name: ScreenName;
  }>;
  transitions: StatusTransition[];
}

export function getTrajectory(
  db: Database.Database,
  ticker: string,
): Trajectory {
  const scoreRows = db
    .prepare(
      "SELECT scored_at, score, passed, screen_name FROM scores WHERE ticker = ? ORDER BY scored_at ASC",
    )
    .all(ticker) as Array<{
    scored_at: number;
    score: number;
    passed: number;
    screen_name: string;
  }>;
  const transitionRows = db
    .prepare(
      "SELECT * FROM status_transitions WHERE ticker = ? ORDER BY transitioned_at ASC",
    )
    .all(ticker) as Array<{
    id: number;
    ticker: string;
    from_status: string | null;
    to_status: string;
    reason: string;
    transitioned_at: number;
  }>;
  return {
    ticker,
    entry: getWatchlistEntry(db, ticker),
    scores: scoreRows.map((r) => ({
      scored_at: r.scored_at,
      score: r.score,
      passed: r.passed === 1,
      screen_name: screenNameSchema.parse(r.screen_name),
    })),
    transitions: transitionRows.map((r) =>
      statusTransitionSchema.parse({
        id: r.id,
        ticker: r.ticker,
        from_status: r.from_status,
        to_status: r.to_status,
        reason: r.reason,
        transitioned_at: r.transitioned_at,
      }),
    ),
  };
}

export interface TagFundCompatibilityDeps {
  getSector?: (ticker: string) => Promise<string | null>;
}

export async function tagFundCompatibilityForTickers(
  db: Database.Database,
  resolutions: Map<string, UniverseResolution>,
  tickers: string[],
  now: number,
  deps: TagFundCompatibilityDeps = {},
): Promise<void> {
  if (resolutions.size === 0 || tickers.length === 0) return;

  // Pre-fetch sectors if any fund excludes any sector and getSector is provided
  const needsSectors = [...resolutions.values()].some((r) => r.exclude_sectors_config.length > 0);
  const sectorCache = new Map<string, string | null>();
  if (needsSectors && deps.getSector) {
    for (const t of tickers) {
      sectorCache.set(t, await deps.getSector(t));
    }
  }

  const stmt = db.prepare(
    `INSERT INTO watchlist_fund_tags (ticker, fund_name, compatible, tagged_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ticker, fund_name) DO UPDATE SET
       compatible = excluded.compatible,
       tagged_at = excluded.tagged_at`,
  );

  const tx = db.transaction(() => {
    for (const [fundName, resolution] of resolutions) {
      for (const t of tickers) {
        const status = isInUniverse(resolution, t);
        let compatible = status.in_universe ? 1 : 0;
        // If in_universe and there's a sector exclusion config, check sector
        if (compatible === 1 && resolution.exclude_sectors_config.length > 0 && deps.getSector) {
          const sector = sectorCache.get(t);
          if (sector && resolution.exclude_sectors_config.includes(sector)) {
            compatible = 0;
          }
        }
        stmt.run(t, fundName, compatible, now);
      }
    }
  });
  tx();
}
