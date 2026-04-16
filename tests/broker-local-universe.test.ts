import { describe, it, expect, vi } from "vitest";
import { handleCheckUniverse, handleListUniverse } from "../src/mcp/broker-local-universe.js";
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
      checkSector: async (_t: string, _res: UniverseResolution) => ({ excluded: false }),
    };
    const r = await handleCheckUniverse({ ticker: "AAPL" }, deps);
    expect(r.in_universe).toBe(true);
    expect(r.base_match).toBe(true);
    expect(r.requires_justification).toBe(false);
  });

  it("returns exclude_hard_block for TSLA (excluded ticker)", async () => {
    const deps = { resolve: async () => mockResolution(), checkSector: async (_t: string, _res: UniverseResolution) => ({ excluded: false }) };
    const r = await handleCheckUniverse({ ticker: "TSLA" }, deps);
    expect(r.in_universe).toBe(false);
    expect(r.exclude_hard_block).toBe(true);
    expect(r.exclude_reason).toBe("ticker");
  });

  it("returns exclude_hard_block when sector excluded (preset mode)", async () => {
    const deps = {
      resolve: async () => mockResolution(),
      checkSector: async (_t: string, _res: UniverseResolution) => ({ excluded: true, sector: "Energy" }),
    };
    const r = await handleCheckUniverse({ ticker: "XOM" }, deps);
    expect(r.exclude_hard_block).toBe(true);
    expect(r.exclude_reason).toBe("sector");
  });

  it("requires_justification for out-of-universe ticker without hard block", async () => {
    const deps = {
      resolve: async () => mockResolution(),
      checkSector: async (_t: string, _res: UniverseResolution) => ({ excluded: false }),
    };
    const r = await handleCheckUniverse({ ticker: "ZZZZ" }, deps);
    expect(r.in_universe).toBe(false);
    expect(r.exclude_hard_block).toBe(false);
    expect(r.requires_justification).toBe(true);
  });

  it("include override: TSM returns in_universe=true with include_override", async () => {
    const deps = { resolve: async () => mockResolution(), checkSector: async (_t: string, _res: UniverseResolution) => ({ excluded: false }) };
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

  it("defaults limit to 50 when sector is set", async () => {
    const res = mockResolution({ final_tickers: Array.from({ length: 100 }, (_, i) => `T${i}`), count: 100 });
    const deps = {
      resolve: async () => res,
      getProfile: async (t: string) => ({ symbol: t, sector: "Technology" }),
    };
    const r = await handleListUniverse({ sector: "Technology" }, deps);
    expect(r.tickers.length).toBe(50);
    expect(r.total).toBe(100);
  });

  it("batches profile calls in groups of 10 (sector filter)", async () => {
    const tickers = Array.from({ length: 25 }, (_, i) => `T${i}`);
    const res = mockResolution({ final_tickers: tickers, count: 25 });
    const getProfile = vi.fn(async (t: string) => ({ symbol: t, sector: "Technology" }));
    const deps = { resolve: async () => res, getProfile };
    const r = await handleListUniverse({ sector: "Technology", limit: 25 }, deps);
    expect(r.tickers).toHaveLength(25);
    expect(getProfile).toHaveBeenCalledTimes(25);
  });

  it("verbose includes current include/exclude config lists", async () => {
    const res = mockResolution({
      exclude_tickers_config: ["TSLA"],
      exclude_sectors_config: ["Energy"],
    });
    const deps = { resolve: async () => res, getProfile: async () => null };
    const r = await handleListUniverse({ verbose: true }, deps);
    expect(r.exclude_tickers).toEqual(["TSLA"]);
    expect(r.exclude_sectors).toEqual(["Energy"]);
    expect(r.source).toEqual({ kind: "preset", preset: "sp500" });
  });

  it("non-verbose omits the extra fields", async () => {
    const res = mockResolution({ exclude_tickers_config: ["TSLA"] });
    const deps = { resolve: async () => res, getProfile: async () => null };
    const r = await handleListUniverse({}, deps);
    expect(r.exclude_tickers).toBeUndefined();
    expect(r.source).toBeUndefined();
  });
});
