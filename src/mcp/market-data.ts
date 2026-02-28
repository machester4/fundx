import YahooFinance from "yahoo-finance2";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const yf = new YahooFinance();

// ── Alpaca Data API client ────────────────────────────────────

const ALPACA_DATA_URL = "https://data.alpaca.markets";

function hasAlpacaKeys(): boolean {
  return !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
}

function getHeaders(): Record<string, string> {
  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new Error("ALPACA_API_KEY and ALPACA_SECRET_KEY must be set");
  }
  return {
    "APCA-API-KEY-ID": apiKey,
    "APCA-API-SECRET-KEY": secretKey,
  };
}

// ── Yahoo Finance interval mapping ────────────────────────────

// yf.historical() only supports daily/weekly/monthly intervals.
// Intraday timeframes are clamped to "1d" since historical() has no intraday support.
function toYahooHistoricalInterval(tf: string): "1d" | "1wk" | "1mo" {
  if (tf === "1Week") return "1wk";
  if (tf === "1Month") return "1mo";
  return "1d";
}

async function dataRequest(path: string): Promise<unknown> {
  const url = `${ALPACA_DATA_URL}${path}`;
  const resp = await fetch(url, { headers: getHeaders() });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Alpaca Data API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ── FMP Data API client ───────────────────────────────────────

const FMP_BASE_URL = "https://financialmodelingprep.com/api/v3";

function getFmpApiKey(): string | undefined {
  return process.env.FMP_API_KEY;
}

async function fmpRequest(path: string): Promise<unknown> {
  const apiKey = getFmpApiKey();
  if (!apiKey) throw new Error("FMP_API_KEY is not configured");
  const separator = path.includes("?") ? "&" : "?";
  const resp = await fetch(`${FMP_BASE_URL}${path}${separator}apikey=${apiKey}`);
  if (!resp.ok) throw new Error(`FMP API error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

function fmpNotConfigured(toolName: string) {
  return {
    content: [{
      type: "text" as const,
      text: `${toolName}: FMP_API_KEY is not configured. Set market_data.fmp_api_key in ~/.fundx/config.yaml. Use Alpaca tools (get_snapshot, get_bars) as alternatives.`,
    }],
  };
}

// ── MCP Server ────────────────────────────────────────────────

const server = new McpServer(
  { name: "market-data", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── Tools ─────────────────────────────────────────────────────

server.tool(
  "get_latest_trade",
  "Get the latest trade for a symbol (last executed trade price and size). Falls back to Yahoo Finance quote when Alpaca is not configured.",
  { symbol: z.string().describe("Ticker symbol (e.g. AAPL, GDX)") },
  async ({ symbol }) => {
    if (!hasAlpacaKeys()) {
      const data = await yf.quote(symbol);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    const data = await dataRequest(
      `/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_latest_quote",
  "Get the latest NBBO quote for a symbol (best bid/ask)",
  { symbol: z.string().describe("Ticker symbol") },
  async ({ symbol }) => {
    if (!hasAlpacaKeys()) {
      const data = await yf.quote(symbol);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    const data = await dataRequest(
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_bars",
  "Get historical OHLCV bars for a symbol. Useful for technical analysis, charting, and backtesting.",
  {
    symbol: z.string().describe("Ticker symbol"),
    timeframe: z.string().default("1Day").describe("Bar timeframe: 1Min, 5Min, 15Min, 30Min, 1Hour, 4Hour, 1Day, 1Week, 1Month"),
    start: z.string().optional().describe("Start date/time (ISO 8601 or YYYY-MM-DD)"),
    end: z.string().optional().describe("End date/time (ISO 8601 or YYYY-MM-DD)"),
    limit: z.number().positive().max(10000).default(100).describe("Max number of bars to return"),
    sort: z.enum(["asc", "desc"]).default("asc").describe("Sort order by timestamp"),
  },
  async ({ symbol, timeframe, start, end, limit, sort }) => {
    if (!hasAlpacaKeys()) {
      const bars = await yf.historical(symbol, {
        period1: start ? new Date(start) : new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
        period2: end ? new Date(end) : new Date(),
        interval: toYahooHistoricalInterval(timeframe),
      });
      const sorted = sort === "desc" ? [...bars].reverse() : bars;
      return { content: [{ type: "text", text: JSON.stringify(sorted.slice(0, limit), null, 2) }] };
    }
    const params = new URLSearchParams({
      timeframe,
      limit: String(limit),
      sort,
    });
    if (start) params.set("start", start);
    if (end) params.set("end", end);

    const data = await dataRequest(
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_snapshot",
  "Get a comprehensive snapshot of a symbol: latest trade, latest quote, minute bar, daily bar, and previous daily bar",
  { symbol: z.string().describe("Ticker symbol") },
  async ({ symbol }) => {
    if (!hasAlpacaKeys()) {
      const data = await yf.quote(symbol);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    const data = await dataRequest(
      `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_multi_bars",
  "Get historical bars for multiple symbols at once. Falls back to Yahoo Finance when Alpaca is not configured.",
  {
    symbols: z.string().describe("Comma-separated ticker symbols (e.g. AAPL,MSFT,GDX)"),
    timeframe: z.string().default("1Day").describe("Bar timeframe"),
    start: z.string().optional().describe("Start date (ISO 8601 or YYYY-MM-DD)"),
    end: z.string().optional().describe("End date (ISO 8601 or YYYY-MM-DD)"),
    limit: z.number().positive().max(10000).default(100).describe("Max bars per symbol"),
  },
  async ({ symbols, timeframe, start, end, limit }) => {
    if (!hasAlpacaKeys()) {
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
    }
    const params = new URLSearchParams({
      symbols,
      timeframe,
      limit: String(limit),
    });
    if (start) params.set("start", start);
    if (end) params.set("end", end);

    const data = await dataRequest(`/v2/stocks/bars?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_multi_snapshots",
  "Get snapshots for multiple symbols at once. Falls back to Yahoo Finance when Alpaca is not configured.",
  {
    symbols: z.string().describe("Comma-separated ticker symbols (e.g. GDX,GDXJ,SLV,GLD)"),
  },
  async ({ symbols }) => {
    if (!hasAlpacaKeys()) {
      const symbolList = symbols.split(",").map((s) => s.trim());
      const data = await yf.quote(symbolList, { return: "array" });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    const params = new URLSearchParams({ symbols });
    const data = await dataRequest(`/v2/stocks/snapshots?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_market_movers",
  "Get top market movers (gainers and losers). Uses FMP if configured, falls back to Alpaca.",
  {
    market_type: z.enum(["stocks", "etfs"]).default("stocks").describe("Market type to get movers for (Alpaca fallback only)"),
    top: z.number().positive().max(50).default(10).describe("Number of top movers to return"),
  },
  async ({ market_type, top }) => {
    if (getFmpApiKey()) {
      const [gainers, losers] = await Promise.all([
        fmpRequest(`/stock_market/gainers`),
        fmpRequest(`/stock_market/losers`),
      ]);
      const result = {
        gainers: Array.isArray(gainers) ? gainers.slice(0, top) : gainers,
        losers: Array.isArray(losers) ? losers.slice(0, top) : losers,
      };
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (!hasAlpacaKeys()) {
      return {
        content: [{
          type: "text" as const,
          text: "get_market_movers: Requires FMP_API_KEY or Alpaca credentials. Set market_data.fmp_api_key in ~/.fundx/config.yaml for FMP access.",
        }],
      };
    }
    const params = new URLSearchParams({ top: String(top) });
    const data = await dataRequest(
      `/v1beta1/screener/${market_type}/movers?${params.toString()}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_news",
  "Get recent financial news articles, optionally filtered by symbols. Uses FMP if configured, falls back to Alpaca.",
  {
    symbols: z.string().optional().describe("Comma-separated symbols to filter news (e.g. AAPL,MSFT)"),
    limit: z.number().positive().max(50).default(10).describe("Number of articles"),
    start: z.string().optional().describe("Start date (YYYY-MM-DD). Maps to 'from' on FMP, 'start' on Alpaca."),
    end: z.string().optional().describe("End date (YYYY-MM-DD). Maps to 'to' on FMP, 'end' on Alpaca."),
    sort: z.enum(["asc", "desc"]).default("desc").describe("Sort order (Alpaca fallback only)"),
  },
  async ({ symbols, limit, start, end, sort }) => {
    if (getFmpApiKey()) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (symbols) params.set("tickers", symbols);
      if (start) params.set("from", start);
      if (end) params.set("to", end);
      const data = await fmpRequest(`/stock_news?${params.toString()}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    if (hasAlpacaKeys()) {
      const params = new URLSearchParams({ limit: String(limit), sort });
      if (symbols) params.set("symbols", symbols);
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      const data = await dataRequest(`/v1beta1/news?${params.toString()}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    const query = symbols ? symbols.split(",")[0] : "stock market";
    const result = await yf.search(query, { newsCount: limit });
    return { content: [{ type: "text", text: JSON.stringify(result.news ?? [], null, 2) }] };
  },
);

server.tool(
  "get_most_active",
  "Get the most actively traded symbols by volume or trade count",
  {
    by: z.enum(["volume", "trades"]).default("volume").describe("Sort by volume or trade count"),
    top: z.number().positive().max(100).default(20).describe("Number of results"),
  },
  async ({ by, top }) => {
    if (!hasAlpacaKeys()) {
      return {
        content: [{
          type: "text" as const,
          text: "get_most_active: Requires Alpaca credentials. Set broker.api_key and broker.secret_key in ~/.fundx/config.yaml.",
        }],
      };
    }
    const params = new URLSearchParams({
      by,
      top: String(top),
    });
    const data = await dataRequest(
      `/v1beta1/screener/stocks/most-actives?${params.toString()}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

// ── FMP-only tools ────────────────────────────────────────────

server.tool(
  "get_quote",
  "Get real-time quote with PE ratio, market cap, 52-week range, EPS, and next earnings date (FMP, falls back to Yahoo Finance)",
  {
    symbols: z.string().describe("Comma-separated ticker symbols (e.g. AAPL,MSFT)"),
  },
  async ({ symbols }) => {
    if (getFmpApiKey()) {
      const data = await fmpRequest(`/quote/${symbols}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    const symbolList = symbols.split(",").map((s) => s.trim());
    const data = symbolList.length === 1
      ? await yf.quote(symbolList[0])
      : await yf.quote(symbolList, { return: "array" });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_company_profile",
  "Get company profile: sector, industry, CEO, description, market cap, beta, exchange (FMP, falls back to Yahoo Finance)",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL)"),
  },
  async ({ symbol }) => {
    if (getFmpApiKey()) {
      const data = await fmpRequest(`/profile/${encodeURIComponent(symbol)}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
    const data = await yf.quoteSummary(symbol, {
      modules: ["assetProfile", "summaryDetail"],
    });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_income_statement",
  "Get income statement: revenue, net income, EPS by quarter or annual period (FMP)",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL)"),
    period: z.enum(["quarter", "annual"]).default("quarter").describe("Reporting period"),
    limit: z.number().positive().max(20).default(4).describe("Number of periods to return"),
  },
  async ({ symbol, period, limit }) => {
    if (!getFmpApiKey()) return fmpNotConfigured("get_income_statement");
    const params = new URLSearchParams({ period, limit: String(limit) });
    const data = await fmpRequest(`/income-statement/${encodeURIComponent(symbol)}?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_financial_ratios",
  "Get financial ratios: P/E, P/B, ROE, debt ratios, dividend yield by quarter or annual (FMP)",
  {
    symbol: z.string().describe("Ticker symbol (e.g. AAPL)"),
    period: z.enum(["quarter", "annual"]).default("quarter").describe("Reporting period"),
    limit: z.number().positive().max(20).default(4).describe("Number of periods to return"),
  },
  async ({ symbol, period, limit }) => {
    if (!getFmpApiKey()) return fmpNotConfigured("get_financial_ratios");
    const params = new URLSearchParams({ period, limit: String(limit) });
    const data = await fmpRequest(`/ratios/${encodeURIComponent(symbol)}?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_earnings_calendar",
  "Get upcoming earnings dates with EPS estimates and revenue estimates (FMP)",
  {
    from: z.string().describe("Start date (YYYY-MM-DD)"),
    to: z.string().describe("End date (YYYY-MM-DD)"),
    symbols: z.string().optional().describe("Comma-separated symbols to filter (client-side)"),
  },
  async ({ from, to, symbols }) => {
    if (!getFmpApiKey()) return fmpNotConfigured("get_earnings_calendar");
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
);

server.tool(
  "get_economic_calendar",
  "Get macro economic events: FOMC, CPI, NFP, GDP with impact level and consensus estimates (FMP)",
  {
    from: z.string().describe("Start date (YYYY-MM-DD)"),
    to: z.string().describe("End date (YYYY-MM-DD)"),
  },
  async ({ from, to }) => {
    if (!getFmpApiKey()) return fmpNotConfigured("get_economic_calendar");
    const params = new URLSearchParams({ from, to });
    const data = await fmpRequest(`/economic_calendar?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_sector_performance",
  "Get all 11 GICS sector percentage changes for today (FMP)",
  {},
  async () => {
    if (!getFmpApiKey()) return fmpNotConfigured("get_sector_performance");
    const data = await fmpRequest(`/sector-performance`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "search_symbol",
  "Search for a ticker symbol by company name or partial ticker (FMP)",
  {
    query: z.string().describe("Company name or partial ticker to search for"),
    limit: z.number().positive().max(50).default(10).describe("Number of results"),
  },
  async ({ query, limit }) => {
    if (!getFmpApiKey()) return fmpNotConfigured("search_symbol");
    const params = new URLSearchParams({ query, limit: String(limit) });
    const data = await fmpRequest(`/search?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
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
);

// ── Start ─────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("market-data MCP server error:", err);
  process.exit(1);
});
