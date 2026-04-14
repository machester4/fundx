import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  openWatchlistDb,
  insertScreenRun,
  insertScore,
  getWatchlistEntry,
  queryWatchlist,
} from "../src/services/watchlist.service.js";

describe("watchlist.service — CRUD", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openWatchlistDb(":memory:");
  });

  it("opens with expected tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "screen_runs",
        "scores",
        "watchlist",
        "watchlist_fund_tags",
        "status_transitions",
      ]),
    );
  });

  it("inserts screen run and scores", () => {
    const runId = insertScreenRun(db, {
      screen_name: "momentum-12-1",
      universe: "sp500",
      ran_at: 1_700_000_000_000,
      tickers_scored: 100,
      tickers_passed: 10,
      duration_ms: 1234,
      parameters_json: "{}",
    });
    expect(runId).toBeGreaterThan(0);

    insertScore(db, {
      run_id: runId,
      ticker: "AAPL",
      screen_name: "momentum-12-1",
      score: 0.42,
      passed: true,
      metadata: {
        return_12_1: 0.42,
        adv_usd_30d: 20_000_000,
        last_price: 180,
        missing_days: 0,
      },
      scored_at: 1_700_000_000_000,
    });

    expect(getWatchlistEntry(db, "AAPL")).toBeNull();
  });

  it("returns empty list from queryWatchlist on empty db", () => {
    expect(queryWatchlist(db, {})).toEqual([]);
  });
});
