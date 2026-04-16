import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUniverseBadge } from "../src/services/status.service.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fundx-badge-"));
  process.env.FUNDX_HOME = tmp;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-16T10:00:00Z"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.FUNDX_HOME;
  vi.useRealTimers();
});

describe("buildUniverseBadge", () => {
  it("returns null when no cache exists", async () => {
    mkdirSync(join(tmp, "funds", "testfund", "state"), { recursive: true });
    expect(await buildUniverseBadge("testfund")).toBeNull();
  });

  it("builds a preset badge from a fresh cache", async () => {
    const stateDir = join(tmp, "funds", "testfund", "state");
    mkdirSync(stateDir, { recursive: true });
    const now = new Date("2026-04-16T10:00:00Z").getTime();
    const resolution = {
      resolved_at: now - 2 * 3_600_000,
      config_hash: "h",
      resolved_from: "fmp",
      source: { kind: "preset", preset: "sp500" },
      base_tickers: [],
      final_tickers: [],
      include_applied: [],
      exclude_tickers_applied: [],
      exclude_sectors_applied: [],
      exclude_tickers_config: [],
      exclude_sectors_config: [],
      count: 503,
    };
    writeFileSync(join(stateDir, "universe.json"), JSON.stringify(resolution));
    const badge = await buildUniverseBadge("testfund");
    expect(badge).toEqual({
      source: "SP500",
      count: 503,
      ageHours: 2,
      staleness: "fresh",
    });
  });

  it("marks stale cache badge as yellow staleness", async () => {
    const stateDir = join(tmp, "funds", "testfund", "state");
    mkdirSync(stateDir, { recursive: true });
    const now = new Date("2026-04-16T10:00:00Z").getTime();
    const resolution = {
      resolved_at: now,
      config_hash: "h",
      resolved_from: "stale_cache",
      source: { kind: "preset", preset: "nasdaq100" },
      base_tickers: [],
      final_tickers: [],
      include_applied: [],
      exclude_tickers_applied: [],
      exclude_sectors_applied: [],
      exclude_tickers_config: [],
      exclude_sectors_config: [],
      count: 100,
    };
    writeFileSync(join(stateDir, "universe.json"), JSON.stringify(resolution));
    const badge = await buildUniverseBadge("testfund");
    expect(badge?.staleness).toBe("stale");
    expect(badge?.source).toBe("NASDAQ100");
  });

  it("marks static_fallback as 'fallback' staleness", async () => {
    const stateDir = join(tmp, "funds", "testfund", "state");
    mkdirSync(stateDir, { recursive: true });
    const now = new Date("2026-04-16T10:00:00Z").getTime();
    const resolution = {
      resolved_at: now,
      config_hash: "h",
      resolved_from: "static_fallback",
      source: { kind: "preset", preset: "sp500" },
      base_tickers: [],
      final_tickers: [],
      include_applied: [],
      exclude_tickers_applied: [],
      exclude_sectors_applied: [],
      exclude_tickers_config: [],
      exclude_sectors_config: [],
      count: 50,
    };
    writeFileSync(join(stateDir, "universe.json"), JSON.stringify(resolution));
    const badge = await buildUniverseBadge("testfund");
    expect(badge?.staleness).toBe("fallback");
  });

  it("builds a filters badge with FILTERS source", async () => {
    const stateDir = join(tmp, "funds", "testfund", "state");
    mkdirSync(stateDir, { recursive: true });
    const now = new Date("2026-04-16T10:00:00Z").getTime();
    const resolution = {
      resolved_at: now,
      config_hash: "h",
      resolved_from: "fmp",
      source: { kind: "filters" },
      base_tickers: [],
      final_tickers: [],
      include_applied: [],
      exclude_tickers_applied: [],
      exclude_sectors_applied: [],
      exclude_tickers_config: [],
      exclude_sectors_config: [],
      count: 250,
    };
    writeFileSync(join(stateDir, "universe.json"), JSON.stringify(resolution));
    const badge = await buildUniverseBadge("testfund");
    expect(badge?.source).toBe("FILTERS");
    expect(badge?.count).toBe(250);
  });
});
