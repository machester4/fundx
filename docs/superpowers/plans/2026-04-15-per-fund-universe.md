# Per-Fund Universe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded S&P 500 screening universe with a per-fund universe system (schema → resolver with cache → MCP tools → gating at three points → prompt integration → CLI → migration).

**Architecture:** Each fund's `universe` block in `fund_config.yaml` is either a canonical index preset (`sp500` | `nasdaq100` | `dow30`) or a `filters` block mapping 1:1 to FMP's `/stable/company-screener`. A new `universe.service.ts` resolves configs to concrete ticker lists, caches them at `state/universe.json` with 24h TTL + config-hash invalidation + stale-cache/static fallback. Two new MCP tools (`check_universe`, `list_universe`) expose the universe to sessions. Gating fires in three places: screener, broker `execute_trade` (hard block for excludes, soft gate needing `out_of_universe_reason`), and `trade-evaluator` subagent. Migration from the old `{allowed,forbidden}` schema runs in `fundx fund upgrade`.

**Tech Stack:** TypeScript, Zod, Vitest, FMP API (`/api/v3` and `/stable`), better-sqlite3 (existing journal).

**Spec:** `docs/superpowers/specs/2026-04-15-per-fund-universe-design.md`

**Reference files (read before starting):**
- `src/services/market.service.ts` — existing FMP fetch pattern (15s timeout, warn-and-fallback)
- `src/services/screening.service.ts` — `runScreen` consumer
- `src/mcp/broker-local.ts` — `execute_trade` tool to gate
- `src/mcp/screener.ts` — `screen_run` tool to update
- `src/types.ts` — Zod schemas (lines 60-120)
- `src/state.ts` — `writeJsonAtomic` helper
- `src/paths.ts` — `fundPaths()` helper
- `src/skills.ts` — `BUILTIN_SKILLS`, `FUND_RULES` (source of truth)
- `src/template.ts` — per-fund CLAUDE.md generation
- `src/services/session.service.ts` — session prompt assembly

---

## Task 1: Schema + Zod enums

**Files:**
- Create: `src/constants/fmp-enums.ts`
- Modify: `src/types.ts` (replace `universeSchema` around line 70)
- Test: `tests/types.test.ts` (append)

- [ ] **Step 1.1: Create FMP enum constants**

Create `src/constants/fmp-enums.ts`:

```ts
// FMP /stable/company-screener parameter constraints.
// Refresh manually when FMP publishes new values.
// Source: https://site.financialmodelingprep.com/developer/docs/stock-screener-api

export const FMP_EXCHANGES_STARTER = [
  "NASDAQ", "NYSE", "AMEX", "CBOE", "OTC", "PNK", "CNQ",
] as const;

export const FMP_EXCHANGES_PREMIUM_EXTRA = [
  "NEO", "TSXV", "TSX", "LSE",
] as const;

export const FMP_EXCHANGES_ALL = [
  ...FMP_EXCHANGES_STARTER,
  ...FMP_EXCHANGES_PREMIUM_EXTRA,
] as const;

export type FmpExchange = (typeof FMP_EXCHANGES_ALL)[number];

export const FMP_SECTORS = [
  "Basic Materials",
  "Communication Services",
  "Consumer Cyclical",
  "Consumer Defensive",
  "Energy",
  "Financial Services",
  "Healthcare",
  "Industrials",
  "Real Estate",
  "Technology",
  "Utilities",
] as const;

export type FmpSector = (typeof FMP_SECTORS)[number];

export const UNIVERSE_PRESETS = ["sp500", "nasdaq100", "dow30"] as const;
export type UniversePreset = (typeof UNIVERSE_PRESETS)[number];
```

- [ ] **Step 1.2: Write failing schema test**

Append to `tests/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { universeSchema, fmpScreenerFiltersSchema } from "../src/types.js";

describe("universeSchema (per-fund universe)", () => {
  it("accepts a preset block", () => {
    const u = universeSchema.parse({ preset: "sp500" });
    expect(u.preset).toBe("sp500");
    expect(u.include_tickers).toEqual([]);
  });

  it("accepts a filters block", () => {
    const u = universeSchema.parse({
      filters: { market_cap_min: 1e10, exchange: ["NYSE", "NASDAQ"] },
    });
    expect(u.filters?.market_cap_min).toBe(1e10);
  });

  it("rejects both preset and filters", () => {
    expect(() =>
      universeSchema.parse({ preset: "sp500", filters: { limit: 100 } }),
    ).toThrow(/exactly one/);
  });

  it("rejects neither preset nor filters", () => {
    expect(() => universeSchema.parse({})).toThrow(/exactly one/);
  });

  it("rejects unknown exchange", () => {
    expect(() =>
      universeSchema.parse({ filters: { exchange: ["NYSE", "FAKE"] } }),
    ).toThrow();
  });

  it("rejects unknown sector", () => {
    expect(() =>
      universeSchema.parse({ filters: { sector: ["Tech"] } }),
    ).toThrow();
  });

  it("rejects market_cap_min >= max", () => {
    expect(() =>
      universeSchema.parse({
        filters: { market_cap_min: 1e10, market_cap_max: 1e9 },
      }),
    ).toThrow(/market_cap_min must be/);
  });

  it("uppercases include/exclude tickers", () => {
    const u = universeSchema.parse({
      preset: "sp500",
      include_tickers: ["tsm", "asml"],
      exclude_tickers: ["tsla"],
    });
    expect(u.include_tickers).toEqual(["TSM", "ASML"]);
    expect(u.exclude_tickers).toEqual(["TSLA"]);
  });

  it("validates country as ISO-2", () => {
    expect(() =>
      universeSchema.parse({ filters: { country: "USA" } }),
    ).toThrow();
    expect(universeSchema.parse({ filters: { country: "US" } }).filters?.country).toBe("US");
  });
});
```

- [ ] **Step 1.3: Run tests to verify they fail**

```bash
pnpm test tests/types.test.ts -- --run
```

Expected: all 8 new tests FAIL with undefined `universeSchema` properties or structural errors.

- [ ] **Step 1.4: Replace `universeSchema` in `src/types.ts`**

Remove the existing `assetEntrySchema` and `universeSchema` (around lines 60-73) and replace with:

```ts
// ── Universe Schema ────────────────────────────────────────────
import {
  FMP_EXCHANGES_ALL,
  FMP_SECTORS,
  UNIVERSE_PRESETS,
} from "./constants/fmp-enums.js";

export const universePresetSchema = z.enum(UNIVERSE_PRESETS);
export type UniversePreset = z.infer<typeof universePresetSchema>;

export const fmpExchangeSchema = z.enum(FMP_EXCHANGES_ALL);
export const fmpSectorSchema = z.enum(FMP_SECTORS);

export const fmpScreenerFiltersSchema = z
  .object({
    market_cap_min: z.number().nonnegative().optional(),
    market_cap_max: z.number().positive().optional(),
    price_min: z.number().nonnegative().optional(),
    price_max: z.number().positive().optional(),
    beta_min: z.number().optional(),
    beta_max: z.number().optional(),
    dividend_min: z.number().nonnegative().optional(),
    dividend_max: z.number().nonnegative().optional(),
    volume_min: z.number().nonnegative().optional(),
    volume_max: z.number().positive().optional(),
    sector: z.array(fmpSectorSchema).optional(),
    industry: z.string().optional(),
    exchange: z.array(fmpExchangeSchema).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    is_etf: z.boolean().optional(),
    is_fund: z.boolean().optional(),
    is_actively_trading: z.boolean().default(true),
    include_all_share_classes: z.boolean().optional(),
    limit: z.number().int().min(1).max(10_000).default(500),
  })
  .refine(
    (f) => !(f.market_cap_min != null && f.market_cap_max != null) || f.market_cap_min < f.market_cap_max,
    { message: "market_cap_min must be < market_cap_max" },
  )
  .refine(
    (f) => !(f.price_min != null && f.price_max != null) || f.price_min < f.price_max,
    { message: "price_min must be < price_max" },
  )
  .refine(
    (f) => !(f.beta_min != null && f.beta_max != null) || f.beta_min < f.beta_max,
    { message: "beta_min must be < beta_max" },
  )
  .refine(
    (f) => !(f.dividend_min != null && f.dividend_max != null) || f.dividend_min < f.dividend_max,
    { message: "dividend_min must be < dividend_max" },
  )
  .refine(
    (f) => !(f.volume_min != null && f.volume_max != null) || f.volume_min < f.volume_max,
    { message: "volume_min must be < volume_max" },
  );

export type FmpScreenerFilters = z.infer<typeof fmpScreenerFiltersSchema>;

export const universeSchema = z
  .object({
    preset: universePresetSchema.optional(),
    filters: fmpScreenerFiltersSchema.optional(),
    include_tickers: z.array(z.string().transform((s) => s.toUpperCase())).default([]),
    exclude_tickers: z.array(z.string().transform((s) => s.toUpperCase())).default([]),
    exclude_sectors: z.array(fmpSectorSchema).default([]),
  })
  .refine(
    (u) => (u.preset != null) !== (u.filters != null),
    { message: "universe must have exactly one of `preset` or `filters`" },
  );

export type Universe = z.infer<typeof universeSchema>;
```

No other changes in `types.ts`. The `fundConfigSchema` already references `universeSchema` on line 117 — that line stays.

- [ ] **Step 1.5: Run tests to verify they pass**

```bash
pnpm test tests/types.test.ts -- --run
```

Expected: all 8 new tests PASS.

- [ ] **Step 1.6: Run full typecheck (will fail in many places — expected)**

```bash
pnpm typecheck
```

Expected: errors in files that referenced the old `universe.allowed` / `universe.forbidden` shape (templates, subagent, session, status, ask services). These will be fixed in later tasks. Note the errors for now; do not fix them here.

- [ ] **Step 1.7: Commit**

```bash
git add src/constants/fmp-enums.ts src/types.ts tests/types.test.ts
git commit -m "feat(universe): Zod schema for per-fund universe (preset | filters)"
```

---

## Task 2: FMP market endpoints

**Files:**
- Modify: `src/services/market.service.ts` (append new exports)
- Test: `tests/market-universe.test.ts` (new)

**Goal:** Four new fetchers — `getNasdaq100Constituents`, `getDow30Constituents`, `getScreenerResults(filters)`, and `getCompanyProfile(ticker)` with in-memory LRU cache.

- [ ] **Step 2.1: Write failing tests**

Create `tests/market-universe.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getNasdaq100Constituents,
  getDow30Constituents,
  getScreenerResults,
  getCompanyProfile,
  _resetProfileCacheForTests,
} from "../src/services/market.service.js";

const origFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => unknown) {
  globalThis.fetch = vi.fn(async (url: any) => {
    const body = handler(String(url));
    if (body === undefined) return new Response("not found", { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as any;
}

beforeEach(() => {
  globalThis.fetch = origFetch;
  _resetProfileCacheForTests();
});

describe("getNasdaq100Constituents", () => {
  it("returns tickers from FMP response", async () => {
    mockFetch((url) => {
      expect(url).toContain("/nasdaq_constituent");
      expect(url).toContain("apikey=KEY");
      return [{ symbol: "AAPL" }, { symbol: "MSFT" }];
    });
    expect(await getNasdaq100Constituents("KEY")).toEqual(["AAPL", "MSFT"]);
  });

  it("returns empty array on non-200 (caller handles fallback)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 500 })) as any;
    expect(await getNasdaq100Constituents("KEY")).toEqual([]);
  });
});

describe("getDow30Constituents", () => {
  it("returns tickers from FMP response", async () => {
    mockFetch((url) => {
      expect(url).toContain("/dowjones_constituent");
      return [{ symbol: "MMM" }, { symbol: "BA" }];
    });
    expect(await getDow30Constituents("KEY")).toEqual(["MMM", "BA"]);
  });
});

describe("getScreenerResults", () => {
  it("builds correct query string from all filters", async () => {
    let captured = "";
    mockFetch((url) => {
      captured = url;
      return [];
    });
    await getScreenerResults(
      {
        market_cap_min: 1e10,
        market_cap_max: 5e11,
        price_min: 10,
        price_max: 500,
        beta_min: 0.5,
        beta_max: 1.5,
        dividend_min: 0,
        dividend_max: 5,
        volume_min: 1_000_000,
        volume_max: 100_000_000,
        sector: ["Technology", "Healthcare"],
        industry: "Consumer Electronics",
        exchange: ["NYSE", "NASDAQ"],
        country: "US",
        is_etf: false,
        is_fund: false,
        is_actively_trading: true,
        include_all_share_classes: false,
        limit: 500,
      },
      "KEY",
    );
    expect(captured).toContain("/company-screener");
    expect(captured).toContain("marketCapMoreThan=10000000000");
    expect(captured).toContain("marketCapLowerThan=500000000000");
    expect(captured).toContain("priceMoreThan=10");
    expect(captured).toContain("betaMoreThan=0.5");
    expect(captured).toContain("dividendMoreThan=0");
    expect(captured).toContain("volumeMoreThan=1000000");
    expect(captured).toContain("sector=Technology");
    expect(captured).toContain("sector=Healthcare");
    expect(captured).toContain("industry=Consumer%20Electronics");
    expect(captured).toContain("exchange=NYSE");
    expect(captured).toContain("exchange=NASDAQ");
    expect(captured).toContain("country=US");
    expect(captured).toContain("isEtf=false");
    expect(captured).toContain("isActivelyTrading=true");
    expect(captured).toContain("limit=500");
    expect(captured).toContain("apikey=KEY");
  });

  it("returns typed rows", async () => {
    mockFetch(() => [
      { symbol: "AAPL", companyName: "Apple", marketCap: 3e12, sector: "Technology", industry: "X", exchange: "NASDAQ" },
    ]);
    const r = await getScreenerResults({ limit: 10, is_actively_trading: true }, "KEY");
    expect(r).toHaveLength(1);
    expect(r[0].symbol).toBe("AAPL");
    expect(r[0].sector).toBe("Technology");
  });

  it("omits unset filters from query", async () => {
    let captured = "";
    mockFetch((url) => { captured = url; return []; });
    await getScreenerResults({ limit: 100, is_actively_trading: true }, "KEY");
    expect(captured).not.toContain("marketCapMoreThan");
    expect(captured).not.toContain("sector=");
    expect(captured).toContain("limit=100");
  });
});

describe("getCompanyProfile", () => {
  it("fetches and returns profile", async () => {
    mockFetch((url) => {
      expect(url).toContain("/profile/AAPL");
      return [{ symbol: "AAPL", companyName: "Apple", sector: "Technology", industry: "Consumer Electronics", exchange: "NASDAQ" }];
    });
    const p = await getCompanyProfile("AAPL", "KEY");
    expect(p?.sector).toBe("Technology");
  });

  it("returns null when FMP returns empty", async () => {
    mockFetch(() => []);
    expect(await getCompanyProfile("ZZZZZ", "KEY")).toBeNull();
  });

  it("caches successful responses (second call no fetch)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify([{ symbol: "AAPL", sector: "Technology" }]), { status: 200 });
    }) as any;
    await getCompanyProfile("AAPL", "KEY");
    await getCompanyProfile("AAPL", "KEY");
    expect(calls).toBe(1);
  });

  it("case-insensitive ticker (normalizes to upper)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify([{ symbol: "AAPL", sector: "Tech" }]), { status: 200 });
    }) as any;
    await getCompanyProfile("aapl", "KEY");
    await getCompanyProfile("AAPL", "KEY");
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
pnpm test tests/market-universe.test.ts -- --run
```

Expected: FAIL — imported symbols don't exist.

- [ ] **Step 2.3: Append new functions to `src/services/market.service.ts`**

At the end of the file (after `getSp500Constituents`):

```ts
// ── Universe endpoints ───────────────────────────────────────
import type { FmpScreenerFilters } from "../types.js";

export interface ScreenerResult {
  symbol: string;
  companyName?: string;
  marketCap?: number;
  sector?: string;
  industry?: string;
  exchange?: string;
  price?: number;
  beta?: number;
  volume?: number;
  country?: string;
  isEtf?: boolean;
  isFund?: boolean;
  isActivelyTrading?: boolean;
}

export interface CompanyProfile {
  symbol: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  exchange?: string;
  country?: string;
  marketCap?: number;
}

/**
 * Fetch the current Nasdaq 100 constituent list from FMP.
 * Returns [] on error — caller decides fallback behavior.
 */
export async function getNasdaq100Constituents(apiKey: string): Promise<string[]> {
  const url = `${FMP_BASE}/nasdaq_constituent?apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    console.warn(`[market] FMP /nasdaq_constituent returned ${resp.status}`);
    return [];
  }
  const body = (await resp.json()) as Array<{ symbol: string }>;
  if (!Array.isArray(body)) return [];
  return body.map((r) => r.symbol);
}

/**
 * Fetch the current Dow 30 constituent list from FMP.
 * Returns [] on error — caller decides fallback behavior.
 */
export async function getDow30Constituents(apiKey: string): Promise<string[]> {
  const url = `${FMP_BASE}/dowjones_constituent?apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    console.warn(`[market] FMP /dowjones_constituent returned ${resp.status}`);
    return [];
  }
  const body = (await resp.json()) as Array<{ symbol: string }>;
  if (!Array.isArray(body)) return [];
  return body.map((r) => r.symbol);
}

// Translate snake_case filter keys to FMP camelCase query params
const FMP_SCREENER_PARAM_MAP: Record<string, string> = {
  market_cap_min: "marketCapMoreThan",
  market_cap_max: "marketCapLowerThan",
  price_min: "priceMoreThan",
  price_max: "priceLowerThan",
  beta_min: "betaMoreThan",
  beta_max: "betaLowerThan",
  dividend_min: "dividendMoreThan",
  dividend_max: "dividendLowerThan",
  volume_min: "volumeMoreThan",
  volume_max: "volumeLowerThan",
  industry: "industry",
  country: "country",
  is_etf: "isEtf",
  is_fund: "isFund",
  is_actively_trading: "isActivelyTrading",
  include_all_share_classes: "includeAllShareClasses",
  limit: "limit",
};

function buildScreenerQuery(filters: FmpScreenerFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null) continue;
    // Array keys: sector[] and exchange[] — FMP accepts repeated params
    if (Array.isArray(v)) {
      for (const item of v) params.append(k === "sector" ? "sector" : k === "exchange" ? "exchange" : k, String(item));
      continue;
    }
    const fmpKey = FMP_SCREENER_PARAM_MAP[k];
    if (!fmpKey) continue;
    params.append(fmpKey, String(v));
  }
  return params.toString();
}

const FMP_STABLE_BASE = "https://financialmodelingprep.com/stable";

/**
 * Call FMP /stable/company-screener with the given filters.
 * Returns [] on error — caller decides fallback behavior.
 */
export async function getScreenerResults(
  filters: FmpScreenerFilters,
  apiKey: string,
): Promise<ScreenerResult[]> {
  const query = buildScreenerQuery(filters);
  const url = `${FMP_STABLE_BASE}/company-screener?${query}&apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) {
    console.warn(`[market] FMP /company-screener returned ${resp.status}`);
    return [];
  }
  const body = (await resp.json()) as ScreenerResult[];
  if (!Array.isArray(body)) return [];
  return body;
}

// ── Company profile (with LRU cache) ─────────────────────────
// In-memory LRU, size 500, TTL 24h. Shared across the process.
// Used by universe resolver, check_universe tool, and broker gate.

interface CacheEntry { at: number; profile: CompanyProfile | null }
const PROFILE_CACHE_SIZE = 500;
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const profileCache = new Map<string, CacheEntry>();

function getCached(key: string, now: number): CompanyProfile | null | undefined {
  const hit = profileCache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > PROFILE_CACHE_TTL_MS) {
    profileCache.delete(key);
    return undefined;
  }
  // LRU: move to end
  profileCache.delete(key);
  profileCache.set(key, hit);
  return hit.profile;
}

function setCached(key: string, profile: CompanyProfile | null, now: number): void {
  profileCache.set(key, { at: now, profile });
  if (profileCache.size > PROFILE_CACHE_SIZE) {
    const oldest = profileCache.keys().next().value;
    if (oldest) profileCache.delete(oldest);
  }
}

/** For tests only. */
export function _resetProfileCacheForTests(): void {
  profileCache.clear();
}

/**
 * Fetch a company's profile (sector, industry, exchange) from FMP.
 * Cached in-memory for 24h. Returns null when the ticker is unknown.
 */
export async function getCompanyProfile(
  ticker: string,
  apiKey: string,
  opts?: { now?: number },
): Promise<CompanyProfile | null> {
  const key = ticker.toUpperCase();
  const now = opts?.now ?? Date.now();
  const cached = getCached(key, now);
  if (cached !== undefined) return cached;

  const url = `${FMP_BASE}/profile/${key}?apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    console.warn(`[market] FMP /profile/${key} returned ${resp.status}`);
    return null;
  }
  const body = (await resp.json()) as CompanyProfile[];
  const profile = Array.isArray(body) && body.length > 0 ? body[0] : null;
  setCached(key, profile, now);
  return profile;
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
pnpm test tests/market-universe.test.ts -- --run
```

Expected: all tests PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/services/market.service.ts tests/market-universe.test.ts
git commit -m "feat(universe): FMP endpoints — nasdaq100, dow30, company-screener, profile+LRU"
```

---

## Task 3: Universe resolver service

**Files:**
- Create: `src/services/universe.service.ts`
- Modify: `src/paths.ts` (add `universe` to `fundPaths().state`)
- Test: `tests/universe.service.test.ts`

**Goal:** `resolveUniverse()` with cache + fallback chain, `isInUniverse()` for gating, `hashUniverseConfig()` for invalidation.

- [ ] **Step 3.1: Add universe path to `paths.ts`**

In `src/paths.ts`, inside `fundPaths(fundName)` state block, add after `dailySnapshot`:

```ts
      universe: join(root, "state", "universe.json"),
```

- [ ] **Step 3.2: Write failing tests**

Create `tests/universe.service.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
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

function setupFundDir(fundName: string) {
  const state = join(tmp, "funds", fundName, "state");
  require("node:fs").mkdirSync(state, { recursive: true });
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
    globalThis.fetch = fetchMock as any;

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
    globalThis.fetch = fetchMock as any;

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
    }) as any;
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
    }) as any;
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
    }) as any;
    const cfg: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });
    await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 + 1000, force: true });
    expect(calls).toBe(2);
  });

  it("applies include_tickers (added) and exclude_tickers (removed)", async () => {
    setupFundDir("testfund");
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify([{ symbol: "AAPL" }, { symbol: "TSLA" }, { symbol: "MSFT" }]), { status: 200 }),
    ) as any;
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
    ) as any;
    const cfg: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });

    // Now fail FMP, age out TTL
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 500 })) as any;
    const res = await resolveUniverse("testfund", cfg, "KEY", {
      now: 1_000_000 + 25 * 3600 * 1000,
    });
    expect(res.resolved_from).toBe("stale_cache");
    expect(res.count).toBe(1);
  });

  it("falls back to SP500_FALLBACK on FMP failure with no cache", async () => {
    setupFundDir("testfund");
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 500 })) as any;
    const cfg: Universe = { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    const res = await resolveUniverse("testfund", cfg, "KEY", { now: 1_000_000 });
    expect(res.resolved_from).toBe("static_fallback");
    expect(res.count).toBeGreaterThan(0);
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
    ) as any;
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
```

- [ ] **Step 3.3: Run tests to verify they fail**

```bash
pnpm test tests/universe.service.test.ts -- --run
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 3.4: Create the universe service + resolution types**

First, append resolution types to `src/types.ts` (after `universeSchema`):

```ts
export const universeResolutionSchema = z.object({
  resolved_at: z.number().int().positive(),
  config_hash: z.string(),
  resolved_from: z.enum(["fmp", "stale_cache", "static_fallback"]),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preset"), preset: universePresetSchema }),
    z.object({ kind: z.literal("filters") }),
  ]),
  base_tickers: z.array(z.string()),
  final_tickers: z.array(z.string()),
  include_applied: z.array(z.string()),
  exclude_tickers_applied: z.array(z.string()),
  exclude_sectors_applied: z.array(z.string()),
  exclude_tickers_config: z.array(z.string()),
  exclude_sectors_config: z.array(z.string()),
  count: z.number().int().nonnegative(),
});
export type UniverseResolution = z.infer<typeof universeResolutionSchema>;
```

Then create `src/services/universe.service.ts`:

```ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { writeJsonAtomic } from "../state.js";
import { fundPaths } from "../paths.js";
import type { Universe, UniverseResolution } from "../types.js";
import { universeResolutionSchema } from "../types.js";
import {
  getSp500Constituents,
  getNasdaq100Constituents,
  getDow30Constituents,
  getScreenerResults,
  getCompanyProfile,
} from "./market.service.js";
import { SP500_FALLBACK } from "../constants/sp500.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Stable hash of a universe config. Arrays are sorted before hashing. */
export function hashUniverseConfig(u: Universe): string {
  const normalized = {
    preset: u.preset ?? null,
    filters: u.filters ?? null,
    include_tickers: [...u.include_tickers].sort(),
    exclude_tickers: [...u.exclude_tickers].sort(),
    exclude_sectors: [...u.exclude_sectors].sort(),
  };
  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex");
}

export interface InUniverseStatus {
  in_universe: boolean;
  base_match: boolean;
  include_override: boolean;
  exclude_hard_block: boolean;
  exclude_reason?: "ticker" | "sector";
}

/** Check whether a ticker is in a resolved universe, and why. Does not call FMP. */
export function isInUniverse(
  resolution: UniverseResolution,
  ticker: string,
): InUniverseStatus {
  const t = ticker.toUpperCase();
  if (resolution.exclude_tickers_config.includes(t)) {
    return { in_universe: false, base_match: false, include_override: false, exclude_hard_block: true, exclude_reason: "ticker" };
  }
  if (resolution.include_applied.includes(t)) {
    return { in_universe: true, base_match: resolution.base_tickers.includes(t), include_override: true, exclude_hard_block: false };
  }
  const base = resolution.base_tickers.includes(t);
  return { in_universe: base, base_match: base, include_override: false, exclude_hard_block: false };
}

/** Read the cached resolution file. Returns null when missing or malformed. */
export async function readCachedUniverse(fundName: string): Promise<UniverseResolution | null> {
  const p = fundPaths(fundName).state.universe;
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf8");
    return universeResolutionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Normalize exclude_sectors against screener results (sector is available). */
function applyScreenerExcludeSectors(
  screener: { symbol: string; sector?: string }[],
  excludeSectors: string[],
): { kept: string[]; excluded: string[] } {
  if (excludeSectors.length === 0) return { kept: screener.map((r) => r.symbol), excluded: [] };
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const r of screener) {
    if (r.sector && excludeSectors.includes(r.sector)) excluded.push(r.symbol);
    else kept.push(r.symbol);
  }
  return { kept, excluded };
}

/** Apply include/exclude to a base ticker list (for preset mode — no sector data at this layer). */
function applyIncludeExclude(
  base: string[],
  universe: Universe,
): { final: string[]; include_applied: string[]; exclude_tickers_applied: string[] } {
  const excluded: string[] = [];
  const filtered = base.filter((t) => {
    if (universe.exclude_tickers.includes(t)) {
      excluded.push(t);
      return false;
    }
    return true;
  });
  const final = [...filtered];
  const includeApplied: string[] = [];
  for (const t of universe.include_tickers) {
    if (!final.includes(t)) {
      final.push(t);
      includeApplied.push(t);
    }
  }
  return { final, include_applied: includeApplied, exclude_tickers_applied: excluded };
}

async function fetchPreset(preset: string, apiKey: string): Promise<string[]> {
  if (preset === "sp500") return getSp500Constituents(apiKey);
  if (preset === "nasdaq100") return getNasdaq100Constituents(apiKey);
  if (preset === "dow30") return getDow30Constituents(apiKey);
  throw new Error(`Unknown preset: ${preset}`);
}

export interface ResolveOpts {
  force?: boolean;
  now?: number;
  ttlMs?: number;
}

export async function resolveUniverse(
  fundName: string,
  universe: Universe,
  apiKey: string,
  opts: ResolveOpts = {},
): Promise<UniverseResolution> {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const hash = hashUniverseConfig(universe);

  // Cache hit?
  if (!opts.force) {
    const cached = await readCachedUniverse(fundName);
    if (cached && cached.config_hash === hash && now - cached.resolved_at < ttl) {
      return cached;
    }
  }

  // Try FMP
  try {
    if (universe.preset) {
      const base = await fetchPreset(universe.preset, apiKey);
      if (base.length === 0) throw new Error(`Empty FMP response for preset ${universe.preset}`);
      // For preset mode, exclude_sectors enforced at trade-time (see broker gate) — not applied here.
      const { final, include_applied, exclude_tickers_applied } = applyIncludeExclude(base, universe);
      const resolution: UniverseResolution = {
        resolved_at: now,
        config_hash: hash,
        resolved_from: "fmp",
        source: { kind: "preset", preset: universe.preset },
        base_tickers: base,
        final_tickers: final,
        include_applied,
        exclude_tickers_applied,
        exclude_sectors_applied: [],
        exclude_tickers_config: [...universe.exclude_tickers],
        exclude_sectors_config: [...universe.exclude_sectors],
        count: final.length,
      };
      await writeJsonAtomic(fundPaths(fundName).state.universe, resolution);
      return resolution;
    }

    // Filter mode
    if (universe.filters) {
      const screener = await getScreenerResults(universe.filters, apiKey);
      if (screener.length === 0) throw new Error("Empty FMP screener response");
      const { kept, excluded } = applyScreenerExcludeSectors(screener, universe.exclude_sectors);
      const { final, include_applied, exclude_tickers_applied } = applyIncludeExclude(kept, universe);
      const resolution: UniverseResolution = {
        resolved_at: now,
        config_hash: hash,
        resolved_from: "fmp",
        source: { kind: "filters" },
        base_tickers: kept,
        final_tickers: final,
        include_applied,
        exclude_tickers_applied,
        exclude_sectors_applied: excluded,
        exclude_tickers_config: [...universe.exclude_tickers],
        exclude_sectors_config: [...universe.exclude_sectors],
        count: final.length,
      };
      await writeJsonAtomic(fundPaths(fundName).state.universe, resolution);
      return resolution;
    }
  } catch (err) {
    console.warn(`[universe] FMP resolution failed for ${fundName}:`, err instanceof Error ? err.message : err);
  }

  // Fallback 1: stale cache (ignore TTL)
  const stale = await readCachedUniverse(fundName);
  if (stale) {
    return { ...stale, resolved_from: "stale_cache" };
  }

  // Fallback 2: SP500_FALLBACK
  const base = [...SP500_FALLBACK];
  const { final, include_applied, exclude_tickers_applied } = applyIncludeExclude(base, universe);
  return {
    resolved_at: now,
    config_hash: hash,
    resolved_from: "static_fallback",
    source: universe.preset ? { kind: "preset", preset: universe.preset } : { kind: "filters" },
    base_tickers: base,
    final_tickers: final,
    include_applied,
    exclude_tickers_applied,
    exclude_sectors_applied: [],
    exclude_tickers_config: [...universe.exclude_tickers],
    exclude_sectors_config: [...universe.exclude_sectors],
    count: final.length,
  };
}

/** For preset mode, check a ticker's sector against exclude_sectors via profile lookup. */
export async function checkSectorExclusion(
  resolution: UniverseResolution,
  ticker: string,
  apiKey: string,
): Promise<{ excluded: boolean; sector?: string }> {
  if (resolution.exclude_sectors_config.length === 0) return { excluded: false };
  if (resolution.source.kind === "filters") {
    // Filters mode already applied at resolution time; nothing to check here.
    return { excluded: false };
  }
  const profile = await getCompanyProfile(ticker, apiKey);
  if (!profile?.sector) return { excluded: false };
  return {
    excluded: resolution.exclude_sectors_config.includes(profile.sector),
    sector: profile.sector,
  };
}
```

Note: the tests use `process.env.FUNDX_HOME` to redirect the workspace. Check that `src/paths.ts` honors this. If it does not, adjust the test fixture to mock `fundPaths()` with `vi.mock()` instead.

**Fixup required if `FUNDX_HOME` is not honored:** edit `src/paths.ts` line 8:

```ts
export const WORKSPACE = process.env.FUNDX_HOME ?? join(homedir(), ".fundx");
```

And add `FUNDS_DIR` recomputation similarly. If this change is needed, note it in the commit message.

- [ ] **Step 3.5: Run tests to verify they pass**

```bash
pnpm test tests/universe.service.test.ts -- --run
```

Expected: all tests PASS.

- [ ] **Step 3.6: Commit**

```bash
git add src/services/universe.service.ts src/types.ts src/paths.ts tests/universe.service.test.ts
git commit -m "feat(universe): resolver with cache + fallback chain (fmp → stale → static)"
```

---

## Task 4: Universe MCP tools

**Files:**
- Modify: `src/mcp/broker-local.ts` (add two new tools)
- Test: `tests/broker-local-universe.test.ts` (new)

**Goal:** `check_universe` and `list_universe` tools exposed on the broker-local MCP server.

- [ ] **Step 4.1: Write failing tests**

Create `tests/broker-local-universe.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  it("returns exclude_hard_block for TSLA", async () => {
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
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
pnpm test tests/broker-local-universe.test.ts -- --run
```

Expected: FAIL — handlers don't exist.

- [ ] **Step 4.3: Add handlers + tool registration to `src/mcp/broker-local.ts`**

Read the existing file structure first to find where `server.tool(...)` calls are made. Add the following near the other tool registrations:

```ts
import {
  resolveUniverse,
  readCachedUniverse,
  checkSectorExclusion,
  isInUniverse,
} from "../services/universe.service.js";
import { getCompanyProfile } from "../services/market.service.js";
// loadFundConfig helper is imported from fund.service.js (use whatever name the file exports)

// ── Handler: check_universe ───────────────────────────────
export interface CheckUniverseInput { ticker: string }
export interface CheckUniverseDeps {
  resolve: () => Promise<import("../types.js").UniverseResolution>;
  checkSector: (ticker: string) => Promise<{ excluded: boolean; sector?: string }>;
}
export interface CheckUniverseOutput {
  in_universe: boolean;
  base_match: boolean;
  include_override: boolean;
  exclude_hard_block: boolean;
  exclude_reason?: "ticker" | "sector";
  requires_justification: boolean;
  resolved_at: number;
  resolved_from: string;
}

export async function handleCheckUniverse(
  input: CheckUniverseInput,
  deps: CheckUniverseDeps,
): Promise<CheckUniverseOutput> {
  const resolution = await deps.resolve();
  const status = isInUniverse(resolution, input.ticker);
  // Hard block short-circuits sector check
  if (status.exclude_hard_block) {
    return {
      in_universe: false,
      base_match: status.base_match,
      include_override: false,
      exclude_hard_block: true,
      exclude_reason: status.exclude_reason,
      requires_justification: false,
      resolved_at: resolution.resolved_at,
      resolved_from: resolution.resolved_from,
    };
  }
  // Preset mode: check sector exclusion via profile
  const sectorCheck = await deps.checkSector(input.ticker);
  if (sectorCheck.excluded) {
    return {
      in_universe: false,
      base_match: status.base_match,
      include_override: status.include_override,
      exclude_hard_block: true,
      exclude_reason: "sector",
      requires_justification: false,
      resolved_at: resolution.resolved_at,
      resolved_from: resolution.resolved_from,
    };
  }
  return {
    in_universe: status.in_universe,
    base_match: status.base_match,
    include_override: status.include_override,
    exclude_hard_block: false,
    requires_justification: !status.in_universe,
    resolved_at: resolution.resolved_at,
    resolved_from: resolution.resolved_from,
  };
}

// ── Handler: list_universe ────────────────────────────────
export interface ListUniverseInput { sector?: string; limit?: number }
export interface ListUniverseDeps {
  resolve: () => Promise<import("../types.js").UniverseResolution>;
  getProfile: (ticker: string) => Promise<{ sector?: string } | null>;
}
export interface ListUniverseOutput {
  tickers: string[];
  total: number;
  resolved_at: number;
  resolved_from: string;
}

export async function handleListUniverse(
  input: ListUniverseInput,
  deps: ListUniverseDeps,
): Promise<ListUniverseOutput> {
  const resolution = await deps.resolve();
  let tickers = resolution.final_tickers;
  if (input.sector) {
    const matching: string[] = [];
    for (const t of tickers) {
      const p = await deps.getProfile(t);
      if (p?.sector === input.sector) matching.push(t);
    }
    tickers = matching;
  }
  const total = tickers.length;
  if (input.limit && input.limit > 0) tickers = tickers.slice(0, input.limit);
  return {
    tickers,
    total,
    resolved_at: resolution.resolved_at,
    resolved_from: resolution.resolved_from,
  };
}
```

Then register the tools. Find the existing MCP server registration block (look for `server.tool("execute_trade", ...`) and add:

```ts
server.tool(
  "check_universe",
  "Check whether a ticker is in this fund's universe, and why. Returns base_match, include_override, exclude_hard_block, requires_justification.",
  { ticker: z.string().describe("The ticker symbol to check (e.g. 'AAPL')") },
  async (args) => {
    const fundCfg = await loadFundConfig(fundName); // fundName is bound at server init
    const resolve = () => resolveUniverse(fundName, fundCfg.universe, apiKey);
    const checkSector = async (t: string) => {
      const res = await resolve();
      return checkSectorExclusion(res, t, apiKey);
    };
    const r = await handleCheckUniverse({ ticker: args.ticker }, { resolve, checkSector });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

server.tool(
  "list_universe",
  "List this fund's resolved universe tickers. Optionally filter by sector (preset mode performs profile lookups).",
  {
    sector: z.string().optional().describe("Filter to tickers in this sector (e.g. 'Technology')"),
    limit: z.number().int().positive().optional().describe("Max tickers to return"),
  },
  async (args) => {
    const fundCfg = await loadFundConfig(fundName);
    const resolve = () => resolveUniverse(fundName, fundCfg.universe, apiKey);
    const getProfile = (t: string) => getCompanyProfile(t, apiKey);
    const r = await handleListUniverse(args, { resolve, getProfile });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);
```

The exact names `loadFundConfig`, `fundName`, and `apiKey` depend on how the broker-local MCP file is structured today. Read the file first; use the existing patterns. If `apiKey` isn't already available in that scope, load it from global config at server startup (same way existing price fetches work).

- [ ] **Step 4.4: Run tests to verify they pass**

```bash
pnpm test tests/broker-local-universe.test.ts -- --run
```

Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/mcp/broker-local.ts tests/broker-local-universe.test.ts
git commit -m "feat(universe): MCP tools check_universe, list_universe on broker-local"
```

---

## Task 5: Trade execution gating

**Files:**
- Modify: `src/mcp/broker-local.ts` (`execute_trade` handler — add universe gate)
- Modify: `src/journal.ts` (add columns `out_of_universe`, `out_of_universe_reason`)
- Modify: `src/types.ts` (add fields to trade journal schemas)
- Test: `tests/broker-local-gating.test.ts` (new)

**Goal:** `execute_trade` hard-blocks excluded tickers/sectors, soft-gates out-of-universe trades without a reason, accepts with reason and persists the flag+reason in the journal.

- [ ] **Step 5.1: Extend journal schema + migration**

Read `src/journal.ts` to find the SQLite `CREATE TABLE trade_journal` / migration code. Add two columns:

```sql
ALTER TABLE trade_journal ADD COLUMN out_of_universe INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trade_journal ADD COLUMN out_of_universe_reason TEXT;
```

Follow the existing migration pattern in the file (likely a `PRAGMA user_version` + `ALTER TABLE` block). Bump `user_version` by 1. Reference: `src/journal.ts` already has precedent migrations for other columns — match that style.

Update the Zod schema in `src/types.ts` for trade journal rows (search for `journalTradeSchema` or similar):

```ts
// inside the existing trade row schema
out_of_universe: z.boolean().default(false),
out_of_universe_reason: z.string().nullable().default(null),
```

And update the insert helper in `journal.ts` to accept and persist these fields (default false/null).

- [ ] **Step 5.2: Write failing gating tests**

Create `tests/broker-local-gating.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { handleExecuteTrade } from "../src/mcp/broker-local.js";
import type { UniverseResolution } from "../src/types.js";

function mockResolution(): UniverseResolution {
  return {
    resolved_at: 1, config_hash: "h", resolved_from: "fmp",
    source: { kind: "preset", preset: "sp500" },
    base_tickers: ["AAPL", "MSFT"],
    final_tickers: ["AAPL", "MSFT", "TSM"],
    include_applied: ["TSM"],
    exclude_tickers_applied: [],
    exclude_sectors_applied: [],
    exclude_tickers_config: ["TSLA"],
    exclude_sectors_config: ["Energy"],
    count: 3,
  };
}

function baseDeps(overrides: any = {}) {
  return {
    resolve: async () => mockResolution(),
    checkSector: async () => ({ excluded: false }),
    getPrice: async () => 150,
    insertJournal: (row: any) => { recorded.push(row); return 1; },
    updatePortfolio: async () => {},
    readPortfolio: async () => ({ cash: 100_000, positions: {} }),
    ...overrides,
  };
}

const recorded: any[] = [];
beforeEach(() => { recorded.length = 0; });

describe("handleExecuteTrade universe gating", () => {
  it("accepts ticker in universe", async () => {
    const r = await handleExecuteTrade(
      { ticker: "AAPL", side: "buy", quantity: 10, thesis: "strong earnings" },
      baseDeps(),
    );
    expect(r.status).toBe("ok");
    expect(recorded[0].out_of_universe).toBe(false);
  });

  it("hard-blocks ticker in exclude_tickers", async () => {
    const r = await handleExecuteTrade(
      { ticker: "TSLA", side: "buy", quantity: 10, thesis: "x" },
      baseDeps(),
    );
    expect(r.status).toBe("rejected");
    expect(r.code).toBe("UNIVERSE_EXCLUDED");
    expect(recorded).toHaveLength(0);
  });

  it("hard-blocks ticker in exclude_sectors (preset mode)", async () => {
    const r = await handleExecuteTrade(
      { ticker: "XOM", side: "buy", quantity: 10, thesis: "x" },
      baseDeps({ checkSector: async () => ({ excluded: true, sector: "Energy" }) }),
    );
    expect(r.status).toBe("rejected");
    expect(r.code).toBe("UNIVERSE_EXCLUDED");
  });

  it("soft-gates out-of-universe ticker without reason", async () => {
    const r = await handleExecuteTrade(
      { ticker: "ZZZZ", side: "buy", quantity: 10, thesis: "x" },
      baseDeps(),
    );
    expect(r.status).toBe("rejected");
    expect(r.code).toBe("UNIVERSE_SOFT_GATE");
    expect(recorded).toHaveLength(0);
  });

  it("accepts out-of-universe with reason, persists flag", async () => {
    const r = await handleExecuteTrade(
      {
        ticker: "ZZZZ",
        side: "buy",
        quantity: 10,
        thesis: "acquisition target",
        out_of_universe_reason: "Announced acquisition at 40% premium to last close — time-sensitive event-driven trade outside mandate.",
      },
      baseDeps(),
    );
    expect(r.status).toBe("ok");
    expect(recorded[0].out_of_universe).toBe(true);
    expect(recorded[0].out_of_universe_reason).toContain("Announced acquisition");
  });

  it("rejects reason shorter than 20 chars", async () => {
    const r = await handleExecuteTrade(
      { ticker: "ZZZZ", side: "buy", quantity: 10, thesis: "x", out_of_universe_reason: "too short" },
      baseDeps(),
    );
    expect(r.status).toBe("rejected");
    expect(r.code).toBe("UNIVERSE_REASON_TOO_SHORT");
  });

  it("include override: TSM executes as in-universe", async () => {
    const r = await handleExecuteTrade(
      { ticker: "TSM", side: "buy", quantity: 10, thesis: "strong" },
      baseDeps(),
    );
    expect(r.status).toBe("ok");
    expect(recorded[0].out_of_universe).toBe(false);
  });
});
```

- [ ] **Step 5.3: Run tests to verify they fail**

```bash
pnpm test tests/broker-local-gating.test.ts -- --run
```

Expected: FAIL — `handleExecuteTrade` either doesn't exist with this extracted shape, or doesn't enforce the gate.

- [ ] **Step 5.4: Extract + implement `handleExecuteTrade` gating in `src/mcp/broker-local.ts`**

Read the current `execute_trade` tool registration. Extract the business logic into an exported `handleExecuteTrade(input, deps)` function that mirrors the dep-injection pattern used by `handleCheckUniverse`. Then add gating at the top.

```ts
export interface ExecuteTradeInput {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  thesis: string;
  out_of_universe_reason?: string;
}

export interface ExecuteTradeDeps {
  resolve: () => Promise<import("../types.js").UniverseResolution>;
  checkSector: (ticker: string) => Promise<{ excluded: boolean; sector?: string }>;
  getPrice: (ticker: string) => Promise<number>;
  insertJournal: (row: any) => number;
  updatePortfolio: (fn: (p: any) => any) => Promise<void>;
  readPortfolio: () => Promise<any>;
}

export interface ExecuteTradeResult {
  status: "ok" | "rejected";
  code?: "UNIVERSE_EXCLUDED" | "UNIVERSE_SOFT_GATE" | "UNIVERSE_REASON_TOO_SHORT" | "INSUFFICIENT_CASH" | "INVALID_QUANTITY";
  message?: string;
  trade_id?: number;
  fill_price?: number;
}

export async function handleExecuteTrade(
  input: ExecuteTradeInput,
  deps: ExecuteTradeDeps,
): Promise<ExecuteTradeResult> {
  // Basic validation
  if (input.quantity <= 0) {
    return { status: "rejected", code: "INVALID_QUANTITY", message: "quantity must be positive" };
  }

  // Universe gating
  const resolution = await deps.resolve();
  const t = input.ticker.toUpperCase();

  if (resolution.exclude_tickers_config.includes(t)) {
    return {
      status: "rejected",
      code: "UNIVERSE_EXCLUDED",
      message: `${t} is in this fund's exclude_tickers list.`,
    };
  }

  const sectorCheck = await deps.checkSector(t);
  if (sectorCheck.excluded) {
    return {
      status: "rejected",
      code: "UNIVERSE_EXCLUDED",
      message: `${t} is in sector '${sectorCheck.sector}' which is excluded by this fund.`,
    };
  }

  const inBase = resolution.base_tickers.includes(t);
  const isIncluded = resolution.include_applied.includes(t);
  const isInUniv = inBase || isIncluded;

  let outOfUniverse = false;
  let reason: string | null = null;

  if (!isInUniv) {
    const r = input.out_of_universe_reason ?? "";
    if (!r) {
      return {
        status: "rejected",
        code: "UNIVERSE_SOFT_GATE",
        message: `${t} is outside this fund's universe. Pass out_of_universe_reason (>=20 chars) with a time-sensitive thesis to proceed.`,
      };
    }
    if (r.trim().length < 20) {
      return {
        status: "rejected",
        code: "UNIVERSE_REASON_TOO_SHORT",
        message: "out_of_universe_reason must be at least 20 characters.",
      };
    }
    outOfUniverse = true;
    reason = r.trim();
  }

  // Existing execution logic (price fetch, portfolio update, journal insert) continues here.
  // Pass outOfUniverse and reason into insertJournal(row).
  const price = await deps.getPrice(t);
  const portfolio = await deps.readPortfolio();
  // ... (preserve existing cash/position checks)
  const tradeId = deps.insertJournal({
    ticker: t,
    side: input.side,
    quantity: input.quantity,
    price,
    thesis: input.thesis,
    out_of_universe: outOfUniverse,
    out_of_universe_reason: reason,
    // ... other existing journal columns
  });
  await deps.updatePortfolio(/* existing logic */ (p) => p);

  return { status: "ok", trade_id: tradeId, fill_price: price };
}
```

Then update the `server.tool("execute_trade", ...)` registration to add `out_of_universe_reason` to the Zod input schema and call `handleExecuteTrade` with real deps.

**Note:** the existing `execute_trade` has other checks (cash, quantity rounding, stop-loss). Preserve them. The snippet above shows only the universe gating addition. Read the existing handler and splice the gate at the top.

- [ ] **Step 5.5: Run tests (universe gating + existing broker tests)**

```bash
pnpm test tests/broker-local-gating.test.ts tests/broker-local-notify.test.ts -- --run
```

Expected: new gating tests PASS; existing broker tests still PASS.

- [ ] **Step 5.6: Commit**

```bash
git add src/mcp/broker-local.ts src/journal.ts src/types.ts tests/broker-local-gating.test.ts
git commit -m "feat(universe): execute_trade gate — hard/soft, journal flag+reason"
```

---

## Task 6: Screening integration

**Files:**
- Modify: `src/mcp/screener.ts` (read universe from fund config)
- Modify: `src/services/daemon.service.ts` (nightly screen per-fund)
- Modify: `src/commands/screen/run.tsx` (deprecate `--universe` flag)
- Modify: `tests/screener-mcp.test.ts` (update expectations)
- Modify: `tests/screening.test.ts` (no changes if `runScreen` signature unchanged)

**Goal:** Screener uses the per-fund resolved universe, not hardcoded S&P 500.

- [ ] **Step 6.1: Update `src/mcp/screener.ts`**

In `handleScreenRun` (around line 34), replace the deps:

```ts
// Before:
export async function handleScreenRun(
  wdb: Database.Database,
  pcdb: Database.Database,
  args: { screen?: string; universe?: string },
  deps: {
    fetchBars: (ticker: string) => Promise<...>;
    universeTickers: () => Promise<string[]>;
    loadFundConfigs: () => Promise<FundConfig[]>;
    now: () => number;
  },
): Promise<{ summary: ... }> {
  const screen = screenNameSchema.parse(args.screen ?? "momentum-12-1");
  const universeLabel = args.universe ?? "sp500";
  const universe = await deps.universeTickers();
  // ...
}

// After:
export async function handleScreenRun(
  wdb: Database.Database,
  pcdb: Database.Database,
  args: { screen?: string; fund?: string },
  deps: {
    fetchBars: (ticker: string) => Promise<...>;
    resolveFundUniverse: (fundName: string) => Promise<import("../types.js").UniverseResolution>;
    loadFundConfigs: () => Promise<FundConfig[]>;
    now: () => number;
  },
): Promise<{ summary: ... }> {
  const screen = screenNameSchema.parse(args.screen ?? "momentum-12-1");
  const fundConfigs = await deps.loadFundConfigs();
  if (fundConfigs.length === 0) throw new Error("no funds configured");
  const fundName = args.fund ?? fundConfigs[0].fund.name;
  const target = fundConfigs.find((c) => c.fund.name === fundName);
  if (!target) throw new Error(`fund not found: ${fundName}`);
  const resolution = await deps.resolveFundUniverse(fundName);
  const universeLabel = resolution.source.kind === "preset"
    ? `${resolution.source.preset} (${resolution.resolved_from})`
    : `filters (${resolution.resolved_from})`;
  const universe = resolution.final_tickers;
  // ... rest unchanged: pass universe + universeLabel to runScreen
}
```

Update the `server.tool("screen_run", ...)` registration to use the new args shape and wire `resolveFundUniverse` via `resolveUniverse(fundName, cfg.universe, apiKey)`:

```ts
server.tool(
  "screen_run",
  "Run a screen for a specific fund using its configured universe. Updates watchlist with scores and transitions.",
  { screen: z.string().optional(), fund: z.string().optional() },
  async (args) => {
    const res = await handleScreenRun(wdb, pcdb, args, {
      fetchBars: (ticker) => getHistoricalDaily(ticker, 273, apiKey),
      resolveFundUniverse: async (fundName) => {
        const cfg = (await loadAllFundConfigs()).find((c) => c.fund.name === fundName);
        if (!cfg) throw new Error(`fund not found: ${fundName}`);
        return resolveUniverse(fundName, cfg.universe, apiKey);
      },
      loadFundConfigs: loadAllFundConfigs,
      now: () => Date.now(),
    });
    return { content: [{ type: "text", text: JSON.stringify(res.summary, null, 2) }] };
  },
);
```

Remove the now-unused import `getSp500Constituents` at the top.

- [ ] **Step 6.2: Update `src/commands/screen/run.tsx`**

Replace the options schema and command body:

```ts
export const options = z.object({
  screen: screenNameSchema.default("momentum-12-1").describe("Screen name"),
  fund: z.string().describe("Fund name"),
});
type Props = { options: z.infer<typeof options> };

export default function ScreenRun({ options }: Props) {
  // ...
  const universe = await (async () => {
    const cfg = await loadFundConfig(options.fund);
    const resolution = await resolveUniverse(options.fund, cfg.universe, apiKey);
    return { tickers: resolution.final_tickers, label: resolution.source.kind === "preset" ? resolution.source.preset : "filters" };
  })();
  // ... call runScreen with universe.tickers and universe.label
}
```

Remove `getSp500Constituents` import.

- [ ] **Step 6.3: Update `src/services/daemon.service.ts`**

Find the nightly screen block (currently around line 944, hardcoded to sp500). Replace:

```ts
// Before:
const universe = await getSp500Constituents(apiKey);
const fundConfigs = await loadAllFundConfigs();
const summary = await runScreen({
  watchlistDb: wdb,
  priceCacheDb: pcdb,
  universe,
  universeLabel: "sp500",
  fetchBars: (t) => getHistoricalDaily(t, 273, apiKey),
  fundConfigs,
  now: Date.now(),
});

// After: iterate funds, resolve each universe, run screen per fund
const fundConfigs = await loadAllFundConfigs();
for (const cfg of fundConfigs) {
  if (cfg.fund.status !== "active") continue;
  const resolution = await resolveUniverse(cfg.fund.name, cfg.universe, apiKey);
  const universeLabel = resolution.source.kind === "preset"
    ? `${resolution.source.preset} (${resolution.resolved_from})`
    : `filters (${resolution.resolved_from})`;
  await runScreen({
    watchlistDb: wdb,
    priceCacheDb: pcdb,
    universe: resolution.final_tickers,
    universeLabel,
    fetchBars: (t) => getHistoricalDaily(t, 273, apiKey),
    fundConfigs: [cfg],
    now: Date.now(),
  });
}
```

Remove the `getSp500Constituents` import if unused elsewhere in the file.

- [ ] **Step 6.4: Update `tests/screener-mcp.test.ts`**

Update the `handleScreenRun` deps mock to match the new shape: replace `universeTickers` with `resolveFundUniverse`. Example:

```ts
// inside existing test setup
const res = await handleScreenRun(wdb, pcdb, { screen: "momentum-12-1", fund: "testfund" }, {
  fetchBars: async (t) => [/* bars */],
  resolveFundUniverse: async () => ({
    resolved_at: 1, config_hash: "h", resolved_from: "fmp",
    source: { kind: "preset", preset: "sp500" },
    base_tickers: ["AAPL", "MSFT"],
    final_tickers: ["AAPL", "MSFT"],
    include_applied: [], exclude_tickers_applied: [], exclude_sectors_applied: [],
    exclude_tickers_config: [], exclude_sectors_config: [],
    count: 2,
  }),
  loadFundConfigs: async () => [/* fund cfg with universe */],
  now: () => 1,
});
```

Keep assertion structure; only the deps shape changes.

- [ ] **Step 6.5: Run related tests**

```bash
pnpm test tests/screener-mcp.test.ts tests/screening.test.ts tests/daemon-integration.test.ts -- --run
```

Expected: all PASS.

- [ ] **Step 6.6: Commit**

```bash
git add src/mcp/screener.ts src/commands/screen/run.tsx src/services/daemon.service.ts tests/screener-mcp.test.ts
git commit -m "feat(universe): screening uses per-fund resolved universe"
```

---

## Task 7: Prompt integration

**Files:**
- Modify: `src/template.ts` (add "Your Universe" section)
- Modify: `src/services/session.service.ts` (add `<fund_universe>` block)
- Test: `tests/template.test.ts` (update)
- Test: `tests/session.test.ts` (update)

**Goal:** Per-fund CLAUDE.md describes the universe; session prompt carries a small dynamic universe metadata block.

- [ ] **Step 7.1: Add universe section to `src/template.ts`**

In the function that generates per-fund CLAUDE.md (find `generateFundClaudeMd` or similar), add a new section after the objective/risk section:

```ts
function renderUniverseSection(cfg: FundConfig): string {
  const u = cfg.universe;
  const source = u.preset ? `preset **${u.preset}**` : "custom filters";
  const lines: string[] = [
    "## Your Universe",
    "",
    `You focus on tickers defined by ${source}.`,
  ];
  if (u.include_tickers.length > 0) {
    lines.push(`Always-included: ${u.include_tickers.join(", ")}.`);
  }
  if (u.exclude_tickers.length > 0) {
    lines.push(`Excluded tickers (hard block): ${u.exclude_tickers.join(", ")}.`);
  }
  if (u.exclude_sectors.length > 0) {
    lines.push(`Excluded sectors (hard block): ${u.exclude_sectors.join(", ")}.`);
  }
  lines.push(
    "",
    "Before proposing a trade, validate the ticker with the `check_universe` tool.",
    "To explore what's available, use `list_universe` (optionally filtered by sector).",
    "",
    "Trading a ticker outside your universe is allowed but requires passing",
    "`out_of_universe_reason` to `execute_trade` — at least 20 characters,",
    "describing a material, time-sensitive thesis. Excluded tickers and sectors",
    "are hard blocks and cannot be overridden.",
    "",
  );
  return lines.join("\n");
}
```

Call it from the main template renderer — place after the existing risk/objective sections.

- [ ] **Step 7.2: Add `<fund_universe>` block to session prompt**

In `src/services/session.service.ts`, find where the session prompt is assembled (look for the function that builds the context string — usually named `buildSessionPrompt` or inline in the session runner). Add a block after portfolio, before market assessment:

```ts
import { resolveUniverse, readCachedUniverse } from "./universe.service.js";

async function renderUniverseBlock(fundName: string, cfg: FundConfig, apiKey: string): Promise<string> {
  // Prefer cached read (fast, avoids FMP call on every session start)
  let resolution = await readCachedUniverse(fundName);
  if (!resolution) {
    resolution = await resolveUniverse(fundName, cfg.universe, apiKey);
  }
  const source = resolution.source.kind === "preset"
    ? `preset:${resolution.source.preset}`
    : `filters`;
  const freshness = resolution.resolved_from === "fmp"
    ? ""
    : `\n  freshness_warning: resolved from ${resolution.resolved_from} (may be outdated)`;
  const excludedT = resolution.exclude_tickers_config.length
    ? `\n  excluded_tickers: [${resolution.exclude_tickers_config.join(", ")}]`
    : "";
  const excludedS = resolution.exclude_sectors_config.length
    ? `\n  excluded_sectors: [${resolution.exclude_sectors_config.join(", ")}]`
    : "";
  const included = resolution.include_applied.length
    ? `\n  always_included: [${resolution.include_applied.join(", ")}]`
    : "";
  const resolvedAt = new Date(resolution.resolved_at).toISOString();
  return `<fund_universe>
  count: ${resolution.count}
  source: ${source}
  resolved_from: ${resolution.resolved_from}
  resolved_at: ${resolvedAt}${excludedT}${excludedS}${included}${freshness}
</fund_universe>`;
}
```

Insert the result into the prompt assembly where other XML blocks are inserted.

- [ ] **Step 7.3: Update template tests**

In `tests/template.test.ts`, add:

```ts
it("per-fund CLAUDE.md renders Your Universe section with preset", () => {
  const cfg = makeFundConfig({ universe: { preset: "nasdaq100", include_tickers: [], exclude_tickers: ["TSLA"], exclude_sectors: ["Energy"] } });
  const md = generateFundClaudeMd(cfg);
  expect(md).toContain("## Your Universe");
  expect(md).toContain("preset **nasdaq100**");
  expect(md).toContain("Excluded tickers (hard block): TSLA");
  expect(md).toContain("Excluded sectors (hard block): Energy");
  expect(md).toContain("check_universe");
  expect(md).toContain("out_of_universe_reason");
});

it("per-fund CLAUDE.md renders Your Universe section with filters", () => {
  const cfg = makeFundConfig({
    universe: {
      filters: { market_cap_min: 1e10, is_actively_trading: true, limit: 500 },
      include_tickers: ["TSM"],
      exclude_tickers: [],
      exclude_sectors: [],
    },
  });
  const md = generateFundClaudeMd(cfg);
  expect(md).toContain("custom filters");
  expect(md).toContain("Always-included: TSM");
});
```

Adjust `makeFundConfig` helper (or the equivalent factory in the test file) to accept a `universe` override. If it doesn't exist, add a local factory in the test file.

- [ ] **Step 7.4: Update session tests**

In `tests/session.test.ts`, add a test covering the universe block:

```ts
it("session prompt includes <fund_universe> block with resolution metadata", async () => {
  // Mock fund with preset:sp500 universe
  // Mock cached resolution
  // Call the prompt assembly helper
  // Assert output contains "<fund_universe>" with "count:", "source: preset:sp500", "resolved_from: fmp"
});
```

The exact structure depends on the existing test patterns in `session.test.ts` — match them. If the session prompt builder is not directly exported, export it or extract to a helper for testability.

- [ ] **Step 7.5: Run tests**

```bash
pnpm test tests/template.test.ts tests/session.test.ts -- --run
```

Expected: new assertions PASS.

- [ ] **Step 7.6: Commit**

```bash
git add src/template.ts src/services/session.service.ts tests/template.test.ts tests/session.test.ts
git commit -m "feat(universe): per-fund CLAUDE.md section + session prompt <fund_universe> block"
```

---

## Task 8: Skills + subagent updates

**Files:**
- Modify: `src/skills.ts` (`risk-assessment` skill)
- Modify: `src/subagent.ts` (`trade-evaluator` prompt)
- Test: `tests/skills.test.ts` (update)
- Test: `tests/subagent.test.ts` (update)

**Goal:** The agent is reminded how to use universe tools + out_of_universe_reason; `trade-evaluator` applies stricter scrutiny to out-of-universe trades.

- [ ] **Step 8.1: Extend `risk-assessment` skill body in `src/skills.ts`**

Find `BUILTIN_SKILLS` array, entry with `dirName: "risk-assessment"`. Append to its `content`:

```markdown

## Universe awareness

Before calling `execute_trade`, validate the ticker is in your universe via `check_universe`. If `in_universe: false` and `exclude_hard_block: false`, you may proceed by including `out_of_universe_reason` (>= 20 chars, material + time-sensitive) in the trade call. If `exclude_hard_block: true`, do not attempt the trade — excluded tickers and sectors are set by the mandate and cannot be overridden.

Use `list_universe({ sector })` when you need to survey what's available in a particular area of your universe.
```

- [ ] **Step 8.2: Extend `trade-evaluator` subagent prompt in `src/subagent.ts`**

Find the `trade-evaluator` agent definition. Append to its `prompt` field (before the closing Output Format section if one exists):

```
## Universe discipline

If the proposed trade is flagged `out_of_universe=true`, hold the thesis to a higher bar. Out-of-universe trades should have material, time-sensitive rationale that the fund's normal universe cannot capture (event-driven, M&A, cross-listed arbitrage, etc.). Generic quality arguments ("good company", "cheap valuation") are not sufficient — the universe is the fund's mandate and was chosen deliberately.

Weak or vague out-of-universe justifications warrant rejection.
```

- [ ] **Step 8.3: Update skills test**

`tests/skills.test.ts` likely has an assertion on count or content hash of built-in skills. Update expected content snippet to include the new "Universe awareness" text. If the test uses a snapshot, regenerate with `pnpm test -- -u`.

- [ ] **Step 8.4: Update subagent test**

`tests/subagent.test.ts` likely asserts the `trade-evaluator` prompt contains certain phrases. Add an assertion:

```ts
expect(tradeEvaluator.prompt).toContain("out_of_universe");
expect(tradeEvaluator.prompt).toContain("Universe discipline");
```

- [ ] **Step 8.5: Run tests**

```bash
pnpm test tests/skills.test.ts tests/subagent.test.ts -- --run
```

Expected: PASS.

- [ ] **Step 8.6: Commit**

```bash
git add src/skills.ts src/subagent.ts tests/skills.test.ts tests/subagent.test.ts
git commit -m "feat(universe): skill + trade-evaluator aware of out-of-universe discipline"
```

---

## Task 9: CLI commands — show-universe, refresh-universe

**Files:**
- Create: `src/commands/fund/show-universe.tsx`
- Create: `src/commands/fund/refresh-universe.tsx`
- Modify: `src/commands/screen/run.tsx` (reject `--universe` with migration note — already done in Task 6; confirm here)
- Test: `tests/fund.test.ts` (append)

**Goal:** Two new Ink commands for inspecting and refreshing a fund's universe.

- [ ] **Step 9.1: Create `src/commands/fund/show-universe.tsx`**

```tsx
import React from "react";
import { z } from "zod";
import { Box, Text } from "ink";
import { loadFundConfig } from "../../services/fund.service.js";
import { resolveUniverse, readCachedUniverse } from "../../services/universe.service.js";
import { loadGlobalConfig } from "../../config.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { Header } from "../../components/Header.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";

export const description = "Show a fund's resolved universe (source, count, freshness, sample tickers)";
export const args = z.tuple([z.string().describe("Fund name")]);
export const options = z.object({
  limit: z.number().int().positive().default(20).describe("Sample size to print"),
});
type Props = { args: z.infer<typeof args>; options: z.infer<typeof options> };

export default function ShowUniverse({ args: [fundName], options }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const cfg = await loadFundConfig(fundName);
    const gcfg = await loadGlobalConfig();
    const apiKey = gcfg.market_data?.fmp_api_key ?? "";
    // Prefer cache — no network call unless stale or missing
    const cached = await readCachedUniverse(fundName);
    const resolution = cached ?? (await resolveUniverse(fundName, cfg.universe, apiKey));
    return { cfg, resolution };
  });

  if (isLoading) return <Text>Loading universe…</Text>;
  if (error) return <ErrorMessage>{error.message}</ErrorMessage>;
  if (!data) return null;

  const { resolution } = data;
  const ageHours = Math.round((Date.now() - resolution.resolved_at) / 3600_000);
  const source = resolution.source.kind === "preset" ? `preset: ${resolution.source.preset}` : "filters";
  const sample = resolution.final_tickers.slice(0, options.limit).join(", ");

  return (
    <Box flexDirection="column">
      <Header>Universe for {fundName}</Header>
      <Text>Source: {source}</Text>
      <Text>Resolved from: {resolution.resolved_from} ({ageHours}h ago)</Text>
      <Text>Count: {resolution.count}</Text>
      {resolution.exclude_tickers_config.length > 0 && (
        <Text>Excluded tickers: {resolution.exclude_tickers_config.join(", ")}</Text>
      )}
      {resolution.exclude_sectors_config.length > 0 && (
        <Text>Excluded sectors: {resolution.exclude_sectors_config.join(", ")}</Text>
      )}
      {resolution.include_applied.length > 0 && (
        <Text>Always-included: {resolution.include_applied.join(", ")}</Text>
      )}
      <Text> </Text>
      <Text>First {Math.min(options.limit, resolution.final_tickers.length)} tickers:</Text>
      <Text>{sample}</Text>
    </Box>
  );
}
```

- [ ] **Step 9.2: Create `src/commands/fund/refresh-universe.tsx`**

```tsx
import React from "react";
import { z } from "zod";
import { Text } from "ink";
import { loadFundConfig } from "../../services/fund.service.js";
import { resolveUniverse } from "../../services/universe.service.js";
import { loadGlobalConfig } from "../../config.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";

export const description = "Force re-resolution of a fund's universe (bypass cache)";
export const args = z.tuple([z.string().describe("Fund name")]);
type Props = { args: z.infer<typeof args> };

export default function RefreshUniverse({ args: [fundName] }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const cfg = await loadFundConfig(fundName);
    const gcfg = await loadGlobalConfig();
    const apiKey = gcfg.market_data?.fmp_api_key ?? "";
    return resolveUniverse(fundName, cfg.universe, apiKey, { force: true });
  });

  if (isLoading) return <Text>Refreshing universe…</Text>;
  if (error) return <ErrorMessage>{error.message}</ErrorMessage>;
  if (!data) return null;

  return (
    <SuccessMessage>
      Refreshed universe for {fundName}: {data.count} tickers ({data.resolved_from})
    </SuccessMessage>
  );
}
```

- [ ] **Step 9.3: Smoke test — build and run**

```bash
pnpm build
node dist/index.js fund show-universe --help
node dist/index.js fund refresh-universe --help
```

Expected: help text displayed for each command.

Optional live test (requires real fund + FMP key):

```bash
pnpm dev -- fund show-universe <existing-fund>
```

- [ ] **Step 9.4: Commit**

```bash
git add src/commands/fund/show-universe.tsx src/commands/fund/refresh-universe.tsx
git commit -m "feat(universe): CLI commands fund show-universe, refresh-universe"
```

---

## Task 10: Fund create wizard + migration

**Files:**
- Modify: `src/commands/fund/create.tsx` (or `src/services/fund.service.ts` if wizard logic lives there)
- Modify: `src/services/fund.service.ts` (upgrade migration for old universe shape)
- Modify: `src/services/templates.service.ts` (default universe in templates)
- Test: `tests/fund-upgrade.test.ts` (add universe migration test)
- Test: `tests/fund.test.ts` (wizard coverage)

**Goal:** Create-fund wizard offers universe selection; `fund upgrade` migrates old `{allowed,forbidden}` schema to the new one with a `.bak` backup.

- [ ] **Step 10.1: Update templates default universe**

In `src/services/templates.service.ts`, find line ~267 where templates populate `universe: { allowed: [], forbidden: [] }`. Replace with:

```ts
universe: { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] },
```

(All built-in templates default to sp500. Users override in the wizard.)

- [ ] **Step 10.2: Write failing migration test**

In `tests/fund-upgrade.test.ts`, add:

```ts
import { migrateUniverseFromLegacy } from "../src/services/fund.service.js";

describe("migrateUniverseFromLegacy", () => {
  it("maps forbidden tickers/sectors and allowed tickers to new shape", () => {
    const legacy = {
      allowed: [{ type: "stock", tickers: ["TSM", "ASML"] }],
      forbidden: [{ type: "stock", tickers: ["TSLA"], sectors: ["Energy"] }],
    };
    const migrated = migrateUniverseFromLegacy(legacy);
    expect(migrated).toEqual({
      preset: "sp500",
      include_tickers: ["TSM", "ASML"],
      exclude_tickers: ["TSLA"],
      exclude_sectors: ["Energy"],
    });
  });

  it("handles empty allowed/forbidden", () => {
    const migrated = migrateUniverseFromLegacy({ allowed: [], forbidden: [] });
    expect(migrated).toEqual({
      preset: "sp500",
      include_tickers: [],
      exclude_tickers: [],
      exclude_sectors: [],
    });
  });

  it("drops strategies/protocols with warning (returns warnings array)", () => {
    const legacy = {
      allowed: [{ type: "defi", strategies: ["yield-farm"], protocols: ["Aave"] }],
      forbidden: [],
    };
    const migrated = migrateUniverseFromLegacy(legacy);
    expect(migrated.include_tickers).toEqual([]);
    // strategies/protocols silently dropped at this layer; caller logs the warning
  });

  it("detects legacy shape via presence of allowed or forbidden keys", () => {
    const { isLegacyUniverse } = require("../src/services/fund.service.js");
    expect(isLegacyUniverse({ allowed: [], forbidden: [] })).toBe(true);
    expect(isLegacyUniverse({ preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] })).toBe(false);
  });
});
```

- [ ] **Step 10.3: Implement migration in `src/services/fund.service.ts`**

Add exports:

```ts
export function isLegacyUniverse(u: unknown): boolean {
  if (typeof u !== "object" || u === null) return false;
  return "allowed" in u || "forbidden" in u;
}

type LegacyAssetEntry = {
  type?: string;
  tickers?: string[];
  sectors?: string[];
  strategies?: string[];
  protocols?: string[];
};
type LegacyUniverse = { allowed?: LegacyAssetEntry[]; forbidden?: LegacyAssetEntry[] };

export function migrateUniverseFromLegacy(legacy: LegacyUniverse): {
  preset: "sp500";
  include_tickers: string[];
  exclude_tickers: string[];
  exclude_sectors: string[];
} {
  const include = new Set<string>();
  const excludeT = new Set<string>();
  const excludeS = new Set<string>();
  for (const e of legacy.allowed ?? []) {
    for (const t of e.tickers ?? []) include.add(t.toUpperCase());
    // allowed.sectors semantics were ambiguous — drop with no action; log separately
  }
  for (const e of legacy.forbidden ?? []) {
    for (const t of e.tickers ?? []) excludeT.add(t.toUpperCase());
    for (const s of e.sectors ?? []) excludeS.add(s);
  }
  return {
    preset: "sp500",
    include_tickers: [...include].sort(),
    exclude_tickers: [...excludeT].sort(),
    exclude_sectors: [...excludeS].sort(),
  };
}
```

Wire into the `fund upgrade` flow — find the function that reads and rewrites `fund_config.yaml` on upgrade (likely `upgradeFund` in `fund.service.ts`). Before parsing with the new Zod schema, check the raw YAML for legacy shape, migrate, write a `.bak` of the original, then re-serialize:

```ts
import { copyFile } from "node:fs/promises";

async function maybeMigrateUniverse(configPath: string, rawConfig: any): Promise<{ migrated: boolean; warnings: string[] }> {
  if (!isLegacyUniverse(rawConfig.universe)) return { migrated: false, warnings: [] };
  await copyFile(configPath, `${configPath}.bak`);
  const warnings: string[] = [];
  const legacy = rawConfig.universe as LegacyUniverse;
  // Warn about dropped strategies/protocols
  const hasDropped = (legacy.allowed ?? []).some((e) => (e.strategies?.length ?? 0) + (e.protocols?.length ?? 0) > 0)
    || (legacy.forbidden ?? []).some((e) => (e.strategies?.length ?? 0) + (e.protocols?.length ?? 0) > 0);
  if (hasDropped) warnings.push("Dropped unsupported fields (strategies, protocols) — these were not enforced in the old schema either.");
  const hasAllowedSectors = (legacy.allowed ?? []).some((e) => (e.sectors?.length ?? 0) > 0);
  if (hasAllowedSectors) warnings.push("Old 'allowed sectors' dropped (ambiguous semantics). Review your new universe block and add a `filters.sector` block if you want to restrict to specific sectors.");
  rawConfig.universe = migrateUniverseFromLegacy(legacy);
  return { migrated: true, warnings };
}
```

Call this from the existing `upgradeFund` function after loading YAML, before writing. Surface warnings to the CLI output.

- [ ] **Step 10.4: Run migration tests**

```bash
pnpm test tests/fund-upgrade.test.ts -- --run
```

Expected: PASS.

- [ ] **Step 10.5: Update `fund create` wizard**

Find the wizard in `src/commands/fund/create.tsx` (or wherever the multi-step Ink wizard lives). Add a universe step between the risk step and the confirmation step:

```tsx
// Step: Universe selection
const universeOptions = [
  { label: "S&P 500 (canonical index)", value: "sp500" },
  { label: "Nasdaq 100 (canonical index)", value: "nasdaq100" },
  { label: "Dow 30 (canonical index)", value: "dow30" },
  { label: "US Large Cap ($10B+) — editable filters", value: "tmpl-large" },
  { label: "US Mid Cap ($2B-$10B) — editable filters", value: "tmpl-mid" },
  { label: "Custom filters (advanced)", value: "custom" },
];

// When the user picks an option, map to universe block:
function resolveWizardUniverseChoice(choice: string): import("../types.js").Universe {
  switch (choice) {
    case "sp500":
    case "nasdaq100":
    case "dow30":
      return { preset: choice as any, include_tickers: [], exclude_tickers: [], exclude_sectors: [] };
    case "tmpl-large":
      return {
        filters: {
          market_cap_min: 10_000_000_000,
          exchange: ["NYSE", "NASDAQ"] as any,
          country: "US",
          is_actively_trading: true,
          limit: 500,
        },
        include_tickers: [], exclude_tickers: [], exclude_sectors: [],
      };
    case "tmpl-mid":
      return {
        filters: {
          market_cap_min: 2_000_000_000,
          market_cap_max: 10_000_000_000,
          exchange: ["NYSE", "NASDAQ"] as any,
          country: "US",
          is_actively_trading: true,
          limit: 500,
        },
        include_tickers: [], exclude_tickers: [], exclude_sectors: [],
      };
    case "custom":
    default:
      return {
        filters: { is_actively_trading: true, limit: 500 },
        include_tickers: [], exclude_tickers: [], exclude_sectors: [],
      };
  }
}
```

Integrate with the wizard's existing state machine (each step writes its value into the in-progress fund config). Follow the existing pattern — this step is a single `Select` from `@inkjs/ui`.

- [ ] **Step 10.6: Add wizard smoke test**

In `tests/fund.test.ts`, add a test that calls the wizard resolver function directly:

```ts
import { resolveWizardUniverseChoice } from "../src/commands/fund/create.js";

describe("resolveWizardUniverseChoice", () => {
  it("sp500 → preset", () => {
    expect(resolveWizardUniverseChoice("sp500")).toEqual({
      preset: "sp500",
      include_tickers: [], exclude_tickers: [], exclude_sectors: [],
    });
  });

  it("tmpl-large → filters with market_cap_min 10B", () => {
    const u = resolveWizardUniverseChoice("tmpl-large");
    expect(u.filters?.market_cap_min).toBe(10_000_000_000);
    expect(u.filters?.exchange).toEqual(["NYSE", "NASDAQ"]);
  });

  it("tmpl-mid → filters with market_cap_max 10B", () => {
    const u = resolveWizardUniverseChoice("tmpl-mid");
    expect(u.filters?.market_cap_max).toBe(10_000_000_000);
    expect(u.filters?.market_cap_min).toBe(2_000_000_000);
  });
});
```

Export `resolveWizardUniverseChoice` from `create.tsx` so the test can import it.

- [ ] **Step 10.7: Run all tests + typecheck**

```bash
pnpm test -- --run
pnpm typecheck
```

Expected: all tests PASS; typecheck clean (no references to old `universe.allowed` / `universe.forbidden` remaining).

If typecheck still shows errors from early tasks' known-temporarily-broken files (e.g., `ask.service.ts`, `status.service.ts`, `subagent.ts`), fix them now by mapping old field reads to the new schema. These should be mechanical replacements (`cfg.universe.allowed` → `cfg.universe.include_tickers` or drop if not meaningful under the new model).

- [ ] **Step 10.8: Commit**

```bash
git add src/commands/fund/create.tsx src/services/fund.service.ts src/services/templates.service.ts tests/fund-upgrade.test.ts tests/fund.test.ts
git commit -m "feat(universe): fund create wizard + upgrade migration from legacy schema"
```

---

## Final verification

- [ ] **Run the full test suite**

```bash
pnpm test -- --run
pnpm typecheck
pnpm lint
```

Expected: all green.

- [ ] **End-to-end smoke test**

```bash
# In a scratch workspace (set FUNDX_HOME to a temp dir)
export FUNDX_HOME=$(mktemp -d)
pnpm build
node dist/index.js init
node dist/index.js fund create  # exercise wizard, pick nasdaq100
node dist/index.js fund show-universe <fund-name>
node dist/index.js fund refresh-universe <fund-name>
node dist/index.js screen run --fund <fund-name>
```

Verify that `~/.fundx_or_temp/funds/<name>/state/universe.json` exists and contains the resolved tickers.

- [ ] **Manual verification: legacy fund upgrade**

Write a legacy `fund_config.yaml` by hand with `universe: { allowed: [...], forbidden: [...] }`, then run `fundx fund upgrade --name <fund>`. Verify:
- `.bak` file exists
- New config has `universe.preset: sp500` + migrated include/exclude
- Warnings printed if old config had `strategies`/`protocols`/`allowed.sectors`

- [ ] **Merge**

If working in a worktree, merge back to the main branch. Otherwise the work is already on the main branch via the per-task commits.

---

## Notes for the executing engineer

- **Stop and ask** if any file structure assumption in this plan doesn't match reality (e.g., `src/mcp/broker-local.ts` may have been restructured since this plan was written, or wizard steps may live in a different file).
- **Preserve existing behavior.** The `execute_trade` handler and the nightly screen run have non-universe logic (cash checks, stop-loss sync, notifications). Task 5 and Task 6 show only the universe additions — splice carefully; do not rewrite.
- **Zod runtime order matters.** The new `universeSchema` uses `.refine()` — ensure it's attached *after* `.default()` calls and before `.parse()` consumption elsewhere.
- **Profile cache is process-scoped.** MCP servers run per-session (spawned subprocess), so cache warms per-session. That's acceptable — the cache primarily serves within-session reuse.
- **Don't commit FMP API keys or real fund fixtures.** Test fixtures should be synthetic.
