/**
 * market-data MCP server — in-process edition.
 *
 * Previously a stdio subprocess; now registered as an in-process SDK server via
 * `createSdkMcpServer`. This lets the `get_rss_news` tool share the daemon's
 * zvec handle (zvec 0.2.3 is single-writer), and also saves one subprocess
 * per agent session.
 */
import YahooFinance from "yahoo-finance2";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { queryArticles } from "../services/news.service.js";

const yf = new YahooFinance();

// ── Yahoo Finance interval mapping ────────────────────────────

// yf.historical() only supports daily/weekly/monthly intervals.
// Intraday timeframes are clamped to "1d" since historical() has no intraday support.
function toYahooHistoricalInterval(tf: string): "1d" | "1wk" | "1mo" {
  if (tf === "1Week") return "1wk";
  if (tf === "1Month") return "1mo";
  return "1d";
}

// ── FMP Data API client ───────────────────────────────────────

const FMP_BASE_URL = "https://financialmodelingprep.com/api/v3";

function buildFmpRequest(fmpApiKey: string | undefined) {
  return async function fmpRequest(path: string): Promise<unknown> {
    if (!fmpApiKey) throw new Error("FMP_API_KEY is not configured");
    const separator = path.includes("?") ? "&" : "?";
    const resp = await fetch(`${FMP_BASE_URL}${path}${separator}apikey=${fmpApiKey}`);
    if (!resp.ok) throw new Error(`FMP API error ${resp.status}: ${await resp.text()}`);
    return resp.json();
  };
}

function fmpNotConfigured(toolName: string) {
  return {
    content: [{
      type: "text" as const,
      text: `${toolName}: FMP_API_KEY is not configured. Set market_data.fmp_api_key in ~/.fundx/config.yaml.`,
    }],
  };
}

// ── Factory ──────────────────────────────────────────────────

export interface MarketDataMcpOptions {
  /** Optional FMP API key. When absent, FMP-only tools report "not configured" and FMP/Yahoo hybrid tools fall back to Yahoo. */
  fmpApiKey?: string;
}

/**
 * Build the in-process market-data MCP server.
 *
 * Pass the returned `McpSdkServerConfigWithInstance` as a value in the
 * `mcpServers` record of Agent SDK's `query()` options.
 */
export function createMarketDataMcpServer(
  opts: MarketDataMcpOptions = {},
): McpSdkServerConfigWithInstance {
  const fmpApiKey = opts.fmpApiKey;
  const fmpRequest = buildFmpRequest(fmpApiKey);
  const hasFmp = () => !!fmpApiKey;

  const tools = [
    tool(
      "get_latest_trade",
      "Get the latest trade for a symbol (last executed trade price and size) via Yahoo Finance quote.",
      { symbol: z.string().describe("Ticker symbol (e.g. AAPL, GDX)") },
      async ({ symbol }) => {
        const data = await yf.quote(symbol);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_latest_quote",
      "Get the latest quote for a symbol (bid/ask) via Yahoo Finance",
      { symbol: z.string().describe("Ticker symbol") },
      async ({ symbol }) => {
        const data = await yf.quote(symbol);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_bars",
      "Get historical OHLCV bars for a symbol via Yahoo Finance. Useful for technical analysis, charting, and backtesting.",
      {
        symbol: z.string().describe("Ticker symbol"),
        timeframe: z.string().default("1Day").describe("Bar timeframe: 1Day, 1Week, 1Month (intraday clamped to 1Day)"),
        start: z.string().optional().describe("Start date/time (ISO 8601 or YYYY-MM-DD)"),
        end: z.string().optional().describe("End date/time (ISO 8601 or YYYY-MM-DD)"),
        limit: z.number().positive().max(10000).default(100).describe("Max number of bars to return"),
        sort: z.enum(["asc", "desc"]).default("asc").describe("Sort order by timestamp"),
      },
      async ({ symbol, timeframe, start, end, limit, sort }) => {
        const bars = await yf.historical(symbol, {
          period1: start ? new Date(start) : new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
          period2: end ? new Date(end) : new Date(),
          interval: toYahooHistoricalInterval(timeframe),
        });
        const sorted = sort === "desc" ? [...bars].reverse() : bars;
        return { content: [{ type: "text", text: JSON.stringify(sorted.slice(0, limit), null, 2) }] };
      },
    ),

    tool(
      "get_snapshot",
      "Get a comprehensive snapshot of a symbol via Yahoo Finance: price, volume, market cap, day range, 52-week range",
      { symbol: z.string().describe("Ticker symbol") },
      async ({ symbol }) => {
        const data = await yf.quote(symbol);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_multi_bars",
      "Get historical bars for multiple symbols at once via Yahoo Finance.",
      {
        symbols: z.string().describe("Comma-separated ticker symbols (e.g. AAPL,MSFT,GDX)"),
        timeframe: z.string().default("1Day").describe("Bar timeframe"),
        start: z.string().optional().describe("Start date (ISO 8601 or YYYY-MM-DD)"),
        end: z.string().optional().describe("End date (ISO 8601 or YYYY-MM-DD)"),
        limit: z.number().positive().max(10000).default(100).describe("Max bars per symbol"),
      },
      async ({ symbols, timeframe, start, end, limit: _limit }) => {
        const symbolList = symbols.split(",").map((s) => s.trim());
        const period1 = start ? new Date(start) : new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
        const period2 = end ? new Date(end) : new Date();
        const interval = toYahooHistoricalInterval(timeframe);
        const results: Record<string, unknown[]> = {};
        await Promise.all(
          symbolList.map(async (sym) => {
            results[sym] = await yf.historical(sym, { period1, period2, interval });
          }),
        );
        return { content: [{ type: "text", text: JSON.stringify({ bars: results }, null, 2) }] };
      },
    ),

    tool(
      "get_multi_snapshots",
      "Get snapshots for multiple symbols at once via Yahoo Finance.",
      {
        symbols: z.string().describe("Comma-separated ticker symbols (e.g. GDX,GDXJ,SLV,GLD)"),
      },
      async ({ symbols }) => {
        const symbolList = symbols.split(",").map((s) => s.trim());
        const data = await yf.quote(symbolList, { return: "array" });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_market_movers",
      "Get top market movers (gainers and losers) via FMP.",
      {
        top: z.number().positive().max(50).default(10).describe("Number of top movers to return"),
      },
      async ({ top }) => {
        if (!hasFmp()) return fmpNotConfigured("get_market_movers");
        const [gainers, losers] = await Promise.all([
          fmpRequest(`/stock_market/gainers`),
          fmpRequest(`/stock_market/losers`),
        ]);
        const result = {
          gainers: Array.isArray(gainers) ? gainers.slice(0, top) : gainers,
          losers: Array.isArray(losers) ? losers.slice(0, top) : losers,
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      },
    ),

    tool(
      "get_news",
      "Get recent financial news articles, optionally filtered by symbols. Uses FMP if configured, falls back to Yahoo Finance search.",
      {
        symbols: z.string().optional().describe("Comma-separated symbols to filter news (e.g. AAPL,MSFT)"),
        limit: z.number().positive().max(50).default(10).describe("Number of articles"),
        start: z.string().optional().describe("Start date (YYYY-MM-DD). Maps to 'from' on FMP."),
        end: z.string().optional().describe("End date (YYYY-MM-DD). Maps to 'to' on FMP."),
      },
      async ({ symbols, limit, start, end }) => {
        if (hasFmp()) {
          const params = new URLSearchParams({ limit: String(limit) });
          if (symbols) params.set("tickers", symbols);
          if (start) params.set("from", start);
          if (end) params.set("to", end);
          const data = await fmpRequest(`/stock_news?${params.toString()}`);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
        const query = symbols ? symbols.split(",")[0] : "stock market";
        const result = await yf.search(query, { newsCount: limit });
        return { content: [{ type: "text", text: JSON.stringify(result.news ?? [], null, 2) }] };
      },
    ),

    tool(
      "get_rss_news",
      "Search cached RSS news articles from Bloomberg, Reuters, CNBC, etc. Supports semantic search and filtering by source, category, symbols, or time range.",
      {
        query: z.string().optional().describe("Semantic search query (e.g. 'gold miners selloff', 'monetary policy')"),
        symbols: z.string().optional().describe("Filter by ticker symbols (comma-separated, e.g. GDXJ,GLD)"),
        category: z.string().optional().describe("Filter by category (macro, market, sector, commodity)"),
        source: z.string().optional().describe("Filter by source name (Bloomberg, Reuters, CNBC, MarketWatch)"),
        hours: z.number().positive().default(24).describe("Look back N hours (default 24)"),
        limit: z.number().positive().max(50).default(20).describe("Max articles to return"),
      },
      async ({ query, symbols, category, source, hours, limit }) => {
        try {
          const result = await queryArticles({ query, symbols, category, source, hours, limit });
          if (result.status === "unavailable") {
            const isLockError = /lock|read-write/i.test(result.reason);
            const text = isLockError
              ? `RSS news cache is locked by the FundX daemon process and cannot be queried from this subprocess. This is a known limitation of the single-writer zvec store. Use \`get_news\` (FMP/Yahoo) for live news, or read recent news from analysis notes. Do NOT assume "no news" means "no events".`
              : `RSS news cache unavailable (${result.reason}). Proceed without editorial news or retry later; do not assume "no news" means "no events".`;
            return { content: [{ type: "text", text }] };
          }
          if (result.status === "empty") {
            return {
              content: [{
                type: "text",
                text: "No RSS news articles found matching your criteria. The cache is healthy — this means nothing in the window matched. Try broadening the time range or dropping filters.",
              }],
            };
          }
          const formatted = result.articles.map((a) => ({
            title: a.title,
            source: a.source,
            category: a.category,
            published: a.published_at,
            symbols: a.symbols,
            snippet: a.snippet,
            url: a.url,
            ...(a.score !== undefined && { relevance: a.score }),
          }));
          return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error querying RSS news: ${err instanceof Error ? err.message : err}` }] };
        }
      },
    ),

    // ── FMP-only / FMP-with-fallback tools ──────────────────────

    tool(
      "get_quote",
      "Get real-time quote with PE ratio, market cap, 52-week range, EPS, and next earnings date (FMP, falls back to Yahoo Finance)",
      {
        symbols: z.string().describe("Comma-separated ticker symbols (e.g. AAPL,MSFT)"),
      },
      async ({ symbols }) => {
        if (hasFmp()) {
          const data = await fmpRequest(`/quote/${symbols}`);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
        const symbolList = symbols.split(",").map((s) => s.trim());
        const data = symbolList.length === 1
          ? await yf.quote(symbolList[0])
          : await yf.quote(symbolList, { return: "array" });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_company_profile",
      "Get company profile: sector, industry, CEO, description, market cap, beta, exchange (FMP, falls back to Yahoo Finance)",
      {
        symbol: z.string().describe("Ticker symbol (e.g. AAPL)"),
      },
      async ({ symbol }) => {
        if (hasFmp()) {
          const data = await fmpRequest(`/profile/${encodeURIComponent(symbol)}`);
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }
        const data = await yf.quoteSummary(symbol, {
          modules: ["assetProfile", "summaryDetail"],
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_income_statement",
      "Get income statement: revenue, net income, EPS by quarter or annual period (FMP)",
      {
        symbol: z.string().describe("Ticker symbol (e.g. AAPL)"),
        period: z.enum(["quarter", "annual"]).default("quarter").describe("Reporting period"),
        limit: z.number().positive().max(20).default(4).describe("Number of periods to return"),
      },
      async ({ symbol, period, limit }) => {
        if (!hasFmp()) return fmpNotConfigured("get_income_statement");
        const params = new URLSearchParams({ period, limit: String(limit) });
        const data = await fmpRequest(`/income-statement/${encodeURIComponent(symbol)}?${params.toString()}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_financial_ratios",
      "Get financial ratios: P/E, P/B, ROE, debt ratios, dividend yield by quarter or annual (FMP)",
      {
        symbol: z.string().describe("Ticker symbol (e.g. AAPL)"),
        period: z.enum(["quarter", "annual"]).default("quarter").describe("Reporting period"),
        limit: z.number().positive().max(20).default(4).describe("Number of periods to return"),
      },
      async ({ symbol, period, limit }) => {
        if (!hasFmp()) return fmpNotConfigured("get_financial_ratios");
        const params = new URLSearchParams({ period, limit: String(limit) });
        const data = await fmpRequest(`/ratios/${encodeURIComponent(symbol)}?${params.toString()}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_earnings_calendar",
      "Get upcoming earnings dates with EPS estimates and revenue estimates (FMP)",
      {
        from: z.string().describe("Start date (YYYY-MM-DD)"),
        to: z.string().describe("End date (YYYY-MM-DD)"),
        symbols: z.string().optional().describe("Comma-separated symbols to filter (client-side)"),
      },
      async ({ from, to, symbols }) => {
        if (!hasFmp()) return fmpNotConfigured("get_earnings_calendar");
        const params = new URLSearchParams({ from, to });
        const data = await fmpRequest(`/earning_calendar?${params.toString()}`);
        if (symbols && Array.isArray(data)) {
          const tickers = symbols.toUpperCase().split(",").map((s) => s.trim());
          const filtered = (data as Array<{ symbol?: string }>).filter(
            (item) => item.symbol && tickers.includes(item.symbol.toUpperCase()),
          );
          return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_economic_calendar",
      "Get macro economic events: FOMC, CPI, NFP, GDP with impact level and consensus estimates (FMP)",
      {
        from: z.string().describe("Start date (YYYY-MM-DD)"),
        to: z.string().describe("End date (YYYY-MM-DD)"),
      },
      async ({ from, to }) => {
        if (!hasFmp()) return fmpNotConfigured("get_economic_calendar");
        const params = new URLSearchParams({ from, to });
        const data = await fmpRequest(`/economic_calendar?${params.toString()}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_sector_performance",
      "Get all 11 GICS sector percentage changes for today (FMP)",
      {},
      async () => {
        if (!hasFmp()) return fmpNotConfigured("get_sector_performance");
        const data = await fmpRequest(`/sector-performance`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "search_symbol",
      "Search for a ticker symbol by company name or partial ticker (FMP)",
      {
        query: z.string().describe("Company name or partial ticker to search for"),
        limit: z.number().positive().max(50).default(10).describe("Number of results"),
      },
      async ({ query, limit }) => {
        if (!hasFmp()) return fmpNotConfigured("search_symbol");
        const params = new URLSearchParams({ query, limit: String(limit) });
        const data = await fmpRequest(`/search?${params.toString()}`);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    ),

    tool(
      "get_options_chain",
      "Get options chain (calls and puts) for a symbol with strikes, expiry, IV, delta (Yahoo Finance)",
      {
        symbol: z.string().describe("Ticker symbol (e.g. AAPL)"),
        date: z.string().optional().describe("Expiration date (YYYY-MM-DD). Omit for nearest expiry."),
      },
      async ({ symbol, date }) => {
        const options = await yf.options(symbol, date ? { date: new Date(date) } : undefined);
        return { content: [{ type: "text", text: JSON.stringify(options, null, 2) }] };
      },
    ),
  ];

  return createSdkMcpServer({
    name: "market-data",
    version: "0.1.0",
    tools,
  });
}
