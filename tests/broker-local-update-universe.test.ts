import { describe, it, expect } from "vitest";
import { handleUpdateUniverse } from "../src/mcp/broker-local-universe.js";
import type { FundConfig, UniverseResolution } from "../src/types.js";

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

function makeResolutionFor(config: FundConfig): UniverseResolution {
  const preset = config.universe.preset;
  return {
    resolved_at: 1,
    config_hash: "h",
    resolved_from: "fmp",
    source: preset ? { kind: "preset" as const, preset } : { kind: "filters" as const },
    base_tickers: ["AAPL"],
    final_tickers: ["AAPL"],
    include_applied: [],
    exclude_tickers_applied: [],
    exclude_sectors_applied: [],
    exclude_tickers_config: [...config.universe.exclude_tickers],
    exclude_sectors_config: [...config.universe.exclude_sectors],
    count: 1,
  };
}

function baseDeps(current: FundConfig) {
  const writes: FundConfig[] = [];
  const invalidations: number[] = [];
  const regens: FundConfig[] = [];
  const audits: Array<{ before: unknown; after: unknown; timestamp: string }> = [];
  return {
    deps: {
      loadCurrentConfig: async () => current,
      writeConfigYaml: async (c: FundConfig) => { writes.push(c); },
      invalidateUniverseCache: async () => { invalidations.push(Date.now()); },
      regenerateClaudeMd: async (c: FundConfig) => { regens.push(c); },
      resolveNewUniverse: async (c: FundConfig, _opts?: { dryRun: boolean }) => makeResolutionFor(c),
      auditLog: async (entry: { before: unknown; after: unknown; timestamp: string }) => { audits.push(entry); },
    },
    writes,
    invalidations,
    regens,
    audits,
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

  it("rejects empty mode object", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    await expect(
      handleUpdateUniverse({ mode: {} }, deps),
    ).rejects.toThrow(/either preset or filters/);
  });

  it("appends an audit log entry on success", async () => {
    const cfg = makeConfig({ preset: "sp500" });
    const { deps, audits } = baseDeps(cfg);
    await handleUpdateUniverse({ mode: { preset: "nasdaq100" } }, deps);
    expect(audits.length).toBe(1);
    expect(audits[0].before).toMatchObject({ source: "preset:sp500" });
    expect(audits[0].after).toMatchObject({ source: "preset:nasdaq100" });
  });

  it("does NOT audit-log on validation failure", async () => {
    const cfg = makeConfig();
    const { deps, audits } = baseDeps(cfg);
    await expect(
      handleUpdateUniverse({ exclude_sectors: ["Invalid"] }, deps),
    ).rejects.toThrow();
    expect(audits.length).toBe(0);
  });

  it("surfaces warning when resolved universe is empty", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    deps.resolveNewUniverse = async () => ({
      resolved_at: 1, config_hash: "h", resolved_from: "fmp",
      source: { kind: "preset" as const, preset: "sp500" as const },
      base_tickers: [], final_tickers: [], include_applied: [],
      exclude_tickers_applied: [], exclude_sectors_applied: [],
      exclude_tickers_config: [], exclude_sectors_config: [],
      count: 0,
    });
    const r = await handleUpdateUniverse({ mode: { preset: "nasdaq100" } }, deps);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join(" ")).toContain("empty");
    expect(r.resolved.count).toBe(0);
  });

  it("surfaces warning when resolved from static_fallback", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    deps.resolveNewUniverse = async () => ({
      resolved_at: 1, config_hash: "h", resolved_from: "static_fallback",
      source: { kind: "preset" as const, preset: "nasdaq100" as const },
      base_tickers: ["A", "B"], final_tickers: ["A", "B"], include_applied: [],
      exclude_tickers_applied: [], exclude_sectors_applied: [],
      exclude_tickers_config: [], exclude_sectors_config: [],
      count: 2,
    });
    const r = await handleUpdateUniverse({ mode: { preset: "nasdaq100" } }, deps);
    expect(r.warnings.join(" ")).toContain("static fallback");
  });

  it("returns resolved count and source in output", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    const r = await handleUpdateUniverse({ mode: { preset: "nasdaq100" } }, deps);
    expect(r.resolved.count).toBeGreaterThan(0);
    expect(r.resolved.resolved_from).toBe("fmp");
  });

  it("does NOT persist to disk when regenerateClaudeMd throws (but YAML + cache already committed)", async () => {
    // Note: this documents current behavior. The YAML write and cache invalidation
    // have already happened by the time regenerateClaudeMd runs. If regen fails
    // the config file is still the new one (YAML write is atomic). This is the
    // intended ordering — YAML is the source of truth; CLAUDE.md is derived and
    // can be regenerated by `fundx fund upgrade`.
    const cfg = makeConfig();
    const { deps, writes, invalidations } = baseDeps(cfg);
    deps.regenerateClaudeMd = async () => { throw new Error("disk full"); };
    await expect(
      handleUpdateUniverse({ include_tickers: ["NVDA"] }, deps),
    ).rejects.toThrow(/disk full/);
    // YAML already written, cache already invalidated — this is acceptable
    // because both operations are atomic and self-consistent
    expect(writes.length).toBe(1);
    expect(invalidations.length).toBe(1);
  });
});

describe("handleUpdateUniverse — dry_run", () => {
  it("does NOT call writeConfigYaml / invalidateUniverseCache / regenerateClaudeMd / auditLog on dry_run", async () => {
    const cfg = makeConfig();
    const { deps, writes, invalidations, regens, audits } = baseDeps(cfg);
    const r = await handleUpdateUniverse(
      { mode: { preset: "nasdaq100" }, dry_run: true },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(writes.length).toBe(0);
    expect(invalidations.length).toBe(0);
    expect(regens.length).toBe(0);
    expect(audits.length).toBe(0);
  });

  it("still validates schema on dry_run", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    await expect(
      handleUpdateUniverse({ exclude_sectors: ["NotASector"], dry_run: true }, deps),
    ).rejects.toThrow();
  });

  it("still resolves on dry_run and returns count + warnings", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    deps.resolveNewUniverse = async () => ({
      resolved_at: 1, config_hash: "h", resolved_from: "fmp",
      source: { kind: "preset" as const, preset: "nasdaq100" as const },
      base_tickers: ["AAPL"], final_tickers: ["AAPL"], include_applied: [],
      exclude_tickers_applied: [], exclude_sectors_applied: [],
      exclude_tickers_config: [], exclude_sectors_config: [],
      count: 1,
    });
    const r = await handleUpdateUniverse(
      { mode: { preset: "nasdaq100" }, dry_run: true },
      deps,
    );
    expect(r.resolved.count).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("dry_run note differs from normal note", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    const a = await handleUpdateUniverse({ mode: { preset: "nasdaq100" }, dry_run: true }, deps);
    const b = await handleUpdateUniverse({ mode: { preset: "nasdaq100" } }, deps);
    expect(a.note).toContain("DRY RUN");
    expect(b.note).not.toContain("DRY RUN");
  });

  it("passes dryRun:true to resolveNewUniverse on dry_run path", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    let capturedOpts: { dryRun: boolean } | undefined;
    deps.resolveNewUniverse = async (_c: FundConfig, opts: { dryRun: boolean }) => {
      capturedOpts = opts;
      return {
        resolved_at: 1, config_hash: "h", resolved_from: "fmp",
        source: { kind: "preset" as const, preset: "sp500" as const },
        base_tickers: [], final_tickers: [], include_applied: [],
        exclude_tickers_applied: [], exclude_sectors_applied: [],
        exclude_tickers_config: [], exclude_sectors_config: [],
        count: 0,
      };
    };
    await handleUpdateUniverse({ mode: { preset: "nasdaq100" }, dry_run: true }, deps);
    expect(capturedOpts?.dryRun).toBe(true);
  });

  it("passes dryRun:false to resolveNewUniverse on commit path", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    let capturedOpts: { dryRun: boolean } | undefined;
    deps.resolveNewUniverse = async (_c: FundConfig, opts: { dryRun: boolean }) => {
      capturedOpts = opts;
      return {
        resolved_at: 1, config_hash: "h", resolved_from: "fmp",
        source: { kind: "preset" as const, preset: "sp500" as const },
        base_tickers: [], final_tickers: [], include_applied: [],
        exclude_tickers_applied: [], exclude_sectors_applied: [],
        exclude_tickers_config: [], exclude_sectors_config: [],
        count: 0,
      };
    };
    await handleUpdateUniverse({ mode: { preset: "nasdaq100" } }, deps);
    expect(capturedOpts?.dryRun).toBe(false);
  });
});
