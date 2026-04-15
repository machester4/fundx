import { describe, it, expect } from "vitest";
import { handleCheckUniverse, handleListUniverse } from "../src/mcp/broker-local.js";
import type { UniverseResolution } from "../src/types.js";

function mockResolution(overrides: Partial<UniverseResolution> = {}): UniverseResolution {
  return {
    resolved_at: 1_000_000,
    config_hash: "h",
    resolved_from: "fmp",
    source: { kind: "preset", preset: "sp500" },
    base_tickers: ["AAPL", "MSFT", "GOOG"],
    final_tickers: ["AAPL", "MSFT", "GOOG", "TSM"],
    include_applied: ["TSM"],
    exclude_tickers_applied: [],
    exclude_sectors_applied: [],
    exclude_tickers_config: ["TSLA"],
    exclude_sectors_config: ["Energy"],
    count: 4,
    ...overrides,
  };
}

describe("handleCheckUniverse", () => {
  it("returns in_universe=true for base ticker", async () => {
    const res = mockResolution();
    const deps = {
      resolve: async () => res,
      checkSector: async () => ({ excluded: false }),
    };
    const r = await handleCheckUniverse({ ticker: "AAPL" }, deps);
    expect(r.in_universe).toBe(true);
    expect(r.base_match).toBe(true);
    expect(r.requires_justification).toBe(false);
  });

  it("returns exclude_hard_block for TSLA (excluded ticker)", async () => {
    const deps = { resolve: async () => mockResolution(), checkSector: async () => ({ excluded: false }) };
    const r = await handleCheckUniverse({ ticker: "TSLA" }, deps);
    expect(r.in_universe).toBe(false);
    expect(r.exclude_hard_block).toBe(true);
    expect(r.exclude_reason).toBe("ticker");
  });

  it("returns exclude_hard_block when sector excluded (preset mode)", async () => {
    const deps = {
      resolve: async () => mockResolution(),
      checkSector: async () => ({ excluded: true, sector: "Energy" }),
    };
    const r = await handleCheckUniverse({ ticker: "XOM" }, deps);
    expect(r.exclude_hard_block).toBe(true);
    expect(r.exclude_reason).toBe("sector");
  });

  it("requires_justification for out-of-universe ticker without hard block", async () => {
    const deps = {
      resolve: async () => mockResolution(),
      checkSector: async () => ({ excluded: false }),
    };
    const r = await handleCheckUniverse({ ticker: "ZZZZ" }, deps);
    expect(r.in_universe).toBe(false);
    expect(r.exclude_hard_block).toBe(false);
    expect(r.requires_justification).toBe(true);
  });

  it("include override: TSM returns in_universe=true with include_override", async () => {
    const deps = { resolve: async () => mockResolution(), checkSector: async () => ({ excluded: false }) };
    const r = await handleCheckUniverse({ ticker: "TSM" }, deps);
    expect(r.in_universe).toBe(true);
    expect(r.include_override).toBe(true);
  });
});

describe("handleListUniverse", () => {
  it("returns final_tickers with metadata", async () => {
    const res = mockResolution();
    const deps = { resolve: async () => res, getProfile: async () => null };
    const r = await handleListUniverse({}, deps);
    expect(r.tickers).toEqual(["AAPL", "MSFT", "GOOG", "TSM"]);
    expect(r.total).toBe(4);
    expect(r.resolved_from).toBe("fmp");
  });

  it("applies limit", async () => {
    const res = mockResolution();
    const deps = { resolve: async () => res, getProfile: async () => null };
    const r = await handleListUniverse({ limit: 2 }, deps);
    expect(r.tickers).toHaveLength(2);
    expect(r.total).toBe(4);
  });

  it("filters by sector via profile lookups (preset mode)", async () => {
    const res = mockResolution();
    const sectors: Record<string, string> = { AAPL: "Technology", MSFT: "Technology", GOOG: "Communication Services", TSM: "Technology" };
    const deps = {
      resolve: async () => res,
      getProfile: async (t: string) => ({ symbol: t, sector: sectors[t] ?? "Other" }),
    };
    const r = await handleListUniverse({ sector: "Technology" }, deps);
    expect(r.tickers).toEqual(["AAPL", "MSFT", "TSM"]);
  });
});
