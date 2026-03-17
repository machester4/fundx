# Simply Wall St Integration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Simply Wall St's GraphQL API into FundX as an optional data source with browser-based auth, a dedicated MCP server, and portfolio snowflake score enrichment.

**Architecture:** New dedicated MCP server (`src/mcp/sws.ts`) + CLI-side service (`src/services/sws.service.ts`). Auth via `puppeteer-core` capturing JWT from Chrome. Token stored in `~/.fundx/config.yaml`. MCP server and service are independent (no imports between them).

**Tech Stack:** TypeScript, puppeteer-core, GraphQL (fetch-based), Zod, Ink/React CLI, MCP SDK

**Spec:** `docs/superpowers/specs/2026-03-17-sws-integration-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|---|---|
| `src/services/sws.service.ts` | CLI-side: Chrome discovery, puppeteer login flow, GraphQL client, token management, portfolio enrichment |
| `src/mcp/sws.ts` | Standalone MCP server: 6 tools for Claude sessions, own GraphQL client, TTL cache |
| `src/commands/sws/login.tsx` | `fundx sws login` — thin Ink component calling `swsLogin()` |
| `src/commands/sws/status.tsx` | `fundx sws status` — displays token validity |
| `src/commands/sws/logout.tsx` | `fundx sws logout` — calls `swsLogout()` |
| `src/components/SnowflakeScores.tsx` | Color-coded V/F/H/P/D score display component |
| `tests/sws.test.ts` | Tests for service + types |

### Modified Files
| File | Change |
|---|---|
| `src/types.ts` | Add SWS Zod schemas to the global config + SWS data types |
| `src/paths.ts` | Add `MCP_SERVERS.sws` path constant |
| `src/agent.ts` | Add conditional SWS server in `buildMcpServers()` |
| `src/services/chat.service.ts` | Add conditional SWS server in `buildChatMcpServers()` |
| `src/services/index.ts` | Re-export `sws.service.ts` |
| `src/commands/portfolio.tsx` | Enrich positions with snowflake scores |
| `src/context/AppContext.tsx` | SWS token expiry warning |
| `src/services/daemon.service.ts` | Daily token expiration check at 09:00 |
| `tsup.config.ts` | Add `src/mcp/sws.ts` to MCP build entry |
| `package.json` | Add `puppeteer-core` dependency |

---

## Task 1: Zod schemas + types + dependency

**Files:**
- Modify: `src/types.ts:162-187` (globalConfigSchema) and append SWS schemas after line 509
- Modify: `package.json`
- Test: `tests/sws.test.ts`

- [ ] **Step 1: Install puppeteer-core**

```bash
pnpm add puppeteer-core
```

- [ ] **Step 2: Write the failing test for SWS schemas**

Create `tests/sws.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  globalConfigSchema,
  swsSnowflakeSchema,
  swsCompanySchema,
  swsScreenerResultSchema,
} from "../src/types.js";

describe("SWS Config Schema", () => {
  it("accepts config without sws key", () => {
    const result = globalConfigSchema.parse({});
    expect(result.sws).toBeUndefined();
  });

  it("accepts config with sws token", () => {
    const result = globalConfigSchema.parse({
      sws: {
        auth_token: "eyJ0eXAi...",
        token_expires_at: "2026-01-21T14:13:27.000Z",
      },
    });
    expect(result.sws?.auth_token).toBe("eyJ0eXAi...");
    expect(result.sws?.token_expires_at).toBe("2026-01-21T14:13:27.000Z");
  });

  it("accepts sws with only partial fields", () => {
    const result = globalConfigSchema.parse({
      sws: { auth_token: "token123" },
    });
    expect(result.sws?.auth_token).toBe("token123");
    expect(result.sws?.token_expires_at).toBeUndefined();
  });
});

describe("SWS Snowflake Schema", () => {
  it("validates valid snowflake scores", () => {
    const result = swsSnowflakeSchema.parse({
      value: 5, future: 4, health: 6, past: 3, dividend: 2,
    });
    expect(result.value).toBe(5);
  });
});

describe("SWS Company Schema", () => {
  it("validates a full company object", () => {
    const company = {
      id: 12345,
      name: "Apple Inc.",
      tickerSymbol: "AAPL",
      uniqueSymbol: "NasdaqGS:AAPL",
      exchangeSymbol: "NasdaqGS",
      score: { value: 4, future: 5, health: 6, past: 5, dividend: 3 },
      primaryIndustry: { id: 1, name: "Consumer Electronics", slug: "consumer-electronics" },
    };
    const result = swsCompanySchema.parse(company);
    expect(result.uniqueSymbol).toBe("NasdaqGS:AAPL");
  });
});

describe("SWS Screener Result Schema", () => {
  it("validates a screener result", () => {
    const result = swsScreenerResultSchema.parse({
      totalHits: 100,
      companies: [],
    });
    expect(result.totalHits).toBe(100);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- tests/sws.test.ts`
Expected: FAIL — imports don't exist yet

- [ ] **Step 4: Add SWS config to globalConfigSchema**

In `src/types.ts`, add inside `globalConfigSchema` (after the `market_data` field, before the closing `});`):

```typescript
  sws: z
    .object({
      auth_token: z.string().optional(),
      token_expires_at: z.string().optional(),
    })
    .optional(),
```

- [ ] **Step 5: Add SWS data schemas**

Append to `src/types.ts` after the last schema (after line 509):

```typescript
// ── SWS (Simply Wall St) Schemas ──────────────────────────────

export const swsSnowflakeSchema = z.object({
  value: z.number(),
  future: z.number(),
  health: z.number(),
  past: z.number(),
  dividend: z.number(),
});

export type SwsSnowflake = z.infer<typeof swsSnowflakeSchema>;

export const swsCompanySchema = z.object({
  id: z.number(),
  name: z.string(),
  tickerSymbol: z.string(),
  uniqueSymbol: z.string(),
  exchangeSymbol: z.string(),
  score: swsSnowflakeSchema,
  primaryIndustry: z.object({
    id: z.number(),
    name: z.string(),
    slug: z.string(),
  }),
  analysisValue: z.object({
    return1d: z.number().nullable().optional(),
    return7d: z.number().nullable().optional(),
    return1yAbs: z.number().nullable().optional(),
    marketCap: z.number().nullable().optional(),
    lastSharePrice: z.number().nullable().optional(),
    priceTarget: z.number().nullable().optional(),
    pe: z.number().nullable().optional(),
    pb: z.number().nullable().optional(),
    priceToSales: z.number().nullable().optional(),
  }).optional(),
  analysisFuture: z.object({
    netIncomeGrowth3Y: z.number().nullable().optional(),
    netIncomeGrowthAnnual: z.number().nullable().optional(),
    revenueGrowthAnnual: z.number().nullable().optional(),
  }).optional(),
  analysisDividend: z.object({
    dividendYield: z.number().nullable().optional(),
  }).optional(),
  analysisMisc: z.object({
    analystCount: z.number().nullable().optional(),
  }).optional(),
  info: z.object({
    shortDescription: z.string().nullable().optional(),
    logoUrl: z.string().nullable().optional(),
    yearFounded: z.number().nullable().optional(),
  }).optional(),
});

export type SwsCompany = z.infer<typeof swsCompanySchema>;

export const swsScreenerResultSchema = z.object({
  totalHits: z.number(),
  companies: z.array(swsCompanySchema).default([]),
});

export type SwsScreenerResult = z.infer<typeof swsScreenerResultSchema>;

export const swsSearchResultSchema = z.object({
  id: z.number(),
  name: z.string(),
  tickerSymbol: z.string(),
  uniqueSymbol: z.string(),
  exchangeSymbol: z.string(),
  score: swsSnowflakeSchema.optional(),
});

export type SwsSearchResult = z.infer<typeof swsSearchResultSchema>;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- tests/sws.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 7: Commit**

```bash
git add src/types.ts tests/sws.test.ts package.json pnpm-lock.yaml
git commit -m "feat(sws): add Zod schemas and puppeteer-core dependency"
```

---

## Task 2: Path registration + build config

**Files:**
- Modify: `src/paths.ts:44-48` (MCP_SERVERS object)
- Modify: `tsup.config.ts:14-18` (MCP entry array)

- [ ] **Step 1: Add SWS to MCP_SERVERS in paths.ts**

In `src/paths.ts`, add inside the `MCP_SERVERS` object after the `telegramNotify` entry:

```typescript
  sws: join(__dirname, "mcp", IS_DEV ? "sws.ts" : "sws.js"),
```

- [ ] **Step 2: Add SWS to tsup build config**

In `tsup.config.ts`, add to the MCP entry array (after `"src/mcp/telegram-notify.ts"`):

```typescript
      "src/mcp/sws.ts",
```

- [ ] **Step 3: Run typecheck to verify**

Run: `pnpm typecheck`
Expected: PASS (sws.ts doesn't exist yet but paths.ts is just a string constant)

- [ ] **Step 4: Commit**

```bash
git add src/paths.ts tsup.config.ts
git commit -m "feat(sws): register MCP server path and build entry"
```

---

## Task 3: SWS service — auth functions

**Files:**
- Create: `src/services/sws.service.ts`
- Modify: `src/services/index.ts`
- Test: `tests/sws.test.ts` (append)

- [ ] **Step 1: Write failing tests for auth functions**

Append to `tests/sws.test.ts`:

```typescript
// Mock modules for service tests
vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn(),
  saveGlobalConfig: vi.fn(),
}));

describe("SWS Service — Token Status", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns invalid when no token configured", async () => {
    const { loadGlobalConfig } = await import("../src/config.js");
    vi.mocked(loadGlobalConfig).mockResolvedValue({
      default_model: "sonnet",
      timezone: "UTC",
      broker: { provider: "manual", mode: "paper" as const },
      telegram: { enabled: false },
      market_data: { provider: "fmp" as const },
    });

    const { swsTokenStatus } = await import("../src/services/sws.service.js");
    const status = await swsTokenStatus();
    expect(status.valid).toBe(false);
    expect(status.expiresAt).toBeNull();
  });

  it("returns valid when token exists and not expired", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { loadGlobalConfig } = await import("../src/config.js");
    vi.mocked(loadGlobalConfig).mockResolvedValue({
      default_model: "sonnet",
      timezone: "UTC",
      broker: { provider: "manual", mode: "paper" as const },
      telegram: { enabled: false },
      market_data: { provider: "fmp" as const },
      sws: { auth_token: "test-token", token_expires_at: futureDate },
    });

    const { swsTokenStatus } = await import("../src/services/sws.service.js");
    const status = await swsTokenStatus();
    expect(status.valid).toBe(true);
    expect(status.expiresInHours).toBeGreaterThan(0);
  });

  it("returns invalid when token is expired", async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const { loadGlobalConfig } = await import("../src/config.js");
    vi.mocked(loadGlobalConfig).mockResolvedValue({
      default_model: "sonnet",
      timezone: "UTC",
      broker: { provider: "manual", mode: "paper" as const },
      telegram: { enabled: false },
      market_data: { provider: "fmp" as const },
      sws: { auth_token: "test-token", token_expires_at: pastDate },
    });

    const { swsTokenStatus } = await import("../src/services/sws.service.js");
    const status = await swsTokenStatus();
    expect(status.valid).toBe(false);
  });
});

describe("SWS Service — Logout", () => {
  it("removes sws key from config", async () => {
    const { loadGlobalConfig, saveGlobalConfig } = await import("../src/config.js");
    const mockConfig = {
      default_model: "sonnet",
      timezone: "UTC",
      broker: { provider: "manual", mode: "paper" as const },
      telegram: { enabled: false },
      market_data: { provider: "fmp" as const },
      sws: { auth_token: "test-token", token_expires_at: "2026-01-21T00:00:00Z" },
    };
    vi.mocked(loadGlobalConfig).mockResolvedValue(mockConfig);
    vi.mocked(saveGlobalConfig).mockResolvedValue(undefined);

    const { swsLogout } = await import("../src/services/sws.service.js");
    await swsLogout();

    expect(saveGlobalConfig).toHaveBeenCalledWith(
      expect.not.objectContaining({ sws: expect.anything() }),
    );
  });
});

describe("SWS Service — Chrome Discovery", () => {
  it("finds Chrome path from CHROME_PATH env var", async () => {
    const origEnv = process.env.CHROME_PATH;
    process.env.CHROME_PATH = "/fake/chrome";

    const { findChromePath } = await import("../src/services/sws.service.js");
    // With CHROME_PATH set, it should return it (regardless of existence for the env var path)
    const path = findChromePath();
    expect(path).toBe("/fake/chrome");

    if (origEnv === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = origEnv;
  });
});

describe("SWS Service — Screener Registry", () => {
  it("lists available screeners", async () => {
    const { swsListScreeners } = await import("../src/services/sws.service.js");
    const screeners = swsListScreeners();
    expect(screeners.length).toBeGreaterThan(0);
    expect(screeners[0]).toHaveProperty("slug");
    expect(screeners[0]).toHaveProperty("id");
    expect(screeners[0]).toHaveProperty("description");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/sws.test.ts`
Expected: FAIL — `sws.service.js` doesn't exist

- [ ] **Step 3: Create sws.service.ts with auth + screener registry**

Create `src/services/sws.service.ts`:

```typescript
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { loadGlobalConfig, saveGlobalConfig } from "../config.js";
import type { GlobalConfig, SwsSnowflake, SwsScreenerResult, SwsSearchResult, SwsCompany } from "../types.js";
import { swsScreenerResultSchema, swsSnowflakeSchema, swsCompanySchema } from "../types.js";
import { z } from "zod";

// ── Constants ───────────────────────────────────────────────

const SWS_GRAPHQL_URL = "https://simplywall.st/graphql";

const SWS_HEADERS = {
  "accept": "*/*",
  "apollographql-client-name": "web",
  "content-type": "application/json",
};

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

const SWS_SCREENERS: Record<string, { id: number; description: string }> = {
  "undiscovered-gems":  { id: 152, description: "Undiscovered gems with strong fundamentals" },
  "high-growth-tech":   { id: 148, description: "High growth tech stocks" },
  "dividend-champions": { id: 155, description: "Reliable dividend payers" },
  "undervalued-large":  { id: 142, description: "Undervalued large caps" },
};

// ── Errors ──────────────────────────────────────────────────

export class SwsTokenExpiredError extends Error {
  constructor() {
    super("SWS token expired. Run `fundx sws login` to renew.");
    this.name = "SwsTokenExpiredError";
  }
}

export class SwsNotConfiguredError extends Error {
  constructor() {
    super("SWS not configured. Run `fundx sws login` to authenticate.");
    this.name = "SwsNotConfiguredError";
  }
}

// ── Chrome Discovery ────────────────────────────────────────

export function findChromePath(): string | null {
  const envPath = process.env.CHROME_PATH;
  if (envPath) return envPath;

  const paths = CHROME_PATHS[platform()] ?? [];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ── JWT Helpers ─────────────────────────────────────────────

function decodeJwtExp(token: string): Date | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    if (typeof payload.exp !== "number") return null;
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

// ── Token Management ────────────────────────────────────────

export async function swsTokenStatus(): Promise<{
  valid: boolean;
  expiresAt: string | null;
  expiresInHours: number | null;
}> {
  const config = await loadGlobalConfig();
  const token = config.sws?.auth_token;
  const expiresAt = config.sws?.token_expires_at;

  if (!token || !expiresAt) {
    return { valid: false, expiresAt: null, expiresInHours: null };
  }

  const expiryDate = new Date(expiresAt);
  const now = new Date();
  const hoursLeft = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60);

  return {
    valid: hoursLeft > 0,
    expiresAt,
    expiresInHours: Math.max(0, hoursLeft),
  };
}

export async function swsLogin(): Promise<{ token: string; expiresAt: string }> {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error("Chrome not found. Set CHROME_PATH environment variable or install Chrome.");
  }

  const puppeteer = await import("puppeteer-core");
  const browser = await puppeteer.default.launch({
    executablePath: chromePath,
    headless: false,
    args: ["--no-first-run", "--no-default-browser-check"],
  });

  let disconnected = false;
  browser.on("disconnected", () => { disconnected = true; });

  try {
    const page = await browser.newPage();
    await page.goto("https://simplywall.st/login", { waitUntil: "networkidle2" });

    const startTime = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const POLL_MS = 1000;

    while (true) {
      if (disconnected) {
        throw new Error("Browser closed before login completed.");
      }
      if (Date.now() - startTime > TIMEOUT_MS) {
        throw new Error("Login timed out — try again.");
      }

      const cookies = await page.cookies("https://simplywall.st");
      const authCookie = cookies.find((c) => c.name === "auth");
      if (authCookie) {
        // Cookie value may be URL-encoded and contain |suffix — extract JWT part
        const decoded = decodeURIComponent(authCookie.value);
        const jwtPart = decoded.split("|")[0];
        const expiryDate = decodeJwtExp(jwtPart);
        if (!expiryDate) {
          throw new Error("Failed to decode JWT expiration from auth cookie.");
        }

        const expiresAt = expiryDate.toISOString();
        const config = await loadGlobalConfig();
        config.sws = { auth_token: jwtPart, token_expires_at: expiresAt };
        await saveGlobalConfig(config);

        return { token: jwtPart, expiresAt };
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    if (!disconnected) {
      await browser.close().catch(() => {});
    }
  }
}

export async function swsLogout(): Promise<void> {
  const config = await loadGlobalConfig();
  delete config.sws;
  await saveGlobalConfig(config);
}

// ── Screener Registry ───────────────────────────────────────

export interface SwsScreenerInfo {
  slug: string;
  id: number;
  description: string;
}

export function swsListScreeners(): SwsScreenerInfo[] {
  return Object.entries(SWS_SCREENERS).map(([slug, info]) => ({
    slug,
    ...info,
  }));
}

// ── GraphQL Client (CLI-side) ───────────────────────────────

async function getSwsToken(): Promise<string> {
  const config = await loadGlobalConfig();
  const token = config.sws?.auth_token;
  if (!token) throw new SwsNotConfiguredError();

  const expiresAt = config.sws?.token_expires_at;
  if (expiresAt && new Date(expiresAt) <= new Date()) {
    throw new SwsTokenExpiredError();
  }
  return token;
}

async function swsGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const token = await getSwsToken();
  const resp = await fetch(SWS_GRAPHQL_URL, {
    method: "POST",
    headers: { ...SWS_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(5000),
  });

  if (!resp.ok) {
    throw new Error(`SWS API error ${resp.status}: ${await resp.text()}`);
  }

  const json = (await resp.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`SWS GraphQL error: ${json.errors[0].message}`);
  }
  return schema.parse(json.data);
}

// ── GraphQL Queries ─────────────────────────────────────────

const SCREENER_QUERY = `
query InvestingIdeasStocks($gridViewId: Float!, $limit: Int!, $offset: Int!, $displayRecentlyAddedCompanies: Boolean!, $returnRecentCompaniesOnly: Boolean!, $additionalFilters: [AdditionalScreenerFilter!]) {
  companyPredefinedScreenerResults(
    input: {limit: $limit, offset: $offset, gridViewId: $gridViewId, displayRecentlyAddedCompanies: $displayRecentlyAddedCompanies, returnRecentCompaniesOnly: $returnRecentCompaniesOnly, additionalFilters: $additionalFilters}
  ) {
    totalHits
    companies {
      id name tickerSymbol uniqueSymbol exchangeSymbol
      primaryIndustry { id slug name }
      score { dividend future health past value }
      analysisValue { return1d return7d return1yAbs marketCap lastSharePrice priceTarget pe pb priceToSales }
      analysisFuture { netIncomeGrowth3Y netIncomeGrowthAnnual revenueGrowthAnnual }
      analysisDividend { dividendYield }
      analysisMisc { analystCount }
      info { shortDescription logoUrl yearFounded }
    }
  }
}`;

const SEARCH_QUERY = `
query SearchCompanies($query: String!, $limit: Int!) {
  searchCompanies(query: $query, first: $limit) {
    id name tickerSymbol uniqueSymbol exchangeSymbol
    score { dividend future health past value }
  }
}`;

const COMPANY_QUERY = `
query CompanyBySymbol($symbol: String!) {
  companyByUniqueSymbol(uniqueSymbol: $symbol) {
    id name tickerSymbol uniqueSymbol exchangeSymbol
    primaryIndustry { id slug name }
    score { dividend future health past value }
    analysisValue { return1d return7d return1yAbs marketCap lastSharePrice priceTarget pe pb priceToSales }
    analysisFuture { netIncomeGrowth3Y netIncomeGrowthAnnual revenueGrowthAnnual }
    analysisDividend { dividendYield }
    analysisMisc { analystCount }
    info { shortDescription logoUrl yearFounded }
  }
}`;

// ── Data Query Functions ────────────────────────────────────

export async function swsScreener(
  screenerId: string | number,
  options?: { country?: string; limit?: number; offset?: number },
): Promise<SwsScreenerResult> {
  const gridViewId = typeof screenerId === "number"
    ? screenerId
    : SWS_SCREENERS[screenerId]?.id;
  if (gridViewId === undefined) {
    throw new Error(`Unknown screener: ${screenerId}. Use swsListScreeners() to see available options.`);
  }

  const variables = {
    gridViewId,
    limit: options?.limit ?? 36,
    offset: options?.offset ?? 0,
    displayRecentlyAddedCompanies: true,
    returnRecentCompaniesOnly: false,
    additionalFilters: [
      { field: "country_name", operator: "in", logicalCondition: "aor", values: [options?.country ?? "us"] },
    ],
  };

  const resultSchema = z.object({
    companyPredefinedScreenerResults: swsScreenerResultSchema,
  });

  const data = await swsGraphQL(SCREENER_QUERY, variables, resultSchema);
  return data.companyPredefinedScreenerResults;
}

export async function swsSearchCompany(query: string, limit = 10): Promise<SwsSearchResult[]> {
  const resultSchema = z.object({
    searchCompanies: z.array(z.object({
      id: z.number(),
      name: z.string(),
      tickerSymbol: z.string(),
      uniqueSymbol: z.string(),
      exchangeSymbol: z.string(),
      score: swsSnowflakeSchema.optional(),
    })),
  });

  const data = await swsGraphQL(SEARCH_QUERY, { query, limit }, resultSchema);
  return data.searchCompanies;
}

export async function swsCompanyScore(uniqueSymbol: string): Promise<SwsSnowflake> {
  const resultSchema = z.object({
    companyByUniqueSymbol: z.object({
      score: swsSnowflakeSchema,
    }),
  });

  const data = await swsGraphQL(COMPANY_QUERY, { symbol: uniqueSymbol }, resultSchema);
  return data.companyByUniqueSymbol.score;
}

export async function swsCompanyAnalysis(uniqueSymbol: string): Promise<SwsCompany> {
  const resultSchema = z.object({
    companyByUniqueSymbol: swsCompanySchema,
  });

  const data = await swsGraphQL(COMPANY_QUERY, { symbol: uniqueSymbol }, resultSchema);
  return data.companyByUniqueSymbol;
}

export async function swsEnrichPortfolio(
  symbols: string[],
): Promise<Map<string, SwsSnowflake>> {
  const result = new Map<string, SwsSnowflake>();
  if (symbols.length === 0) return result;

  // Resolve tickers to SWS uniqueSymbols via search, then fetch scores
  const resolvePromises = symbols.map(async (ticker) => {
    try {
      const searchResults = await swsSearchCompany(ticker, 5);
      const match = searchResults.find(
        (r) => r.tickerSymbol.toUpperCase() === ticker.toUpperCase(),
      );
      if (match?.score) {
        result.set(ticker, match.score);
      } else if (match) {
        const score = await swsCompanyScore(match.uniqueSymbol);
        result.set(ticker, score);
      }
    } catch {
      // Skip silently — graceful degradation
    }
  });

  await Promise.all(resolvePromises);
  return result;
}
```

- [ ] **Step 4: Add barrel re-export**

In `src/services/index.ts`, append:

```typescript
export * from "./sws.service.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- tests/sws.test.ts`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/sws.service.ts src/services/index.ts tests/sws.test.ts
git commit -m "feat(sws): add SWS service with auth, screeners, and GraphQL client"
```

---

## Task 4: MCP server

**Files:**
- Create: `src/mcp/sws.ts`

- [ ] **Step 1: Create the MCP server**

Create `src/mcp/sws.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Config ──────────────────────────────────────────────────

const SWS_GRAPHQL_URL = "https://simplywall.st/graphql";

const SWS_HEADERS = {
  "accept": "*/*",
  "apollographql-client-name": "web",
  "content-type": "application/json",
};

function getToken(): string {
  const token = process.env.SWS_AUTH_TOKEN;
  if (!token) throw new Error("SWS_AUTH_TOKEN is not set");
  return token;
}

// ── Screener Registry ───────────────────────────────────────

const SWS_SCREENERS: Record<string, { id: number; description: string }> = {
  "undiscovered-gems":  { id: 152, description: "Undiscovered gems with strong fundamentals" },
  "high-growth-tech":   { id: 148, description: "High growth tech stocks" },
  "dividend-champions": { id: 155, description: "Reliable dividend payers" },
  "undervalued-large":  { id: 142, description: "Undervalued large caps" },
};

// ── TTL Cache ───────────────────────────────────────────────

const cache = new Map<string, { data: unknown; expiry: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (entry && entry.expiry > Date.now()) return entry.data as T;
  if (entry) cache.delete(key);
  return undefined;
}

function setCache(key: string, data: unknown): void {
  // LRU-like: cap at 200 entries
  if (cache.size >= 200) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}

// ── GraphQL Client ──────────────────────────────────────────

async function swsQuery(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(SWS_GRAPHQL_URL, {
    method: "POST",
    headers: { ...SWS_HEADERS, authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    throw new Error(`SWS API error ${resp.status}: ${await resp.text()}`);
  }

  const json = (await resp.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`SWS GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

// ── GraphQL Query Strings ───────────────────────────────────

const SCREENER_GQL = `
query InvestingIdeasStocks($gridViewId: Float!, $limit: Int!, $offset: Int!, $displayRecentlyAddedCompanies: Boolean!, $returnRecentCompaniesOnly: Boolean!, $additionalFilters: [AdditionalScreenerFilter!]) {
  companyPredefinedScreenerResults(
    input: {limit: $limit, offset: $offset, gridViewId: $gridViewId, displayRecentlyAddedCompanies: $displayRecentlyAddedCompanies, returnRecentCompaniesOnly: $returnRecentCompaniesOnly, additionalFilters: $additionalFilters}
  ) {
    totalHits
    companies {
      id name nameSlug tickerSymbol uniqueSymbol exchangeSymbol listingCurrencyISO
      primaryIndustry { id slug name }
      score { dividend future health past value }
      analysisValue { return1d return7d return1yAbs marketCap lastSharePrice priceTarget pe pb priceToSales }
      analysisFuture { netIncomeGrowth3Y netIncomeGrowthAnnual revenueGrowthAnnual }
      analysisDividend { dividendYield }
      analysisMisc { analystCount }
      info { shortDescription logoUrl yearFounded }
    }
  }
}`;

const COMPANY_GQL = `
query CompanyBySymbol($symbol: String!) {
  companyByUniqueSymbol(uniqueSymbol: $symbol) {
    id name tickerSymbol uniqueSymbol exchangeSymbol
    primaryIndustry { id slug name }
    score { dividend future health past value }
    analysisValue { return1d return7d return1yAbs marketCap lastSharePrice priceTarget pe pb priceToSales }
    analysisFuture { netIncomeGrowth3Y netIncomeGrowthAnnual revenueGrowthAnnual }
    analysisDividend { dividendYield }
    analysisMisc { analystCount }
    info { shortDescription logoUrl yearFounded }
  }
}`;

const SEARCH_GQL = `
query SearchCompanies($query: String!, $limit: Int!) {
  searchCompanies(query: $query, first: $limit) {
    id name tickerSymbol uniqueSymbol exchangeSymbol
    score { dividend future health past value }
  }
}`;

// ── MCP Server ──────────────────────────────────────────────

const server = new McpServer(
  { name: "sws", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── Tools ───────────────────────────────────────────────────

server.tool(
  "sws_screener",
  "Run a Simply Wall St investing idea screener to discover stocks matching a theme. Returns company names, tickers, snowflake scores, and valuation metrics.",
  {
    screener: z.string().describe("Screener slug (e.g. 'undiscovered-gems') or numeric gridViewId"),
    country: z.string().default("us").describe("Country filter (e.g. 'us', 'gb', 'au')"),
    limit: z.number().positive().max(100).default(36).describe("Max results"),
    offset: z.number().nonnegative().default(0).describe("Pagination offset"),
  },
  async ({ screener, country, limit, offset }) => {
    const gridViewId = isNaN(Number(screener))
      ? SWS_SCREENERS[screener]?.id
      : Number(screener);
    if (gridViewId === undefined) {
      const available = Object.keys(SWS_SCREENERS).join(", ");
      return { content: [{ type: "text" as const, text: `Unknown screener '${screener}'. Available: ${available}` }] };
    }

    const data = await swsQuery(SCREENER_GQL, {
      gridViewId, limit, offset,
      displayRecentlyAddedCompanies: true,
      returnRecentCompaniesOnly: false,
      additionalFilters: [{ field: "country_name", operator: "in", logicalCondition: "aor", values: [country] }],
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "sws_company_score",
  "Get Simply Wall St snowflake scores (value 0-6, future 0-6, health 0-6, past 0-6, dividend 0-6) for a company. Higher is better.",
  {
    symbol: z.string().describe("SWS uniqueSymbol (e.g. 'NasdaqGS:AAPL'). Use sws_search to find the correct format."),
  },
  async ({ symbol }) => {
    const cached = getCached<unknown>(`score:${symbol}`);
    if (cached) return { content: [{ type: "text" as const, text: JSON.stringify(cached, null, 2) }] };

    const data = await swsQuery(COMPANY_GQL, { symbol });
    setCache(`score:${symbol}`, data);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "sws_company_analysis",
  "Get detailed Simply Wall St fundamental analysis for a company: snowflake scores, valuation (PE, PB, P/S), growth metrics, dividend yield, analyst coverage, and industry context.",
  {
    symbol: z.string().describe("SWS uniqueSymbol (e.g. 'NasdaqGS:AAPL'). Use sws_search to find the correct format."),
  },
  async ({ symbol }) => {
    const cached = getCached<unknown>(`analysis:${symbol}`);
    if (cached) return { content: [{ type: "text" as const, text: JSON.stringify(cached, null, 2) }] };

    const data = await swsQuery(COMPANY_GQL, { symbol });
    setCache(`analysis:${symbol}`, data);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "sws_search",
  "Search Simply Wall St for companies by name or ticker. Returns uniqueSymbol format needed by other SWS tools.",
  {
    query: z.string().describe("Company name or ticker to search for (e.g. 'Apple' or 'AAPL')"),
    limit: z.number().positive().max(50).default(10).describe("Max results"),
  },
  async ({ query, limit }) => {
    const data = await swsQuery(SEARCH_GQL, { query, limit });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "sws_list_screeners",
  "List all available Simply Wall St screener IDs and their descriptions. Use the slug with sws_screener.",
  {},
  async () => {
    const list = Object.entries(SWS_SCREENERS).map(([slug, info]) => ({
      slug, gridViewId: info.id, description: info.description,
    }));
    return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
  },
);

server.tool(
  "sws_token_status",
  "Check if the Simply Wall St authentication token is valid and when it expires.",
  {},
  async () => {
    const token = process.env.SWS_AUTH_TOKEN;
    if (!token) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ valid: false, reason: "No token configured" }) }] };
    }
    try {
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error("Invalid JWT");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
      const expiresAt = new Date(payload.exp * 1000);
      const hoursLeft = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            valid: hoursLeft > 0,
            expiresAt: expiresAt.toISOString(),
            expiresInHours: Math.round(hoursLeft * 10) / 10,
          }, null, 2),
        }],
      };
    } catch {
      return { content: [{ type: "text" as const, text: JSON.stringify({ valid: false, reason: "Failed to decode token" }) }] };
    }
  },
);

// ── Start ───────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("sws MCP server error:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/mcp/sws.ts
git commit -m "feat(sws): add MCP server with 6 tools for Claude sessions"
```

---

## Task 5: Wire MCP server into agent.ts and chat.service.ts

**Files:**
- Modify: `src/agent.ts:73-136` (buildMcpServers)
- Modify: `src/services/chat.service.ts:639-658` (buildChatMcpServers)
- Test: `tests/agent.test.ts` (append)

- [ ] **Step 1: Write failing test for SWS MCP server wiring**

Append to `tests/agent.test.ts` — find the `describe("buildMcpServers", ...)` block and add inside it (following the existing test pattern that uses `mockedGlobalConfig` directly):

```typescript
it("includes sws server when sws token is configured", async () => {
  mockedGlobalConfig.mockResolvedValue(
    makeGlobalConfig({ sws: { auth_token: "test-jwt-token" } }) as never,
  );
  const servers = await buildMcpServers("test-fund");
  expect(servers).toHaveProperty("sws");
  expect(servers.sws.env.SWS_AUTH_TOKEN).toBe("test-jwt-token");
});

it("excludes sws server when no sws token", async () => {
  mockedGlobalConfig.mockResolvedValue(makeGlobalConfig() as never);
  const servers = await buildMcpServers("test-fund");
  expect(servers).not.toHaveProperty("sws");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/agent.test.ts`
Expected: FAIL — sws server not wired yet

- [ ] **Step 3: Add SWS server to buildMcpServers in agent.ts**

In `src/agent.ts`, inside `buildMcpServers()`, before the `return servers;` line (before line 135), add:

```typescript
  // Conditionally add SWS (Simply Wall St) — globally available if token is set
  if (globalConfig.sws?.auth_token) {
    servers["sws"] = {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.sws],
      env: { SWS_AUTH_TOKEN: globalConfig.sws.auth_token },
    };
  }
```

- [ ] **Step 4: Add SWS server to buildChatMcpServers in chat.service.ts**

In `src/services/chat.service.ts`, inside `buildChatMcpServers()`, in the workspace-mode block (the `return { "market-data": ... }` object around line 651), add the SWS server. Change the return block to:

```typescript
  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    "market-data": {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.marketData],
      env: marketDataEnv,
    },
  };

  if (globalConfig.sws?.auth_token) {
    servers["sws"] = {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.sws],
      env: { SWS_AUTH_TOKEN: globalConfig.sws.auth_token },
    };
  }

  return servers;
```

- [ ] **Step 5: Run tests**

Run: `pnpm test -- tests/agent.test.ts`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent.ts src/services/chat.service.ts tests/agent.test.ts
git commit -m "feat(sws): wire MCP server into agent and chat sessions"
```

---

## Task 6: CLI commands (login, status, logout)

**Files:**
- Create: `src/commands/sws/login.tsx`
- Create: `src/commands/sws/status.tsx`
- Create: `src/commands/sws/logout.tsx`

- [ ] **Step 1: Create login command**

Create `src/commands/sws/login.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { swsLogin } from "../../services/sws.service.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Login to Simply Wall St (opens Chrome)";

export default function SwsLogin() {
  const { data, isLoading, error } = useAsyncAction(() => swsLogin(), []);

  if (isLoading) {
    return (
      <Box flexDirection="column" gap={1}>
        <Spinner label="Opening Chrome — log in to Simply Wall St..." />
        <Text dimColor>The browser will close automatically after login.</Text>
        <Text dimColor>Timeout: 5 minutes.</Text>
      </Box>
    );
  }

  if (error) return <ErrorMessage error={error} />;
  if (!data) return null;

  const expiresDate = new Date(data.expiresAt);
  const daysLeft = Math.round((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  return (
    <Box flexDirection="column" gap={1}>
      <SuccessMessage>SWS token captured and saved.</SuccessMessage>
      <Text>Expires: {expiresDate.toLocaleDateString()} ({daysLeft} days)</Text>
    </Box>
  );
}
```

- [ ] **Step 2: Create status command**

Create `src/commands/sws/status.tsx`:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { swsTokenStatus } from "../../services/sws.service.js";

export const description = "Show Simply Wall St token status";

export default function SwsStatus() {
  const { data, isLoading, error } = useAsyncAction(() => swsTokenStatus(), []);

  if (isLoading) return <Spinner label="Checking SWS token..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  if (!data.expiresAt) {
    return <Text color="yellow">SWS not configured. Run `fundx sws login` to authenticate.</Text>;
  }

  const hoursLeft = data.expiresInHours ?? 0;
  const statusColor = data.valid ? (hoursLeft < 24 ? "yellow" : "green") : "red";
  const statusText = data.valid ? "Valid" : "Expired";

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text>Status:</Text>
        <Text color={statusColor} bold>{statusText}</Text>
      </Box>
      <Text>Expires: {new Date(data.expiresAt).toLocaleString()}</Text>
      {data.valid && <Text>Time remaining: {Math.round(hoursLeft)}h</Text>}
      {!data.valid && <Text color="red">Run `fundx sws login` to renew.</Text>}
    </Box>
  );
}
```

- [ ] **Step 3: Create logout command**

Create `src/commands/sws/logout.tsx`:

```tsx
import React from "react";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { swsLogout } from "../../services/sws.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Remove Simply Wall St token";

export default function SwsLogout() {
  const { data, isLoading, error } = useAsyncAction(
    async () => { await swsLogout(); return true; },
    [],
  );

  if (isLoading) return <Spinner label="Removing SWS token..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return <SuccessMessage>SWS token removed from config.</SuccessMessage>;
}
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/sws/
git commit -m "feat(sws): add login, status, and logout CLI commands"
```

---

## Task 7: SnowflakeScores component + portfolio enrichment

**Files:**
- Create: `src/components/SnowflakeScores.tsx`
- Modify: `src/commands/portfolio.tsx`

- [ ] **Step 1: Create SnowflakeScores component**

Create `src/components/SnowflakeScores.tsx`:

```tsx
import React from "react";
import { Text } from "ink";
import type { SwsSnowflake } from "../types.js";

function scoreColor(score: number): string {
  if (score <= 2) return "red";
  if (score <= 4) return "yellow";
  return "green";
}

interface SnowflakeScoresProps {
  scores: SwsSnowflake;
}

export function SnowflakeScores({ scores }: SnowflakeScoresProps) {
  const entries: Array<[string, number]> = [
    ["V", scores.value],
    ["F", scores.future],
    ["H", scores.health],
    ["P", scores.past],
    ["D", scores.dividend],
  ];

  return (
    <>
      {entries.map(([label, value]) => (
        <Text key={label} color={scoreColor(value)}>
          {String(value).padEnd(3)}
        </Text>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Modify portfolio.tsx to show snowflake scores**

Replace the content of `src/commands/portfolio.tsx` with:

```tsx
import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getPortfolioDisplay } from "../services/portfolio.service.js";
import { swsEnrichPortfolio, swsTokenStatus } from "../services/sws.service.js";
import { PnlText } from "../components/PnlText.js";
import { Header } from "../components/Header.js";
import { SnowflakeScores } from "../components/SnowflakeScores.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import type { SwsSnowflake } from "../types.js";

export const description = "View fund portfolio holdings";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

export const options = zod.object({
  sync: zod.boolean().default(false).describe("Sync from broker before displaying"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function Portfolio({ args: [fundName], options: opts }: Props) {
  const { columns } = useTerminalSize();
  const showSws = columns >= 100;

  const { data, isLoading, error } = useAsyncAction(
    () => getPortfolioDisplay(fundName, { sync: opts.sync }),
    [fundName, opts.sync],
  );

  const [swsScores, setSwsScores] = useState<Map<string, SwsSnowflake>>(new Map());

  useEffect(() => {
    if (!data || !showSws || data.positions.length === 0) return;
    let cancelled = false;

    (async () => {
      try {
        const status = await swsTokenStatus();
        if (!status.valid) return;
        const symbols = data.positions.map((p) => p.symbol);
        const scores = await swsEnrichPortfolio(symbols);
        if (!cancelled) setSwsScores(scores);
      } catch {
        // Graceful degradation — SWS scores are optional
      }
    })();

    return () => { cancelled = true; };
  }, [data, showSws]);

  if (isLoading) return <Spinner label="Loading portfolio..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  const hasSws = showSws && swsScores.size > 0;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Portfolio: {data.fundDisplayName}</Header>
      <Text dimColor>Last updated: {data.lastUpdated}</Text>
      {opts.sync && data.synced && <Text dimColor>Synced from broker.</Text>}

      <Box flexDirection="column">
        <Box gap={2}>
          <Text>Total Value: ${data.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
        </Box>
        <Box gap={2}>
          <Text>Cash: ${data.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })} ({data.cashPct.toFixed(1)}%)</Text>
        </Box>
        <Box gap={2}>
          <Text>P&amp;L: </Text>
          <PnlText value={data.pnl} percentage={data.pnlPct} />
        </Box>
      </Box>

      {data.positions.length === 0 ? (
        <Text dimColor>No open positions.</Text>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text bold>
              {"Symbol".padEnd(8)} {"Shares".padEnd(8)} {"Avg Cost".padEnd(10)} {"Price".padEnd(10)} {"Mkt Value".padEnd(12)} {"P&L".padEnd(12)} {"P&L %".padEnd(8)} {"Weight".padEnd(8)} {"Stop".padEnd(8)}
              {hasSws ? " V  F  H  P  D" : ""}
            </Text>
          </Box>
          <Text dimColor>{"─".repeat(hasSws ? 109 : 94)}</Text>
          {data.positions.map((pos) => {
            const pnlColor = pos.unrealizedPnl >= 0 ? "green" : "red";
            const stopStr = pos.stopLoss ? `$${pos.stopLoss.toFixed(2)}` : "—";
            const scores = swsScores.get(pos.symbol);
            return (
              <Box key={pos.symbol}>
                <Text bold>{pos.symbol.padEnd(8)}</Text>
                <Text>{String(pos.shares).padEnd(8)}</Text>
                <Text>{`$${pos.avgCost.toFixed(2)}`.padEnd(10)}</Text>
                <Text>{`$${pos.currentPrice.toFixed(2)}`.padEnd(10)}</Text>
                <Text>{`$${pos.marketValue.toFixed(2)}`.padEnd(12)}</Text>
                <Text color={pnlColor}>{`$${pos.unrealizedPnl.toFixed(2)}`.padEnd(12)}</Text>
                <Text color={pnlColor}>{`${pos.unrealizedPnlPct.toFixed(1)}%`.padEnd(8)}</Text>
                <Text>{`${pos.weightPct.toFixed(1)}%`.padEnd(8)}</Text>
                <Text>{stopStr.padEnd(8)}</Text>
                {hasSws && scores && <Text> </Text>}
                {hasSws && scores && <SnowflakeScores scores={scores} />}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/components/SnowflakeScores.tsx src/commands/portfolio.tsx
git commit -m "feat(sws): add snowflake scores to portfolio view"
```

---

## Task 8: AppContext warning + daemon token check

**Files:**
- Modify: `src/context/AppContext.tsx`
- Modify: `src/services/daemon.service.ts`

- [ ] **Step 1: Add SWS token expiry warning to AppContext**

Replace `src/context/AppContext.tsx`:

```tsx
import React, { createContext, useContext, useState, useEffect } from "react";
import { Box, Text } from "ink";
import { loadGlobalConfig } from "../config.js";

interface AppContextValue {
  verbose: boolean;
}

const AppContext = createContext<AppContextValue>({ verbose: false });

interface AppProviderProps {
  verbose?: boolean;
  children: React.ReactNode;
}

export function AppProvider({ verbose = false, children }: AppProviderProps) {
  const [swsWarning, setSwsWarning] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const config = await loadGlobalConfig();
        const expiresAt = config.sws?.token_expires_at;
        if (!expiresAt) return;

        const hoursLeft = (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60);
        if (hoursLeft <= 0) {
          setSwsWarning("SWS token expired — run `fundx sws login` to renew");
        } else if (hoursLeft <= 24) {
          setSwsWarning(`SWS token expires in ${Math.round(hoursLeft)}h — run \`fundx sws login\` to renew`);
        }
      } catch {
        // Config not found or parse error — skip silently
      }
    })();
  }, []);

  return (
    <AppContext.Provider value={{ verbose }}>
      {swsWarning && (
        <Box paddingX={1} marginBottom={1}>
          <Text color="yellow">⚠ {swsWarning}</Text>
        </Box>
      )}
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext(): AppContextValue {
  return useContext(AppContext);
}
```

- [ ] **Step 2: Add daily token check to daemon**

In `src/services/daemon.service.ts`:

**First**, add import at the top (alongside existing imports):

```typescript
import { loadGlobalConfig } from "../config.js";
```

**Second**, add a helper function before `startDaemon`:

```typescript
async function checkSwsTokenExpiry(): Promise<void> {
  const config = await loadGlobalConfig();
  const expiresAt = config.sws?.token_expires_at;
  if (!expiresAt) return; // No token configured — skip

  const hoursLeft = (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60);

  if (!config.telegram.bot_token || !config.telegram.chat_id) return;

  const { sendTelegramNotification } = await import("./gateway.service.js");

  if (hoursLeft <= 0) {
    await sendTelegramNotification("⚠️ <b>SWS token expired.</b> Data de Simply Wall St deshabilitada. Ejecuta <code>fundx sws login</code> para renovar.");
  } else if (hoursLeft <= 48) {
    await sendTelegramNotification(`⚠️ SWS token expira en ${Math.round(hoursLeft)} horas. Ejecuta <code>fundx sws login</code> para renovar.`);
  }
}
```

**Third**, add a separate cron schedule inside `startDaemon()`, after the existing `cron.schedule("* * * * *", ...)` block. This runs independently of per-fund schedules:

```typescript
  // SWS token expiry check — daily at 09:00
  cron.schedule("0 9 * * *", () => {
    checkSwsTokenExpiry().catch(async (err) => {
      await log(`SWS token check error: ${err}`);
    });
  });
```
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/context/AppContext.tsx src/services/daemon.service.ts
git commit -m "feat(sws): add token expiry warnings in CLI and daemon"
```

---

## Task 9: Build verification + full test run

**Files:** None new — verification only

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: PASS — verify `dist/mcp/sws.js` exists

- [ ] **Step 4: Verify MCP server starts**

Run: `SWS_AUTH_TOKEN=test node dist/mcp/sws.js &` then kill it
Expected: Process starts without crash

- [ ] **Step 5: Commit any remaining fixes**

If any fixes were needed, commit them.

```bash
git add -A
git commit -m "fix(sws): build and test fixes"
```
