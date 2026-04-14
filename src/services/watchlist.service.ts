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
  watchlistStatusSchema,
  screenNameSchema,
} from "../types.js";
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
    params.screen_pat = `%${q.screen}%`;
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
