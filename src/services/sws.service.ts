import { homedir, platform } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadGlobalConfig, saveGlobalConfig } from "../config.js";
import type {
  SwsSnowflake,
  SwsCompany,
  SwsScreenerResult,
  SwsSearchResult,
} from "../types.js";
import {
  swsScreenerResultSchema,
  swsSnowflakeSchema,
  swsCompanySchema,
  swsSearchResultSchema,
} from "../types.js";
import { z } from "zod";

// ── Constants ─────────────────────────────────────────────────

export const SWS_GRAPHQL_URL = "https://simplywall.st/graphql";

export const SWS_HEADERS: Record<string, string> = {
  "accept": "*/*",
  "apollographql-client-name": "web",
  "content-type": "application/json",
};

export const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
  ],
};

// ── Screener registry ──────────────────────────────────────────

export interface SwsScreenerEntry {
  slug: string;
  id: number;
  description: string;
}

const SWS_SCREENERS_MAP: Record<string, { id: number; description: string }> = {
  "undiscovered-gems":  { id: 152, description: "Undiscovered gems with strong fundamentals" },
  "high-growth-tech":   { id: 148, description: "High growth tech stocks" },
  "dividend-champions": { id: 155, description: "Reliable dividend payers" },
  "undervalued-large":  { id: 142, description: "Undervalued large caps" },
};

// ── Error classes ─────────────────────────────────────────────

export class SwsTokenExpiredError extends Error {
  constructor() {
    super("SWS auth token has expired. Please run `fundx sws login` to re-authenticate.");
    this.name = "SwsTokenExpiredError";
  }
}

export class SwsNotConfiguredError extends Error {
  constructor() {
    super("SWS is not configured. Please run `fundx sws login` to authenticate.");
    this.name = "SwsNotConfiguredError";
  }
}

// ── Chrome discovery ──────────────────────────────────────────

/** Find Chrome executable path, checking CHROME_PATH env var first, then platform-specific paths */
export function findChromePath(): string | undefined {
  const envPath = process.env["CHROME_PATH"];
  if (envPath) return envPath;

  const os = platform() as string;
  const candidates = CHROME_PATHS[os] ?? [];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

// ── Chrome profile directory ─────────────────────────────────

/** Get the user's real Chrome profile directory per platform */
function getChromeProfileDir(): string {
  const home = homedir();
  const os = platform() as string;

  if (os === "darwin") {
    return join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (os === "win32") {
    return join(home, "AppData", "Local", "Google", "Chrome", "User Data");
  }
  // Linux
  return join(home, ".config", "google-chrome");
}

// ── JWT decoding ──────────────────────────────────────────────

/** Decode JWT payload and extract the `exp` claim (Unix timestamp) */
export function decodeJwtExp(token: string): number | undefined {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return undefined;

    // base64url → base64 standard
    const base64 = parts[1]
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), "=");

    const payload = JSON.parse(Buffer.from(base64, "base64").toString("utf-8")) as Record<
      string,
      unknown
    >;

    if (typeof payload["exp"] === "number") {
      return payload["exp"];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// ── Token management ──────────────────────────────────────────

export interface SwsTokenStatus {
  valid: boolean;
  expiresAt: string | null;
  expiresInHours: number | null;
}

/** Return the current SWS token status without throwing */
export async function swsTokenStatus(): Promise<SwsTokenStatus> {
  try {
    const config = await loadGlobalConfig();
    const token = config.sws?.auth_token;
    const expiresAt = config.sws?.token_expires_at ?? null;

    if (!token || !expiresAt) {
      return { valid: false, expiresAt: null, expiresInHours: null };
    }

    const expiryDate = new Date(expiresAt);
    const hoursLeft = (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60);

    return {
      valid: hoursLeft > 0,
      expiresAt,
      expiresInHours: Math.max(0, hoursLeft),
    };
  } catch {
    return { valid: false, expiresAt: null, expiresInHours: null };
  }
}

/** Launch a browser, navigate to SWS login, capture auth cookie, save token to config */
export async function swsLogin(): Promise<{ token: string; expiresAt: string }> {
  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error("Chrome not found. Set CHROME_PATH environment variable or install Chrome.");
  }

  // Dynamic import to avoid loading puppeteer-core unless needed
  const puppeteer = await import("puppeteer-core");

  // Strategy: try user's real Chrome profile first (may already be logged in).
  // If Chrome is running (profile locked), fall back to a persistent FundX profile.
  const launchArgs = {
    executablePath: chromePath,
    headless: false as const,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  };

  let browser;
  let usingFallbackProfile = false;

  try {
    browser = await puppeteer.launch({
      ...launchArgs,
      userDataDir: getChromeProfileDir(),
    });
  } catch {
    // Chrome is probably running — fall back to a separate persistent profile
    const { mkdir } = await import("node:fs/promises");
    const fallbackDir = join(homedir(), ".fundx", "chrome-profile");
    await mkdir(fallbackDir, { recursive: true });
    browser = await puppeteer.launch({
      ...launchArgs,
      userDataDir: fallbackDir,
    });
    usingFallbackProfile = true;
  }

  let disconnected = false;
  browser.on("disconnected", () => { disconnected = true; });

  try {
    const page = await browser.newPage();

    // Remove navigator.webdriver flag that sites use to detect automation
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    await page.goto("https://simplywall.st/login", { waitUntil: "networkidle2" });

    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const POLL_INTERVAL_MS = 1000;
    const startTime = Date.now();

    while (true) {
      if (disconnected) {
        throw new Error("Browser closed before login completed.");
      }
      if (Date.now() - startTime > TIMEOUT_MS) {
        throw new Error("Login timed out — try again.");
      }

      const cookies = await page.cookies("https://simplywall.st");
      const authCookie = cookies.find((c) => c.name === "auth");

      if (authCookie?.value) {
        // Auth cookie may be URL-encoded and contain a `|suffix` — extract JWT
        const decoded = decodeURIComponent(authCookie.value);
        const jwtPart = decoded.split("|")[0];
        const exp = decodeJwtExp(jwtPart);
        if (!exp) {
          throw new Error("Failed to decode JWT expiration from auth cookie.");
        }

        const expiresAt = new Date(exp * 1000).toISOString();
        const config = await loadGlobalConfig();
        config.sws = { auth_token: jwtPart, token_expires_at: expiresAt };
        await saveGlobalConfig(config);

        return { token: jwtPart, expiresAt };
      }

      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } finally {
    if (!disconnected) {
      await browser.close().catch(() => {});
    }
  }
}

/** Remove SWS credentials from global config */
export async function swsLogout(): Promise<void> {
  const config = await loadGlobalConfig();
  delete config.sws;
  await saveGlobalConfig(config);
}

// ── GraphQL client ────────────────────────────────────────────

/** Execute a GraphQL query against the SWS API. Reads token from config. */
export async function swsGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const config = await loadGlobalConfig();

  if (!config.sws?.auth_token) {
    throw new SwsNotConfiguredError();
  }

  const token = config.sws.auth_token;

  // Check token expiry
  const exp = decodeJwtExp(token);
  if (exp !== undefined) {
    const now = Math.floor(Date.now() / 1000);
    if (exp <= now) {
      throw new SwsTokenExpiredError();
    }
  }

  const response = await fetch(SWS_GRAPHQL_URL, {
    method: "POST",
    headers: {
      ...SWS_HEADERS,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`SWS GraphQL request failed: HTTP ${response.status}`);
  }

  const json = (await response.json()) as { data?: unknown; errors?: unknown[] };

  if (json.errors && json.errors.length > 0) {
    throw new Error(`SWS GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return schema.parse(json.data);
}

// ── GraphQL queries ───────────────────────────────────────────

export const SCREENER_QUERY = `
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

export const SEARCH_QUERY = `
query SearchCompanies($query: String!, $limit: Int!) {
  searchCompanies(query: $query, first: $limit) {
    id name tickerSymbol uniqueSymbol exchangeSymbol
    score { dividend future health past value }
  }
}`;

export const COMPANY_QUERY = `
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

// ── Data functions ────────────────────────────────────────────

/** Run a SWS screener by slug or numeric gridViewId */
export async function swsScreener(
  screenerId: string | number,
  options?: { country?: string; limit?: number; offset?: number },
): Promise<SwsScreenerResult> {
  const gridViewId = typeof screenerId === "number"
    ? screenerId
    : SWS_SCREENERS_MAP[screenerId]?.id;
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
  const result = data.companyPredefinedScreenerResults;
  return { totalHits: result.totalHits, companies: result.companies ?? [] };
}

/** Search for a company by name or ticker */
export async function swsSearchCompany(query: string, limit = 10): Promise<SwsSearchResult[]> {
  const resultSchema = z.object({
    searchCompanies: z.array(swsSearchResultSchema),
  });

  const data = await swsGraphQL(SEARCH_QUERY, { query, limit }, resultSchema);
  return data.searchCompanies;
}

/** Get snowflake scores for a company by unique symbol */
export async function swsCompanyScore(uniqueSymbol: string): Promise<SwsSnowflake> {
  const resultSchema = z.object({
    companyByUniqueSymbol: z.object({ score: swsSnowflakeSchema }),
  });

  const data = await swsGraphQL(COMPANY_QUERY, { symbol: uniqueSymbol }, resultSchema);
  return data.companyByUniqueSymbol.score;
}

/** Get detailed company analysis by unique symbol */
export async function swsCompanyAnalysis(uniqueSymbol: string): Promise<SwsCompany> {
  const resultSchema = z.object({
    companyByUniqueSymbol: swsCompanySchema,
  });

  const data = await swsGraphQL(COMPANY_QUERY, { symbol: uniqueSymbol }, resultSchema);
  return data.companyByUniqueSymbol;
}

/** Enrich portfolio positions with SWS snowflake scores.
 *  Searches each ticker, matches by tickerSymbol, returns Map<ticker, SwsSnowflake>
 */
export async function swsEnrichPortfolio(
  symbols: string[],
): Promise<Map<string, SwsSnowflake>> {
  const result = new Map<string, SwsSnowflake>();
  if (symbols.length === 0) return result;

  await Promise.all(
    symbols.map(async (ticker) => {
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
        // Individual ticker failures don't abort the whole enrichment
      }
    }),
  );

  return result;
}

// ── Screener registry ─────────────────────────────────────────

/** List all available SWS screeners */
export function swsListScreeners(): SwsScreenerEntry[] {
  return Object.entries(SWS_SCREENERS_MAP).map(([slug, info]) => ({
    slug,
    ...info,
  }));
}
