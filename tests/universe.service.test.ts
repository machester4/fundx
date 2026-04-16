import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Universe, UniverseResolution } from "../src/types.js";
import {
  resolveUniverse,
  readCachedUniverse,
  hashUniverseConfig,
  isInUniverse,
} from "../src/services/universe.service.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fundx-univ-"));
  process.env.FUNDX_HOME = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.FUNDX_HOME;
});

function setupFundDir(fundName: string): string {
  const state = join(tmp, "funds", fundName, "state");
  mkdirSync(state, { recursive: true });
  return state;
}

describe("hashUniverseConfig", () => {
  it("is stable for the same config", () => {
    const u: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    expect(hashUniverseConfig(u)).toBe(hashUniverseConfig(u));
  });

  it("changes when preset changes", () => {
    const a: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    const b: Universe = { preset: "nasdaq100", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    expect(hashUniverseConfig(a)).not.toBe(hashUniverseConfig(b));
  });

  it("changes when exclude_tickers changes", () => {
    const a: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: ["TSLA"], exclude_sectors: [] };
    const b: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: ["GOOG"], exclude_sectors: [] };
    expect(hashUniverseConfig(a)).not.toBe(hashUniverseConfig(b));
  });

  it("is insensitive to array order (tickers sorted before hashing)", () => {
    const a: Universe = { preset: "sp500", include_tickers: ["A", "B"], exclude_tickers: [], exclude_sectors: [] };
    const b: Universe = { preset: "sp500", include_tickers: ["B", "A"], exclude_tickers: [], exclude_sectors: [] };
    expect(hashUniverseConfig(a)).toBe(hashUniverseConfig(b));
  });
});

describe("isInUniverse", () => {
  const res: UniverseResolution = {
    resolved_at: 1,
    config_hash: "x",
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
  };

  it("in-base + not-excluded = in_universe true", () => {
    const s = isInUniverse(res, "AAPL");
    expect(s.in_universe).toBe(true);
    expect(s.base_match).toBe(true);
    expect(s.exclude_hard_block).toBe(false);
  });

  it("include override works", () => {
    const s = isInUniverse(res, "TSM");
    expect(s.in_universe).toBe(true);
    expect(s.include_override).toBe(true);
  });

  it("excluded ticker is hard blocked", () => {
    const s = isInUniverse(res, "TSLA");
    expect(s.in_universe).toBe(false);
    expect(s.exclude_hard_block).toBe(true);
    expect(s.exclude_reason).toBe("ticker");
  });

  it("not in universe + not excluded", () => {
    const s = isInUniverse(res, "ZZZZ");
    expect(s.in_universe).toBe(false);
    expect(s.base_match).toBe(false);
    expect(s.exclude_hard_block).toBe(false);
  });
});

describe("resolveUniverse (preset)", () => {
  it("calls sp500 endpoint and caches result", async () => {
    setupFundDir("testfund");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ symbol: "AAPL" }, { symbol: "MSFT" }]), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const cfg: Universe = {
      preset: "sp500",
      include_tickers: [],
      exclude_tickers: [],
      exclude_sectors: [],
    };
    const res = await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });
    expect(res.resolved_from).toBe("fmp");
    expect(res.count).toBe(2);
    expect(res.final_tickers).toEqual(["AAPL", "MSFT"]);

    const cached = await readCachedUniverse("testfund");
    expect(cached?.count).toBe(2);
    expect(existsSync(join(tmp, "funds", "testfund", "state", "universe.json"))).toBe(true);
  });

  it("returns cache hit within TTL without calling FMP", async () => {
    setupFundDir("testfund");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([{ symbol: "AAPL" }]), { status: 200 }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const cfg: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });
    fetchMock.mockClear();

    const r2 = await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 + 60_000 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r2.resolved_from).toBe("fmp"); // came from cache but original fetch was fmp
  });

  it("re-resolves when TTL expires", async () => {
    setupFundDir("testfund");
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify([{ symbol: "AAPL" }]), { status: 200 });
    }) as typeof globalThis.fetch;
    const cfg: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });
    await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 + 25 * 3600 * 1000 });
    expect(calls).toBe(2);
  });

  it("re-resolves when config_hash changes", async () => {
    setupFundDir("testfund");
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify([{ symbol: "AAPL" }]), { status: 200 });
    }) as typeof globalThis.fetch;
    const a: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    const b: Universe = { preset: "nasdaq100", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    await resolveUniverse("testfund", a, "KEY", { now: 1_000_000 });
    await resolveUniverse("testfund", b, "KEY", { now: 1_000_000 + 60_000 });
    expect(calls).toBe(2);
  });

  it("force:true re-resolves even within TTL", async () => {
    setupFundDir("testfund");
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify([{ symbol: "AAPL" }]), { status: 200 });
    }) as typeof globalThis.fetch;
    const cfg: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });
    await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 + 1000, force: true });
    expect(calls).toBe(2);
  });

  it("applies include_tickers (added) and exclude_tickers (removed)", async () => {
    setupFundDir("testfund");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ symbol: "AAPL" }, { symbol: "TSLA" }, { symbol: "MSFT" }]), { status: 200 }),
    ) as typeof globalThis.fetch;
    const cfg: Universe = {
      preset: "sp500",
      include_tickers: ["TSM"],
      exclude_tickers: ["TSLA"],
      exclude_sectors: [],
    };
    const res = await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });
    expect(res.final_tickers).toContain("TSM");
    expect(res.final_tickers).not.toContain("TSLA");
    expect(res.final_tickers).toContain("AAPL");
    expect(res.exclude_tickers_applied).toEqual(["TSLA"]);
    expect(res.include_applied).toEqual(["TSM"]);
  });
});

describe("resolveUniverse (fallback chain)", () => {
  it("falls back to stale cache on FMP failure", async () => {
    setupFundDir("testfund");
    // Seed a valid cache
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ symbol: "AAPL" }]), { status: 200 }),
    ) as typeof globalThis.fetch;
    const cfg: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });

    // Now fail FMP, age out TTL
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 500 })) as typeof globalThis.fetch;
    const res = await resolveUniverse("testfund", cfg, "KEY", {
      now: 1_000_000 + 25 * 3600 * 1000,
    });
    expect(res.resolved_from).toBe("stale_cache");
    expect(res.count).toBe(1);
  });

  it("falls back to SP500_FALLBACK on FMP failure with no cache", async () => {
    setupFundDir("testfund");
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 500 })) as typeof globalThis.fetch;
    const cfg: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    const res = await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });
    expect(res.resolved_from).toBe("static_fallback");
    expect(res.count).toBeGreaterThan(0);
  });

  it("falls through to static_fallback when stale cache has a mismatched config_hash", async () => {
    setupFundDir("testfund");
    // Seed cache with nasdaq100
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ symbol: "AAPL" }, { symbol: "MSFT" }]), { status: 200 }),
    ) as any;
    const a: Universe = { preset: "nasdaq100", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    await resolveUniverse("testfund", a, "KEY", { now: 1_000_000 });

    // Now change config to sp500 and fail FMP
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 500 })) as any;
    const b: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    const res = await resolveUniverse("testfund", b, "KEY", { now: 1_000_000 + 60_000 });
    expect(res.resolved_from).toBe("static_fallback");
  });
});

describe("resolveUniverse (filters)", () => {
  it("calls screener and applies includes/excludes", async () => {
    setupFundDir("testfund");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([
        { symbol: "AAPL", sector: "Technology" },
        { symbol: "XOM", sector: "Energy" },
      ]), { status: 200 }),
    ) as typeof globalThis.fetch;
    const cfg: Universe = {
      filters: { limit: 100, is_actively_trading: true },
      include_tickers: [],
      exclude_tickers: [],
      exclude_sectors: ["Energy"],
    };
    const res = await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });
    expect(res.final_tickers).toContain("AAPL");
    expect(res.final_tickers).not.toContain("XOM");
    expect(res.exclude_sectors_applied).toEqual(["XOM"]);
  });
});
