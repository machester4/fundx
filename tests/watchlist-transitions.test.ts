import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  tagFundCompatibilityForTickers,
} from "../src/services/watchlist.service.js";
import type { UniverseResolution } from "../src/types.js";

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

describe("tagFundCompatibilityForTickers", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openWatchlistDb(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  function makeResolution(overrides: Partial<UniverseResolution> = {}): UniverseResolution {
    return {
      resolved_at: 1,
      config_hash: "h",
      resolved_from: "fmp",
      source: { kind: "preset", preset: "sp500" },
      base_tickers: ["AAPL", "MSFT"],
      final_tickers: ["AAPL", "MSFT", "TSM"],
      include_applied: ["TSM"],
      exclude_tickers_applied: [],
      exclude_sectors_applied: [],
      exclude_tickers_config: ["TSLA"],
      exclude_sectors_config: [],
      count: 3,
      ...overrides,
    };
  }

  it("tags tickers in base universe as compatible=1", async () => {
    const resolutions = new Map([["fund-a", makeResolution()]]);
    await tagFundCompatibilityForTickers(db, resolutions, ["AAPL", "MSFT"], 1000);
    const rows = db.prepare(
      "SELECT ticker, compatible FROM watchlist_fund_tags WHERE fund_name='fund-a' ORDER BY ticker"
    ).all() as Array<{ ticker: string; compatible: number }>;
    expect(rows).toEqual([
      { ticker: "AAPL", compatible: 1 },
      { ticker: "MSFT", compatible: 1 },
    ]);
  });

  it("tags include_tickers overrides as compatible=1", async () => {
    const resolutions = new Map([["fund-a", makeResolution()]]);
    await tagFundCompatibilityForTickers(db, resolutions, ["TSM"], 1000);
    const row = db.prepare(
      "SELECT compatible FROM watchlist_fund_tags WHERE ticker='TSM' AND fund_name='fund-a'"
    ).get() as { compatible: number };
    expect(row.compatible).toBe(1);
  });

  it("tags excluded tickers as compatible=0", async () => {
    const resolutions = new Map([["fund-a", makeResolution()]]);
    await tagFundCompatibilityForTickers(db, resolutions, ["TSLA"], 1000);
    const row = db.prepare(
      "SELECT compatible FROM watchlist_fund_tags WHERE ticker='TSLA' AND fund_name='fund-a'"
    ).get() as { compatible: number };
    expect(row.compatible).toBe(0);
  });

  it("tags out-of-universe tickers as compatible=0", async () => {
    const resolutions = new Map([["fund-a", makeResolution()]]);
    await tagFundCompatibilityForTickers(db, resolutions, ["ZZZZ"], 1000);
    const row = db.prepare(
      "SELECT compatible FROM watchlist_fund_tags WHERE ticker='ZZZZ' AND fund_name='fund-a'"
    ).get() as { compatible: number };
    expect(row.compatible).toBe(0);
  });

  it("tags across multiple funds", async () => {
    const resolutions = new Map([
      ["fund-a", makeResolution({ final_tickers: ["AAPL"], base_tickers: ["AAPL"], include_applied: [], exclude_tickers_config: [] })],
      ["fund-b", makeResolution({ final_tickers: ["MSFT"], base_tickers: ["MSFT"], include_applied: [], exclude_tickers_config: [] })],
    ]);
    await tagFundCompatibilityForTickers(db, resolutions, ["AAPL", "MSFT"], 1000);
    const rows = db.prepare(
      "SELECT ticker, fund_name, compatible FROM watchlist_fund_tags ORDER BY fund_name, ticker"
    ).all() as Array<{ ticker: string; fund_name: string; compatible: number }>;
    expect(rows).toEqual([
      { ticker: "AAPL", fund_name: "fund-a", compatible: 1 },
      { ticker: "MSFT", fund_name: "fund-a", compatible: 0 },
      { ticker: "AAPL", fund_name: "fund-b", compatible: 0 },
      { ticker: "MSFT", fund_name: "fund-b", compatible: 1 },
    ]);
  });

  it("upserts on conflict (re-running updates compatibility)", async () => {
    const resolutions1 = new Map([["fund-a", makeResolution({ final_tickers: [], base_tickers: [], include_applied: [] })]]);
    await tagFundCompatibilityForTickers(db, resolutions1, ["AAPL"], 1000);
    const resolutions2 = new Map([["fund-a", makeResolution({ final_tickers: ["AAPL"], base_tickers: ["AAPL"], include_applied: [] })]]);
    await tagFundCompatibilityForTickers(db, resolutions2, ["AAPL"], 2000);
    const row = db.prepare(
      "SELECT compatible, tagged_at FROM watchlist_fund_tags WHERE ticker='AAPL'"
    ).get() as { compatible: number; tagged_at: number };
    expect(row.compatible).toBe(1);
    expect(row.tagged_at).toBe(2000);
  });

  it("no-op when resolutions map is empty", async () => {
    await tagFundCompatibilityForTickers(db, new Map(), ["AAPL"], 1000);
    const rows = db.prepare("SELECT * FROM watchlist_fund_tags").all();
    expect(rows).toHaveLength(0);
  });

  it("marks sector-excluded ticker as compatible=0 when getSector is provided", async () => {
    const resolutions = new Map([
      ["fund-a", makeResolution({
        base_tickers: ["XOM", "AAPL"],
        final_tickers: ["XOM", "AAPL"],
        exclude_sectors_config: ["Energy"],
      })],
    ]);
    const getSector = async (t: string) => t === "XOM" ? "Energy" : "Technology";
    await tagFundCompatibilityForTickers(
      db, resolutions, ["XOM", "AAPL"], 1000, { getSector },
    );
    const rows = db.prepare(
      "SELECT ticker, compatible FROM watchlist_fund_tags WHERE fund_name='fund-a' ORDER BY ticker"
    ).all() as Array<{ ticker: string; compatible: number }>;
    expect(rows).toEqual([
      { ticker: "AAPL", compatible: 1 },
      { ticker: "XOM", compatible: 0 },
    ]);
  });

  it("falls back to advisory behavior (no sector check) when getSector is not provided", async () => {
    const resolutions = new Map([
      ["fund-a", makeResolution({
        base_tickers: ["XOM"],
        final_tickers: ["XOM"],
        exclude_sectors_config: ["Energy"],
      })],
    ]);
    await tagFundCompatibilityForTickers(db, resolutions, ["XOM"], 1000);
    const row = db.prepare(
      "SELECT compatible FROM watchlist_fund_tags WHERE ticker='XOM'"
    ).get() as { compatible: number };
    expect(row.compatible).toBe(1); // advisory — XOM is in base, sector check skipped
  });
});
