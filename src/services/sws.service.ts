import { platform } from "node:os";
import { existsSync } from "node:fs";
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
} from "../types.js";
import { z } from "zod";

// ── Constants ─────────────────────────────────────────────────

export const SWS_GRAPHQL_URL = "https://simplywall.st/api/gql";

export const SWS_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Origin: "https://simplywall.st",
  Referer: "https://simplywall.st/",
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
  id: string;
  description: string;
}

export const SWS_SCREENERS: SwsScreenerEntry[] = [
  {
    slug: "top-dividend-stocks",
    id: "top-dividend-stocks",
    description: "High dividend yield stocks with strong dividend history",
  },
  {
    slug: "undervalued-stocks",
    id: "undervalued-stocks",
    description: "Stocks trading below their estimated fair value",
  },
  {
    slug: "high-growth-stocks",
    id: "high-growth-stocks",
    description: "Companies with high projected earnings and revenue growth",
  },
  {
    slug: "tech-stocks",
    id: "tech-stocks",
    description: "Technology sector companies",
  },
  {
    slug: "small-cap-stocks",
    id: "small-cap-stocks",
    description: "Small capitalization companies with growth potential",
  },
  {
    slug: "large-cap-stocks",
    id: "large-cap-stocks",
    description: "Large capitalization blue-chip stocks",
  },
  {
    slug: "financial-stocks",
    id: "financial-stocks",
    description: "Banking, insurance, and financial services companies",
  },
  {
    slug: "healthcare-stocks",
    id: "healthcare-stocks",
    description: "Healthcare, pharmaceuticals, and biotech companies",
  },
  {
    slug: "income-stocks",
    id: "income-stocks",
    description: "Income-generating stocks with stable cash flows",
  },
  {
    slug: "penny-stocks",
    id: "penny-stocks",
    description: "Low-price stocks with speculative potential",
  },
];

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
  configured: boolean;
  valid: boolean;
  expiresAt?: string;
  reason?: string;
}

/** Return the current SWS token status without throwing */
export async function swsTokenStatus(): Promise<SwsTokenStatus> {
  try {
    const config = await loadGlobalConfig();

    if (!config.sws?.auth_token) {
      return { configured: false, valid: false, reason: "No token configured" };
    }

    const token = config.sws.auth_token;
    const exp = decodeJwtExp(token);

    if (exp === undefined) {
      // Token exists but we can't decode expiry — assume valid
      return { configured: true, valid: true };
    }

    const now = Math.floor(Date.now() / 1000);
    if (exp <= now) {
      return {
        configured: true,
        valid: false,
        expiresAt: config.sws.token_expires_at,
        reason: "Token expired",
      };
    }

    return {
      configured: true,
      valid: true,
      expiresAt: config.sws.token_expires_at,
    };
  } catch {
    return { configured: false, valid: false, reason: "Failed to load config" };
  }
}

/** Launch a browser, navigate to SWS login, capture auth cookie, save token to config */
export async function swsLogin(): Promise<void> {
  const chromePath = findChromePath();

  // Dynamic import to avoid loading puppeteer-core unless needed
  const puppeteer = await import("puppeteer-core");

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.goto("https://simplywall.st/login", { waitUntil: "networkidle2" });

    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const POLL_INTERVAL_MS = 1000;
    const startTime = Date.now();

    let authToken: string | undefined;

    while (Date.now() - startTime < TIMEOUT_MS) {
      const cookies = await page.cookies();
      const authCookie = cookies.find((c) => c.name === "auth");

      if (authCookie?.value) {
        // Auth cookie may be URL-encoded and contain a `|suffix` — extract JWT
        const decoded = decodeURIComponent(authCookie.value);
        authToken = decoded.split("|")[0];
        break;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (!authToken) {
      throw new Error("Login timed out — no auth cookie found after 5 minutes.");
    }

    // Decode exp claim from the JWT
    const exp = decodeJwtExp(authToken);
    const expiresAt = exp ? new Date(exp * 1000).toISOString() : undefined;

    const config = await loadGlobalConfig();
    config.sws = {
      auth_token: authToken,
      token_expires_at: expiresAt,
    };
    await saveGlobalConfig(config);
  } finally {
    // Handle browser disconnect gracefully
    try {
      await browser.close();
    } catch {
      // Already closed or disconnected
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
    signal: AbortSignal.timeout(15000),
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
  query ScreenerQuery($id: String!, $offset: Int, $size: Int) {
    screenResults(id: $id, offset: $offset, size: $size) {
      totalHits
      companies {
        id
        name
        tickerSymbol
        uniqueSymbol
        exchangeSymbol
        score {
          value
          future
          health
          past
          dividend
        }
        primaryIndustry {
          id
          name
          slug
        }
        analysisValue {
          return1d
          return7d
          return1yAbs
          marketCap
          lastSharePrice
          priceTarget
          pe
          pb
          priceToSales
        }
        analysisFuture {
          netIncomeGrowth3Y
          netIncomeGrowthAnnual
          revenueGrowthAnnual
        }
        analysisDividend {
          dividendYield
        }
        analysisMisc {
          analystCount
        }
        info {
          shortDescription
          logoUrl
          yearFounded
        }
      }
    }
  }
`;

export const SEARCH_QUERY = `
  query SearchQuery($query: String!, $size: Int) {
    searchResults(query: $query, size: $size) {
      id
      name
      tickerSymbol
      uniqueSymbol
      exchangeSymbol
      score {
        value
        future
        health
        past
        dividend
      }
    }
  }
`;

export const COMPANY_QUERY = `
  query CompanyQuery($uniqueSymbol: String!) {
    company(uniqueSymbol: $uniqueSymbol) {
      id
      name
      tickerSymbol
      uniqueSymbol
      exchangeSymbol
      score {
        value
        future
        health
        past
        dividend
      }
      primaryIndustry {
        id
        name
        slug
      }
      analysisValue {
        return1d
        return7d
        return1yAbs
        marketCap
        lastSharePrice
        priceTarget
        pe
        pb
        priceToSales
      }
      analysisFuture {
        netIncomeGrowth3Y
        netIncomeGrowthAnnual
        revenueGrowthAnnual
      }
      analysisDividend {
        dividendYield
      }
      analysisMisc {
        analystCount
      }
      info {
        shortDescription
        logoUrl
        yearFounded
      }
    }
  }
`;

// ── Data functions ────────────────────────────────────────────

/** Run a SWS screener by slug and return the result */
export async function swsScreener(
  slug: string,
  offset = 0,
  size = 50,
): Promise<SwsScreenerResult> {
  const schema = z.object({
    screenResults: swsScreenerResultSchema,
  });

  const result = await swsGraphQL(
    SCREENER_QUERY,
    { id: slug, offset, size },
    schema,
  );

  return {
    totalHits: result.screenResults.totalHits,
    companies: result.screenResults.companies ?? [],
  };
}

/** Search for a company by name or ticker */
export async function swsSearchCompany(query: string, size = 10): Promise<SwsSearchResult[]> {
  const swsSearchResultSchema = z.object({
    id: z.number(),
    name: z.string(),
    tickerSymbol: z.string(),
    uniqueSymbol: z.string(),
    exchangeSymbol: z.string(),
    score: swsSnowflakeSchema.optional(),
  });

  const schema = z.object({
    searchResults: z.array(swsSearchResultSchema),
  });

  const result = await swsGraphQL(SEARCH_QUERY, { query, size }, schema);
  return result.searchResults;
}

/** Get the full company analysis + snowflake scores by unique symbol */
export async function swsCompanyScore(uniqueSymbol: string): Promise<SwsCompany | null> {
  const schema = z.object({
    company: swsCompanySchema.nullable(),
  });

  const result = await swsGraphQL(COMPANY_QUERY, { uniqueSymbol }, schema);
  return result.company;
}

/** Alias for swsCompanyScore — returns full analysis */
export async function swsCompanyAnalysis(uniqueSymbol: string): Promise<SwsCompany | null> {
  return swsCompanyScore(uniqueSymbol);
}

/** Enrich portfolio positions with SWS snowflake scores.
 *  Searches each ticker, matches by tickerSymbol, returns Map<ticker, SwsSnowflake>
 */
export async function swsEnrichPortfolio(
  symbols: string[],
): Promise<Map<string, SwsSnowflake>> {
  const result = new Map<string, SwsSnowflake>();

  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const searchResults = await swsSearchCompany(symbol, 5);
        const match = searchResults.find(
          (r) => r.tickerSymbol.toUpperCase() === symbol.toUpperCase(),
        );
        if (match?.score) {
          result.set(symbol, match.score);
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
  return SWS_SCREENERS.map(({ slug, id, description }) => ({ slug, id, description }));
}
