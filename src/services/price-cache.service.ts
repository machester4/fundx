import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DailyBar } from "../types.js";
import { PRICE_CACHE_DB } from "../paths.js";

const TTL_MS = 24 * 60 * 60 * 1000;

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS price_cache (
     ticker TEXT NOT NULL,
     date   TEXT NOT NULL,
     close  REAL NOT NULL,
     volume REAL NOT NULL,
     PRIMARY KEY (ticker, date)
   )`,
  `CREATE TABLE IF NOT EXISTS price_cache_meta (
     ticker      TEXT PRIMARY KEY,
     written_at  INTEGER NOT NULL
   )`,
];

export function openPriceCache(path: string = PRICE_CACHE_DB): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  for (const stmt of DDL) db.prepare(stmt).run();
  return db;
}

export function writeBars(
  db: Database.Database,
  ticker: string,
  bars: DailyBar[],
  now: number,
): void {
  const del = db.prepare("DELETE FROM price_cache WHERE ticker = ?");
  const ins = db.prepare(
    "INSERT INTO price_cache (ticker, date, close, volume) VALUES (?, ?, ?, ?)",
  );
  const meta = db.prepare(
    "INSERT INTO price_cache_meta (ticker, written_at) VALUES (?, ?) " +
      "ON CONFLICT(ticker) DO UPDATE SET written_at = excluded.written_at",
  );
  const tx = db.transaction((t: string, b: DailyBar[], ts: number) => {
    del.run(t);
    for (const bar of b) ins.run(t, bar.date, bar.close, bar.volume);
    meta.run(t, ts);
  });
  tx(ticker, bars, now);
}

export function readBars(db: Database.Database, ticker: string): DailyBar[] {
  const rows = db
    .prepare(
      "SELECT date, close, volume FROM price_cache WHERE ticker = ? ORDER BY date ASC",
    )
    .all(ticker) as DailyBar[];
  return rows;
}

export function isFresh(
  db: Database.Database,
  ticker: string,
  now: number,
): boolean {
  const row = db
    .prepare("SELECT written_at FROM price_cache_meta WHERE ticker = ?")
    .get(ticker) as { written_at: number } | undefined;
  if (!row) return false;
  return now - row.written_at <= TTL_MS;
}
