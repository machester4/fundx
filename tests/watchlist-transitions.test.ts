import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  openWatchlistDb,
  insertScreenRun,
  insertScore,
  getWatchlistEntry,
  queryWatchlist,
  applyTransitionsForRun,
  getTrajectory,
  tagManually,
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

  it("enforces scores.run_id foreign key", () => {
    expect(() =>
      insertScore(db, {
        run_id: 9999, // no such screen run
        ticker: "AAPL",
        screen_name: "momentum-12-1",
        score: 0.1,
        passed: true,
        metadata: {
          return_12_1: 0.1,
          adv_usd_30d: 20_000_000,
          last_price: 100,
          missing_days: 0,
        },
        scored_at: 1_700_000_000_000,
      }),
    ).toThrow();
  });
});

describe("watchlist.service — transitions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openWatchlistDb(":memory:");
  });

  function run(ranAt: number, scores: Array<{ t: string; s: number; pass: boolean }>) {
    const runId = insertScreenRun(db, {
      screen_name: "momentum-12-1",
      universe: "sp500",
      ran_at: ranAt,
      tickers_scored: scores.length,
      tickers_passed: scores.filter((x) => x.pass).length,
      duration_ms: 0,
      parameters_json: "{}",
    });
    for (const { t, s, pass } of scores) {
      insertScore(db, {
        run_id: runId,
        ticker: t,
        screen_name: "momentum-12-1",
        score: s,
        passed: pass,
        metadata: {
          return_12_1: s,
          adv_usd_30d: 20_000_000,
          last_price: 100,
          missing_days: 0,
        },
        scored_at: ranAt,
      });
    }
    applyTransitionsForRun(db, runId, ranAt);
    return runId;
  }

  const day = 24 * 3600 * 1000;
  const t0 = 1_700_000_000_000;

  it("ø → candidate on first pass", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("candidate");
  });

  it("candidate → watching on 2 consecutive passes", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 0.31, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("watching");
  });

  it("watching → fading when score drops ≥20% from peak (within 60d)", () => {
    run(t0, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + 2 * day, [{ t: "AAPL", s: 0.7, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("fading");
  });

  it("fading → rejected after 30 days without a pass", () => {
    run(t0, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 1.0, pass: true }]); // watching, peak=1.0
    run(t0 + 2 * day, [{ t: "AAPL", s: 0.7, pass: true }]); // fading
    // Jump 31 days forward, scoring a different ticker so AAPL isn't touched
    // and isn't yet 90d stale.
    run(t0 + 33 * day, [{ t: "MSFT", s: 0.5, pass: true }]);
    // AAPL last passed at t0 + 2d. 31d later, a failing AAPL score should reject.
    run(t0 + 33 * day + 1, [{ t: "AAPL", s: 0.3, pass: false }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("rejected");
  });

  it("fading → rejected after 3 consecutive failing runs", () => {
    run(t0, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + 2 * day, [{ t: "AAPL", s: 0.7, pass: true }]);
    run(t0 + 3 * day, [{ t: "AAPL", s: 0.4, pass: false }]);
    run(t0 + 4 * day, [{ t: "AAPL", s: 0.3, pass: false }]);
    run(t0 + 5 * day, [{ t: "AAPL", s: 0.2, pass: false }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("rejected");
  });

  it("fading → watching on re-entry (passes again within 10% of peak)", () => {
    run(t0, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + 2 * day, [{ t: "AAPL", s: 0.7, pass: true }]);
    run(t0 + 3 * day, [{ t: "AAPL", s: 0.95, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("watching");
  });

  it("* → stale after 90 days without score", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    run(t0 + 91 * day, [{ t: "MSFT", s: 0.5, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("stale");
  });

  it("manual tag records transition and updates status", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    tagManually(db, "AAPL", "rejected", "manual:test:not fit", t0 + day);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("rejected");
    const traj = getTrajectory(db, "AAPL");
    expect(traj.transitions.at(-1)?.reason).toBe("manual:test:not fit");
  });

  it("getTrajectory returns scores and transitions in ascending time order", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 0.4, pass: true }]);
    const traj = getTrajectory(db, "AAPL");
    expect(traj.scores).toHaveLength(2);
    expect(traj.scores[0].scored_at).toBeLessThan(traj.scores[1].scored_at);
    expect(traj.transitions.length).toBeGreaterThanOrEqual(1);
  });
});
