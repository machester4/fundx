import { describe, it, expect, beforeEach } from "vitest";
import {
  handleWatchlistQuery,
  handleWatchlistTrajectory,
  handleWatchlistTag,
  handleScreenRun,
} from "../src/mcp/screener.js";
import { openWatchlistDb } from "../src/services/watchlist.service.js";
import { openPriceCache } from "../src/services/price-cache.service.js";

describe("screener MCP handlers", () => {
  let wdb: ReturnType<typeof openWatchlistDb>;

  beforeEach(() => {
    wdb = openWatchlistDb(":memory:");
  });

  it("watchlist_query returns empty on new db", async () => {
    const res = await handleWatchlistQuery(wdb, { limit: 10 });
    expect(res.entries).toEqual([]);
  });

  it("watchlist_tag then watchlist_query surfaces the tagged ticker", async () => {
    await handleWatchlistTag(wdb, {
      ticker: "AAPL",
      status: "watching",
      reason: "manual test",
    });
    const res = await handleWatchlistQuery(wdb, { status: ["watching"] });
    expect(res.entries.map((e) => e.ticker)).toContain("AAPL");
  });

  it("watchlist_trajectory returns empty scores/transitions for unknown ticker", async () => {
    const res = await handleWatchlistTrajectory(wdb, { ticker: "UNKNOWN" });
    expect(res.scores).toEqual([]);
    expect(res.transitions).toEqual([]);
  });

  it("handleScreenRun uses default screen and universe label when args are empty", async () => {
    const pcdb = openPriceCache(":memory:");
    const res = await handleScreenRun(wdb, pcdb, {}, {
      fetchBars: async () => [],
      universeTickers: async () => [],
      loadFundConfigs: async () => [],
      now: () => 1_700_000_000_000,
    });
    expect(res.summary.screen_name).toBe("momentum-12-1");
    expect(res.summary.universe).toBe("sp500");
    expect(res.summary.tickers_scored).toBe(0);
    expect(res.summary.tickers_passed).toBe(0);
    expect(res.summary.run_id).toBeGreaterThan(0);
  });
});
