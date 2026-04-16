import { describe, it, expect } from "vitest";
import { handleUpdateUniverse } from "../src/mcp/broker-local.js";
import type { FundConfig } from "../src/types.js";

function makeConfig(overrides: Partial<FundConfig["universe"]> = {}): FundConfig {
  return {
    fund: { name: "test", display_name: "Test", description: "", created: "2026-01-01", status: "active" },
    capital: { initial: 100_000, currency: "USD" },
    objective: { type: "growth" } as FundConfig["objective"],
    risk: {
      profile: "moderate",
      max_drawdown_pct: 15,
      max_position_pct: 25,
      max_leverage: 1,
      stop_loss_pct: 8,
      max_daily_loss_pct: 5,
      correlation_limit: 0.8,
      custom_rules: [],
    },
    universe: {
      preset: "sp500",
      include_tickers: [],
      exclude_tickers: [],
      exclude_sectors: [],
      ...overrides,
    } as FundConfig["universe"],
    schedule: {
      timezone: "UTC",
      trading_days: ["MON", "TUE", "WED", "THU", "FRI"],
      sessions: {},
      special_sessions: [],
    },
    broker: { mode: "paper" },
    notifications: {
      telegram: {
        enabled: false,
        trade_alerts: true,
        stop_loss_alerts: true,
        daily_digest: true,
        weekly_digest: true,
        milestone_alerts: true,
        drawdown_alerts: true,
      },
      quiet_hours: {
        enabled: true,
        start: "23:00",
        end: "07:00",
        allow_critical: true,
      },
    },
    claude: { model: "sonnet", personality: "", decision_framework: "" },
  } as unknown as FundConfig;
}

function baseDeps(current: FundConfig) {
  const writes: FundConfig[] = [];
  const invalidations: number[] = [];
  const regens: FundConfig[] = [];
  return {
    deps: {
      loadCurrentConfig: async () => current,
      writeConfigYaml: async (c: FundConfig) => { writes.push(c); },
      invalidateUniverseCache: async () => { invalidations.push(Date.now()); },
      regenerateClaudeMd: async (c: FundConfig) => { regens.push(c); },
    },
    writes,
    invalidations,
    regens,
  };
}

describe("handleUpdateUniverse", () => {
  it("switches preset sp500 → nasdaq100", async () => {
    const cfg = makeConfig({ preset: "sp500" });
    const { deps, writes } = baseDeps(cfg);
    const r = await handleUpdateUniverse({ mode: { preset: "nasdaq100" } }, deps);
    expect(r.ok).toBe(true);
    expect(r.before.source).toBe("preset:sp500");
    expect(r.after.source).toBe("preset:nasdaq100");
    expect(writes[0].universe.preset).toBe("nasdaq100");
  });

  it("switches preset → filters, dropping preset", async () => {
    const cfg = makeConfig({ preset: "sp500" });
    const { deps, writes } = baseDeps(cfg);
    await handleUpdateUniverse({
      mode: { filters: { market_cap_min: 10_000_000_000, is_actively_trading: true, limit: 500 } },
    }, deps);
    expect(writes[0].universe.preset).toBeUndefined();
    expect(writes[0].universe.filters?.market_cap_min).toBe(10_000_000_000);
  });

  it("rejects mode with both preset and filters", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    await expect(
      handleUpdateUniverse({
        mode: { preset: "sp500", filters: { limit: 100 } },
      }, deps),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("replaces include_tickers (does NOT append)", async () => {
    const cfg = makeConfig({ include_tickers: ["TSM", "ASML"] });
    const { deps, writes } = baseDeps(cfg);
    await handleUpdateUniverse({ include_tickers: ["NVDA"] }, deps);
    expect(writes[0].universe.include_tickers).toEqual(["NVDA"]);
  });

  it("uppercases tickers via schema transform", async () => {
    const cfg = makeConfig();
    const { deps, writes } = baseDeps(cfg);
    await handleUpdateUniverse({ include_tickers: ["nvda", "tsm"] }, deps);
    expect(writes[0].universe.include_tickers).toEqual(["NVDA", "TSM"]);
  });

  it("rejects unknown sector via Zod", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    await expect(
      handleUpdateUniverse({ exclude_sectors: ["Tech"] }, deps),
    ).rejects.toThrow(); // Zod enum failure
  });

  it("rejects unknown preset via Zod", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    await expect(
      handleUpdateUniverse({ mode: { preset: "russell5000" as "sp500" } }, deps),
    ).rejects.toThrow();
  });

  it("keeps unchanged fields when only editing excludes", async () => {
    const cfg = makeConfig({ preset: "nasdaq100", include_tickers: ["TSM"] });
    const { deps, writes } = baseDeps(cfg);
    await handleUpdateUniverse({ exclude_tickers: ["TSLA"] }, deps);
    expect(writes[0].universe.preset).toBe("nasdaq100");
    expect(writes[0].universe.include_tickers).toEqual(["TSM"]);
    expect(writes[0].universe.exclude_tickers).toEqual(["TSLA"]);
  });

  it("invalidates cache and regenerates CLAUDE.md on success", async () => {
    const cfg = makeConfig();
    const { deps, writes, invalidations, regens } = baseDeps(cfg);
    await handleUpdateUniverse({ include_tickers: ["NVDA"] }, deps);
    expect(writes.length).toBe(1);
    expect(invalidations.length).toBe(1);
    expect(regens.length).toBe(1);
    expect(regens[0].universe.include_tickers).toEqual(["NVDA"]);
  });

  it("does NOT persist on validation failure", async () => {
    const cfg = makeConfig();
    const { deps, writes, invalidations, regens } = baseDeps(cfg);
    await expect(
      handleUpdateUniverse({ exclude_sectors: ["NotARealSector"] }, deps),
    ).rejects.toThrow();
    expect(writes.length).toBe(0);
    expect(invalidations.length).toBe(0);
    expect(regens.length).toBe(0);
  });
});
