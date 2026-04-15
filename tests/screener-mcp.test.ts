import { describe, it, expect, beforeEach } from "vitest";
import {
  handleWatchlistQuery,
  handleWatchlistTrajectory,
  handleWatchlistTag,
  handleScreenRun,
} from "../src/mcp/screener.js";
import { openWatchlistDb } from "../src/services/watchlist.service.js";
import { openPriceCache } from "../src/services/price-cache.service.js";
import type { FundConfig, UniverseResolution } from "../src/types.js";

const fakeConfig: FundConfig = {
  fund: {
    name: "testfund",
    display_name: "Test Fund",
    description: "",
    created: "2024-01-01",
    status: "active",
  },
  capital: { initial: 10000, currency: "USD" },
  objective: { type: "growth", target_multiple: 2, horizon_years: 5 },
  risk: { profile: "moderate", max_drawdown_pct: 15 },
  universe: { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] },
  schedule: {
    timezone: "UTC",
    trading_days: ["mon", "tue", "wed", "thu", "fri"],
    sessions: [],
  },
  broker: { mode: "paper" },
  notifications: {},
  claude: {},
};

const fakeResolution: UniverseResolution = {
  resolved_at: 1,
  config_hash: "h",
  resolved_from: "fmp",
  source: { kind: "preset", preset: "sp500" },
  base_tickers: ["AAPL", "MSFT"],
  final_tickers: ["AAPL", "MSFT"],
  include_applied: [],
  exclude_tickers_applied: [],
  exclude_sectors_applied: [],
  exclude_tickers_config: [],
  exclude_sectors_config: [],
  count: 2,
};

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

  it("handleScreenRun uses default screen and resolves fund universe", async () => {
    const pcdb = openPriceCache(":memory:");
    const emptyResolution: UniverseResolution = {
      ...fakeResolution,
      base_tickers: [],
      final_tickers: [],
      count: 0,
    };
    const res = await handleScreenRun(
      wdb,
      pcdb,
      { screen: "momentum-12-1", fund: "testfund" },
      {
        fetchBars: async () => [],
        resolveFundUniverse: async () => emptyResolution,
        loadFundConfigs: async () => [fakeConfig],
        now: () => 1_700_000_000_000,
      },
    );
    expect(res.summary.screen_name).toBe("momentum-12-1");
    expect(res.summary.universe).toBe("sp500 (fmp)");
    expect(res.summary.tickers_scored).toBe(0);
    expect(res.summary.tickers_passed).toBe(0);
    expect(res.summary.run_id).toBeGreaterThan(0);
  });

  it("handleScreenRun defaults to first active fund when fund arg is omitted", async () => {
    const pcdb = openPriceCache(":memory:");
    const res = await handleScreenRun(
      wdb,
      pcdb,
      {},
      {
        fetchBars: async () => [],
        resolveFundUniverse: async () => fakeResolution,
        loadFundConfigs: async () => [fakeConfig],
        now: () => 1_700_000_000_000,
      },
    );
    expect(res.summary.screen_name).toBe("momentum-12-1");
    expect(res.summary.universe).toBe("sp500 (fmp)");
  });

  it("handleScreenRun throws when no active funds are configured", async () => {
    const pcdb = openPriceCache(":memory:");
    const inactiveFund: FundConfig = {
      ...fakeConfig,
      fund: { ...fakeConfig.fund, status: "paused" },
    };
    await expect(
      handleScreenRun(
        wdb,
        pcdb,
        {},
        {
          fetchBars: async () => [],
          resolveFundUniverse: async () => fakeResolution,
          loadFundConfigs: async () => [inactiveFund],
          now: () => 1_700_000_000_000,
        },
      ),
    ).rejects.toThrow("no active funds configured");
  });

  it("handleScreenRun throws when requested fund is not found", async () => {
    const pcdb = openPriceCache(":memory:");
    await expect(
      handleScreenRun(
        wdb,
        pcdb,
        { fund: "nonexistent" },
        {
          fetchBars: async () => [],
          resolveFundUniverse: async () => fakeResolution,
          loadFundConfigs: async () => [fakeConfig],
          now: () => 1_700_000_000_000,
        },
      ),
    ).rejects.toThrow("fund not found or not active: nonexistent");
  });
});
