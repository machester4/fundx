import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Simply Wall St GraphQL client ────────────────────────────

const SWS_GQL_URL = "https://simplywall.st/graphql";

const SWS_HEADERS: Record<string, string> = {
  accept: "*/*",
  "apollographql-client-name": "web",
  "content-type": "application/json",
};

function getAuthToken(): string {
  const token = process.env.SWS_AUTH_TOKEN;
  if (!token) throw new Error("SWS_AUTH_TOKEN environment variable is not set");
  return token;
}

async function swsQuery(query: string, variables: Record<string, unknown>): Promise<unknown> {
  const token = getAuthToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(SWS_GQL_URL, {
      method: "POST",
      headers: { ...SWS_HEADERS, authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`SWS GraphQL error ${resp.status}: ${text}`);
    }
    const json = (await resp.json()) as { data?: unknown; errors?: unknown[] };
    if (json.errors?.length) {
      throw new Error(`SWS GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── TTL cache (5-min TTL, 200-entry LRU cap) ─────────────────

interface CacheEntry {
  data: unknown;
  expiresAt: number;
  lastUsed: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, CacheEntry>();

function cacheGet(key: string): unknown | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  entry.lastUsed = Date.now();
  return entry.data;
}

function cacheSet(key: string, data: unknown): void {
  // Evict oldest entry when at capacity
  if (cache.size >= CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of cache.entries()) {
      if (v.lastUsed < oldestTime) {
        oldestTime = v.lastUsed;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS, lastUsed: Date.now() });
}

async function cachedQuery(
  operation: string,
  symbol: string,
  gql: string,
  variables: Record<string, unknown>,
): Promise<unknown> {
  const key = `${operation}:${symbol}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const data = await swsQuery(gql, variables);
  cacheSet(key, data);
  return data;
}

// ── Screener registry ─────────────────────────────────────────

interface ScreenerDef {
  id: number;
  description: string;
}

const SWS_SCREENERS: Record<string, ScreenerDef> = {
  "undiscovered-gems":  { id: 152, description: "Undiscovered gems with strong fundamentals" },
  "high-growth-tech":   { id: 148, description: "High growth tech stocks" },
  "dividend-champions": { id: 155, description: "Reliable dividend payers" },
  "undervalued-large":  { id: 142, description: "Undervalued large caps" },
};

// ── GraphQL queries ───────────────────────────────────────────

const SCREENER_GQL = `
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
  }
`;

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

// ── MCP Server ────────────────────────────────────────────────

const server = new McpServer(
  { name: "sws", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── Tools ─────────────────────────────────────────────────────

server.tool(
  "sws_screener",
  "Run a Simply Wall St investing idea screener to discover stocks matching a specific thesis (undervalued, dividend, growth, etc.)",
  {
    screener: z
      .string()
      .describe(
        "Screener slug (e.g. 'undervalued-large-caps') or numeric ID. Use sws_list_screeners to see available options.",
      ),
    country: z.string().default("us").describe("Country market code (e.g. us, gb, au, ca)"),
    limit: z.number().int().positive().max(100).default(36).describe("Number of results to return"),
    offset: z.number().int().nonnegative().default(0).describe("Pagination offset"),
  },
  async ({ screener, country, limit, offset }) => {
    // Resolve slug or numeric ID
    let gridViewId: number;

    if (/^\d+$/.test(screener)) {
      gridViewId = parseInt(screener, 10);
    } else {
      const def = SWS_SCREENERS[screener];
      if (!def) {
        const available = Object.keys(SWS_SCREENERS).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown screener slug "${screener}". Available slugs: ${available}`,
            },
          ],
        };
      }
      gridViewId = def.id;
    }

    const data = await swsQuery(SCREENER_GQL, {
      gridViewId,
      limit,
      offset,
      displayRecentlyAddedCompanies: false,
      returnRecentCompaniesOnly: false,
      additionalFilters: [{ field: "country_name", operator: "in", logicalCondition: "aor", values: [country] }],
    });

    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "sws_company_score",
  "Get Simply Wall St snowflake scores for a company (value, future, past, health, dividend — each 0–6)",
  {
    symbol: z
      .string()
      .describe(
        "Company uniqueSymbol in exchange:ticker format (e.g. NYSE:AAPL, NASDAQ:MSFT). Use sws_search to find the correct uniqueSymbol.",
      ),
  },
  async ({ symbol }) => {
    const data = await cachedQuery("score", symbol, COMPANY_GQL, { symbol });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "sws_company_analysis",
  "Get detailed Simply Wall St analysis for a company including valuation outlook, growth forecast, past performance, financial health, and dividend income narrative",
  {
    symbol: z
      .string()
      .describe(
        "Company uniqueSymbol in exchange:ticker format (e.g. NYSE:AAPL). Use sws_search to find the correct uniqueSymbol.",
      ),
  },
  async ({ symbol }) => {
    const data = await cachedQuery("analysis", symbol, COMPANY_GQL, { symbol });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "sws_search",
  "Search Simply Wall St for companies by name or ticker symbol. Returns uniqueSymbol identifiers needed for other sws_ tools.",
  {
    query: z.string().describe("Company name or ticker to search for (e.g. Apple, AAPL, Microsoft)"),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .default(10)
      .describe("Number of results to return"),
  },
  async ({ query, limit }) => {
    const data = await swsQuery(SEARCH_GQL, { query, limit });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "sws_list_screeners",
  "List all available Simply Wall St screeners with their slug, numeric ID, and description",
  {},
  async () => {
    const screeners = Object.entries(SWS_SCREENERS).map(([slug, def]) => ({
      slug,
      id: def.id,
      description: def.description,
    }));
    return { content: [{ type: "text", text: JSON.stringify(screeners, null, 2) }] };
  },
);

server.tool(
  "sws_token_status",
  "Check whether the Simply Wall St auth token is present and not expired. Decodes the JWT expiry from the SWS_AUTH_TOKEN environment variable.",
  {},
  async () => {
    const token = process.env.SWS_AUTH_TOKEN;

    if (!token) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ valid: false, reason: "SWS_AUTH_TOKEN is not set" }, null, 2),
          },
        ],
      };
    }

    // Decode JWT payload (base64url, no signature verification)
    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ valid: false, reason: "Token is not a valid JWT (expected 3 parts)" }, null, 2),
            },
          ],
        };
      }
      // Pad base64url to standard base64
      const payload = parts[1]!;
      const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
      const decoded = JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as {
        exp?: number;
        sub?: string;
        iat?: number;
      };

      const nowSec = Math.floor(Date.now() / 1000);
      const exp = decoded.exp;
      const expired = exp !== undefined ? nowSec >= exp : false;
      const expiresAt = exp !== undefined ? new Date(exp * 1000).toISOString() : null;
      const secondsRemaining = exp !== undefined ? exp - nowSec : null;

      const result = {
        valid: !!token && !expired,
        expired,
        expiresAt,
        secondsRemaining,
        subject: decoded.sub ?? null,
        issuedAt: decoded.iat ? new Date(decoded.iat * 1000).toISOString() : null,
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ valid: false, reason: "Failed to decode JWT payload" }, null, 2),
          },
        ],
      };
    }
  },
);

// ── Start ─────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("sws MCP server error:", err);
  process.exit(1);
});
