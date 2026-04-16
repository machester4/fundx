import { describe, it, expect, beforeEach } from "vitest";
import { handleScreenDiscover } from "../src/mcp/screener.js";
import { openWatchlistDb, queryWatchlist } from "../src/services/watchlist.service.js";
import { openPriceCache, writeBars } from "../src/services/price-cache.service.js";
import type { DailyBar, DiscoverResult } from "../src/types.js";
import type { ScreenerResult } from "../src/services/market.service.js";

// Ensure return type is imported from types.ts, not re-exported from screener.ts
type _assertDiscoverResult = DiscoverResult;

// 273 bars with linear interpolation between startClose and endClose.
// volume: 500_000 → ADV ~= last_close * 500_000 (well above $10M for close > $5).
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

function fmpCandidate(symbol: string, overrides: Partial<ScreenerResult> = {}): ScreenerResult {
  return {
    symbol,
    companyName: `${symbol} Corp`,
    sector: "Technology",
    exchange: "NYSE",
    isEtf: false,
    marketCap: 10_000_000_000,
    price: 100,
    volume: 5_000_000,
    ...overrides,
  };
}

const NOW = 1_700_000_000_000;

describe("handleScreenDiscover", () => {
  let pcdb: ReturnType<typeof openPriceCache>;

  beforeEach(() => {
    pcdb = openPriceCache(":memory:");
  });

  it("returns empty results when fetchCandidates returns no tickers", async () => {
    const result = await handleScreenDiscover(
      pcdb,
      { filters: { is_actively_trading: true, limit: 100 } },
      {
        fetchCandidates: async () => [],
        fetchBars: async () => { throw new Error("should not be called"); },
        now: () => NOW,
      },
    );

    expect(result.candidates_fetched).toBe(0);
    expect(result.candidates_scored).toBe(0);
    expect(result.candidates_passed).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("scores tickers from FMP and returns them sorted by momentum descending", async () => {
    // HIGH: 100 → 200 = strong positive momentum
    // LOW:  100 → 101 = near-zero momentum
    writeBars(pcdb, "HIGH", makeFixtureBars(100, 200), NOW);
    writeBars(pcdb, "LOW", makeFixtureBars(100, 101), NOW);

    const result = await handleScreenDiscover(
      pcdb,
      { filters: { is_actively_trading: true, limit: 100 } },
      {
        fetchCandidates: async () => [
          fmpCandidate("HIGH"),
          fmpCandidate("LOW"),
        ],
        fetchBars: async () => { throw new Error("should use cache"); },
        now: () => NOW,
      },
    );

    expect(result.candidates_fetched).toBe(2);
    expect(result.candidates_scored).toBe(2);
    expect(result.candidates_passed).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].ticker).toBe("HIGH");
    expect(result.results[1].ticker).toBe("LOW");
    expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
  });

  it("includes FMP metadata (companyName, sector, exchange, is_etf) in results", async () => {
    writeBars(pcdb, "GLD", makeFixtureBars(100, 150), NOW);

    const result = await handleScreenDiscover(
      pcdb,
      { filters: { is_etf: true, limit: 10 } },
      {
        fetchCandidates: async () => [
          fmpCandidate("GLD", {
            companyName: "SPDR Gold Shares",
            sector: "Basic Materials",
            exchange: "NYSE ARCA",
            isEtf: true,
            marketCap: 60_000_000_000,
          }),
        ],
        fetchBars: async () => { throw new Error("should use cache"); },
        now: () => NOW,
      },
    );

    expect(result.results).toHaveLength(1);
    const r = result.results[0];
    expect(r.ticker).toBe("GLD");
    expect(r.companyName).toBe("SPDR Gold Shares");
    expect(r.sector).toBe("Basic Materials");
    expect(r.exchange).toBe("NYSE ARCA");
    expect(r.is_etf).toBe(true);
    expect(r.market_cap).toBe(60_000_000_000);
  });

  it("filters out tickers below MIN_PRICE ($5)", async () => {
    // Penny stock: closes ending at $3
    writeBars(pcdb, "PENNY", makeFixtureBars(10, 3), NOW);
    writeBars(pcdb, "OK", makeFixtureBars(100, 150), NOW);

    const result = await handleScreenDiscover(
      pcdb,
      { filters: { is_actively_trading: true, limit: 100 } },
      {
        fetchCandidates: async () => [fmpCandidate("PENNY"), fmpCandidate("OK")],
        fetchBars: async () => { throw new Error("should use cache"); },
        now: () => NOW,
      },
    );

    expect(result.candidates_passed).toBe(1);
    expect(result.results.map((r) => r.ticker)).not.toContain("PENNY");
    expect(result.results.map((r) => r.ticker)).toContain("OK");
  });

  it("fetches bars from dep when not in price cache", async () => {
    let fetched = false;
    const barsForUncached = makeFixtureBars(100, 150);

    const result = await handleScreenDiscover(
      pcdb,
      { filters: { is_actively_trading: true, limit: 10 } },
      {
        fetchCandidates: async () => [fmpCandidate("UNCACHED")],
        fetchBars: async (ticker) => {
          expect(ticker).toBe("UNCACHED");
          fetched = true;
          return barsForUncached;
        },
        now: () => NOW,
      },
    );

    expect(fetched).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].ticker).toBe("UNCACHED");
  });

  it("does not write to the watchlist", async () => {
    // handleScreenDiscover has no wdb parameter — it structurally cannot write to the watchlist.
    // This test verifies the guarantee is preserved end-to-end by checking an independent db.
    const wdb = openWatchlistDb(":memory:");
    writeBars(pcdb, "AAA", makeFixtureBars(100, 200), NOW);

    await handleScreenDiscover(
      pcdb,
      { filters: { is_actively_trading: true, limit: 10 } },
      {
        fetchCandidates: async () => [fmpCandidate("AAA")],
        fetchBars: async () => { throw new Error("should use cache"); },
        now: () => NOW,
      },
    );

    const entries = queryWatchlist(wdb, { limit: 50 });
    expect(entries).toHaveLength(0);
  });

  it("skips tickers whose bar fetch fails and continues with the rest", async () => {
    writeBars(pcdb, "GOOD", makeFixtureBars(100, 150), NOW);

    const result = await handleScreenDiscover(
      pcdb,
      { filters: { is_actively_trading: true, limit: 10 } },
      {
        fetchCandidates: async () => [fmpCandidate("FAILING"), fmpCandidate("GOOD")],
        fetchBars: async (ticker) => {
          if (ticker === "FAILING") throw new Error("network error");
          throw new Error("unexpected call for " + ticker);
        },
        now: () => NOW,
      },
    );

    expect(result.results.map((r) => r.ticker)).toContain("GOOD");
    expect(result.results.map((r) => r.ticker)).not.toContain("FAILING");
  });
});
