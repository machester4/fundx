import { describe, it, expect } from "vitest";
import { scoreMomentum121, metadataFromScore, runScreen } from "../src/services/screening.service.js";
import type { DailyBar } from "../src/types.js";
import {
  openWatchlistDb,
  queryWatchlist,
} from "../src/services/watchlist.service.js";
import {
  openPriceCache,
  writeBars,
} from "../src/services/price-cache.service.js";

function bars(closes: number[]): DailyBar[] {
  return closes.map((c, i) => {
    const d = new Date(2025, 0, i + 1).toISOString().slice(0, 10);
    return { date: d, close: c, volume: 1_000_000 };
  });
}

describe("scoreMomentum121", () => {
  it("returns null when fewer than 273 bars", () => {
    expect(scoreMomentum121(bars(Array(100).fill(100)))).toBeNull();
  });

  it("skips the most recent 21 trading days (1 month) in the numerator", () => {
    const closes = [...Array(252).fill(100), ...Array(21).fill(50)];
    const s = scoreMomentum121(bars(closes));
    expect(s).not.toBeNull();
    expect(s!.return_12_1).toBeCloseTo(0, 6);
  });

  it("computes positive return when t-21 > t-252", () => {
    const closes = [
      ...Array(252)
        .fill(0)
        .map((_, i) => 100 + i * 0.1),
      ...Array(21).fill(200),
    ];
    const s = scoreMomentum121(bars(closes));
    expect(s!.return_12_1).toBeGreaterThan(0);
  });

  it("returns null with insufficient history", () => {
    expect(scoreMomentum121(bars(Array(200).fill(100)))).toBeNull();
  });

  it("computes 30-day ADV in USD from last 30 bars", () => {
    const closes = Array(273).fill(100);
    const barArr = bars(closes).map((b, i) => ({
      ...b,
      volume: i >= 243 ? 500_000 : 1_000_000,
    }));
    const s = scoreMomentum121(barArr);
    expect(s!.adv_usd_30d).toBeCloseTo(50_000_000, -3);
  });

  it("indexes numerator at t-21 and denominator at t-252 exactly", () => {
    // bars[i].close = i + 1, so bars[n-22].close = 252, bars[n-253].close = 21
    const closes = Array.from({ length: 273 }, (_, i) => i + 1);
    const s = scoreMomentum121(bars(closes));
    expect(s!.return_12_1).toBeCloseTo(252 / 21 - 1, 9);
  });
});

describe("metadataFromScore", () => {
  it("projects MomentumScore to ScoreMetadata exactly", () => {
    const closes = Array.from({ length: 273 }, (_, i) => i + 1);
    const s = scoreMomentum121(bars(closes));
    expect(s).not.toBeNull();
    expect(metadataFromScore(s!)).toEqual({
      return_12_1: s!.return_12_1,
      adv_usd_30d: s!.adv_usd_30d,
      last_price: s!.last_price,
      missing_days: s!.missing_days,
    });
  });
});

function makeFixtureBars(startClose: number, endClose: number): DailyBar[] {
  const arr: DailyBar[] = [];
  for (let i = 0; i < 273; i++) {
    const c = startClose + ((endClose - startClose) * i) / 272;
    arr.push({
      date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10),
      close: c,
      volume: 500_000,
    });
  }
  return arr;
}

describe("runScreen (integration)", () => {
  it("runs momentum-12-1 end-to-end against a 3-ticker universe", async () => {
    const wdb = openWatchlistDb(":memory:");
    const pcdb = openPriceCache(":memory:");
    writeBars(pcdb, "AAA", makeFixtureBars(100, 200), Date.now());
    writeBars(pcdb, "BBB", makeFixtureBars(100, 101), Date.now());
    writeBars(pcdb, "CCC", makeFixtureBars(100, 80), Date.now());

    const summary = await runScreen({
      watchlistDb: wdb,
      priceCacheDb: pcdb,
      universe: ["AAA", "BBB", "CCC"],
      universeLabel: "test",
      fetchBars: async () => {
        throw new Error("should not fetch — cache is primed");
      },
      fundConfigs: [],
      now: Date.now(),
    });

    expect(summary.tickers_scored).toBe(3);
    expect(summary.tickers_passed).toBeGreaterThan(0);

    // screen_runs row exists with correct universe label
    const runRow = wdb
      .prepare("SELECT * FROM screen_runs WHERE id = ?")
      .get(summary.run_id) as { universe: string; tickers_scored: number } | undefined;
    expect(runRow?.universe).toBe("test");
    expect(runRow?.tickers_scored).toBe(3);

    // scores rows — one per scored ticker (AAA, BBB, CCC)
    const scoreRows = wdb
      .prepare("SELECT ticker, passed FROM scores WHERE run_id = ? ORDER BY ticker")
      .all(summary.run_id) as Array<{ ticker: string; passed: number }>;
    expect(scoreRows.map((r) => r.ticker)).toEqual(["AAA", "BBB", "CCC"]);
    const aaaRow = scoreRows.find((r) => r.ticker === "AAA");
    expect(aaaRow?.passed).toBe(1);

    // watchlist contains AAA with candidate status
    const wl = queryWatchlist(wdb, { status: ["candidate", "watching"] });
    expect(wl.map((e) => e.ticker)).toContain("AAA");

    // status_transitions for AAA: ø → candidate
    const transitions = wdb
      .prepare("SELECT from_status, to_status FROM status_transitions WHERE ticker = ?")
      .all("AAA") as Array<{ from_status: string | null; to_status: string }>;
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    expect(transitions[0].from_status).toBeNull();
    expect(transitions[0].to_status).toBe("candidate");

    // no fund tags (empty fundConfigs)
    const tagRows = wdb.prepare("SELECT * FROM watchlist_fund_tags").all();
    expect(tagRows).toHaveLength(0);

    // top_ten sorted by score descending, AAA first
    expect(summary.top_ten[0]?.ticker).toBe("AAA");
  });

  it("swallows fetchBars errors and continues with remaining tickers", async () => {
    const wdb = openWatchlistDb(":memory:");
    const pcdb = openPriceCache(":memory:");
    // No cache primed — all tickers will go to fetchBars, which throws.
    const summary = await runScreen({
      watchlistDb: wdb,
      priceCacheDb: pcdb,
      universe: ["XXX", "YYY"],
      universeLabel: "test-errors",
      fetchBars: async () => {
        throw new Error("simulated FMP failure");
      },
      fundConfigs: [],
      now: Date.now(),
    });

    expect(summary.tickers_scored).toBe(0);
    expect(summary.tickers_passed).toBe(0);
    expect(summary.run_id).toBeGreaterThan(0); // screen_runs row still inserted
  });

  it("refuses to start a second run while another is in progress", async () => {
    // We fake an in-progress lock by touching the lockfile with a fresh mtime.
    // The fs path comes from the same directory as WATCHLIST_DB.
    const { WATCHLIST_DB } = await import("../src/paths.js");
    const { mkdirSync, writeFileSync, unlinkSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const lockPath = join(dirname(WATCHLIST_DB), "screening.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "");

    try {
      const wdb = openWatchlistDb(":memory:");
      const pcdb = openPriceCache(":memory:");
      await expect(
        runScreen({
          watchlistDb: wdb,
          priceCacheDb: pcdb,
          universe: ["XXX"],
          universeLabel: "test",
          fetchBars: async () => [],
          fundConfigs: [],
          now: Date.now(),
        }),
      ).rejects.toThrow(/already.*progress|in progress/i);
    } finally {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  });
});
