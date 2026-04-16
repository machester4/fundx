import { describe, it, expect } from "vitest";
import { handleBuyGate } from "../src/mcp/broker-local-universe.js";
import type { UniverseResolution } from "../src/types.js";
// UniverseResolution is used in checkSector mock signatures

function mockResolution(overrides: Partial<UniverseResolution> = {}): UniverseResolution {
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
    exclude_sectors_config: ["Energy"],
    count: 3,
    ...overrides,
  };
}

function baseDeps(overrides: Partial<{ resolve: () => Promise<UniverseResolution>; checkSector: (t: string, res: UniverseResolution) => Promise<{ excluded: boolean; sector?: string }> }> = {}) {
  return {
    resolve: async () => mockResolution(),
    checkSector: async (_t: string, _res: UniverseResolution) => ({ excluded: false }),
    ...overrides,
  };
}

describe("handleBuyGate", () => {
  it("accepts ticker in universe base", async () => {
    const r = await handleBuyGate({ symbol: "AAPL" }, baseDeps());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out_of_universe).toBe(false);
  });

  it("accepts include_override ticker without sector check", async () => {
    // Even if sector would exclude, include_tickers wins
    const deps = baseDeps({ checkSector: async (_t: string, _res: UniverseResolution) => ({ excluded: true, sector: "Energy" }) });
    const r = await handleBuyGate({ symbol: "TSM" }, deps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out_of_universe).toBe(false);
  });

  it("hard-blocks ticker in exclude_tickers", async () => {
    const r = await handleBuyGate({ symbol: "TSLA" }, baseDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNIVERSE_EXCLUDED");
  });

  it("hard-blocks ticker in exclude_sectors (preset mode)", async () => {
    const deps = baseDeps({ checkSector: async (_t: string, _res: UniverseResolution) => ({ excluded: true, sector: "Energy" }) });
    const r = await handleBuyGate({ symbol: "XOM" }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNIVERSE_EXCLUDED");
  });

  it("soft-gates out-of-universe ticker without reason", async () => {
    const r = await handleBuyGate({ symbol: "ZZZZ" }, baseDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNIVERSE_SOFT_GATE");
  });

  it("accepts out-of-universe with reason >= 20 chars", async () => {
    const r = await handleBuyGate(
      {
        symbol: "ZZZZ",
        out_of_universe_reason: "Announced acquisition at 40% premium, event-driven",
      },
      baseDeps(),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.out_of_universe).toBe(true);
      expect(r.out_of_universe_reason).toContain("Announced acquisition");
    }
  });

  it("rejects reason shorter than 20 chars", async () => {
    const r = await handleBuyGate(
      { symbol: "ZZZZ", out_of_universe_reason: "too short" },
      baseDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNIVERSE_REASON_TOO_SHORT");
  });

  it("trims whitespace from reason when measuring length", async () => {
    const r = await handleBuyGate(
      { symbol: "ZZZZ", out_of_universe_reason: "   short   " },
      baseDeps(),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNIVERSE_REASON_TOO_SHORT");
  });
});
