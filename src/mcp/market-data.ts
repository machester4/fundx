import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Alpaca Data API client ────────────────────────────────────

const ALPACA_DATA_URL = "https://data.alpaca.markets";

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

async function dataRequest(path: string): Promise<unknown> {
  const url = `${ALPACA_DATA_URL}${path}`;
  const resp = await fetch(url, { headers: getHeaders() });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Alpaca Data API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ── MCP Server ────────────────────────────────────────────────

const server = new McpServer(
  { name: "market-data", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── Tools ─────────────────────────────────────────────────────

server.tool(
  "get_latest_trade",
  "Get the latest trade for a symbol (last executed trade price and size)",
  { symbol: z.string().describe("Ticker symbol (e.g. AAPL, GDX)") },
  async ({ symbol }) => {
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
    const data = await dataRequest(
      `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_multi_bars",
  "Get historical bars for multiple symbols at once",
  {
    symbols: z.string().describe("Comma-separated ticker symbols (e.g. AAPL,MSFT,GDX)"),
    timeframe: z.string().default("1Day").describe("Bar timeframe"),
    start: z.string().optional().describe("Start date (ISO 8601 or YYYY-MM-DD)"),
    end: z.string().optional().describe("End date (ISO 8601 or YYYY-MM-DD)"),
    limit: z.number().positive().max(10000).default(100).describe("Max bars per symbol"),
  },
  async ({ symbols, timeframe, start, end, limit }) => {
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
  "Get snapshots for multiple symbols at once",
  {
    symbols: z.string().describe("Comma-separated ticker symbols (e.g. GDX,GDXJ,SLV,GLD)"),
  },
  async ({ symbols }) => {
    const params = new URLSearchParams({ symbols });
    const data = await dataRequest(`/v2/stocks/snapshots?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_market_movers",
  "Get top market movers (gainers and losers) by type",
  {
    market_type: z.enum(["stocks", "etfs"]).default("stocks").describe("Market type to get movers for"),
    top: z.number().positive().max(50).default(10).describe("Number of top movers to return"),
  },
  async ({ market_type, top }) => {
    const params = new URLSearchParams({ top: String(top) });
    const data = await dataRequest(
      `/v1beta1/screener/${market_type}/movers?${params.toString()}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_news",
  "Get recent financial news articles, optionally filtered by symbols",
  {
    symbols: z.string().optional().describe("Comma-separated symbols to filter news (e.g. AAPL,MSFT)"),
    limit: z.number().positive().max(50).default(10).describe("Number of articles"),
    start: z.string().optional().describe("Start date (ISO 8601)"),
    end: z.string().optional().describe("End date (ISO 8601)"),
    sort: z.enum(["asc", "desc"]).default("desc").describe("Sort order"),
  },
  async ({ symbols, limit, start, end, sort }) => {
    const params = new URLSearchParams({
      limit: String(limit),
      sort,
    });
    if (symbols) params.set("symbols", symbols);
    if (start) params.set("start", start);
    if (end) params.set("end", end);

    const data = await dataRequest(`/v1beta1/news?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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

// ── Start ─────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("market-data MCP server error:", err);
  process.exit(1);
});
