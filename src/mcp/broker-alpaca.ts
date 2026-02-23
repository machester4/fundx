import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Alpaca REST client ────────────────────────────────────────

const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
const ALPACA_LIVE_URL = "https://api.alpaca.markets";
const ALPACA_DATA_URL = "https://data.alpaca.markets";

function getBaseUrl(): string {
  const mode = process.env.ALPACA_MODE ?? "paper";
  return mode === "live" ? ALPACA_LIVE_URL : ALPACA_PAPER_URL;
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
    "Content-Type": "application/json",
  };
}

async function alpacaRequest(
  path: string,
  options: { method?: string; body?: unknown; dataApi?: boolean } = {},
): Promise<unknown> {
  const base = options.dataApi ? ALPACA_DATA_URL : getBaseUrl();
  const url = `${base}${path}`;
  const headers = getHeaders();
  const resp = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Alpaca API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ── MCP Server ────────────────────────────────────────────────

const server = new McpServer(
  { name: "broker-alpaca", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── Tools ─────────────────────────────────────────────────────

server.tool(
  "get_account",
  "Get Alpaca account information including balance, equity, and buying power",
  {},
  async () => {
    const account = await alpacaRequest("/v2/account");
    return { content: [{ type: "text", text: JSON.stringify(account, null, 2) }] };
  },
);

server.tool(
  "get_positions",
  "Get all current positions with P&L information",
  {},
  async () => {
    const positions = await alpacaRequest("/v2/positions");
    return { content: [{ type: "text", text: JSON.stringify(positions, null, 2) }] };
  },
);

server.tool(
  "get_position",
  "Get a specific position by symbol",
  { symbol: z.string().describe("Ticker symbol (e.g. AAPL, GDX)") },
  async ({ symbol }) => {
    const position = await alpacaRequest(`/v2/positions/${encodeURIComponent(symbol)}`);
    return { content: [{ type: "text", text: JSON.stringify(position, null, 2) }] };
  },
);

server.tool(
  "place_order",
  "Place a buy or sell order. Returns the order object with its ID.",
  {
    symbol: z.string().describe("Ticker symbol"),
    qty: z.number().positive().describe("Number of shares"),
    side: z.enum(["buy", "sell"]).describe("Order side"),
    type: z.enum(["market", "limit", "stop", "stop_limit", "trailing_stop"]).describe("Order type"),
    time_in_force: z.enum(["day", "gtc", "opg", "cls", "ioc", "fok"]).default("day").describe("Time in force"),
    limit_price: z.number().positive().optional().describe("Limit price (required for limit and stop_limit orders)"),
    stop_price: z.number().positive().optional().describe("Stop price (required for stop and stop_limit orders)"),
    trail_percent: z.number().positive().optional().describe("Trail percent for trailing_stop orders"),
  },
  async ({ symbol, qty, side, type, time_in_force, limit_price, stop_price, trail_percent }) => {
    const body: Record<string, unknown> = {
      symbol,
      qty: String(qty),
      side,
      type,
      time_in_force,
    };
    if (limit_price !== undefined) body.limit_price = String(limit_price);
    if (stop_price !== undefined) body.stop_price = String(stop_price);
    if (trail_percent !== undefined) body.trail_percent = String(trail_percent);

    const order = await alpacaRequest("/v2/orders", {
      method: "POST",
      body,
    });
    return { content: [{ type: "text", text: JSON.stringify(order, null, 2) }] };
  },
);

server.tool(
  "cancel_order",
  "Cancel an open order by its ID",
  { order_id: z.string().describe("The order ID to cancel") },
  async ({ order_id }) => {
    await alpacaRequest(`/v2/orders/${encodeURIComponent(order_id)}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Order ${order_id} cancelled successfully.` }] };
  },
);

server.tool(
  "get_orders",
  "List orders with optional status filter",
  {
    status: z.enum(["open", "closed", "all"]).default("open").describe("Order status filter"),
    limit: z.number().positive().max(500).default(50).describe("Max number of orders to return"),
    after: z.string().optional().describe("Filter orders after this timestamp (ISO 8601)"),
    until: z.string().optional().describe("Filter orders until this timestamp (ISO 8601)"),
    direction: z.enum(["asc", "desc"]).default("desc").describe("Sort direction by submission time"),
  },
  async ({ status, limit, after, until, direction }) => {
    const params = new URLSearchParams({
      status,
      limit: String(limit),
      direction,
    });
    if (after) params.set("after", after);
    if (until) params.set("until", until);

    const orders = await alpacaRequest(`/v2/orders?${params.toString()}`);
    return { content: [{ type: "text", text: JSON.stringify(orders, null, 2) }] };
  },
);

server.tool(
  "get_quote",
  "Get the latest quote (bid/ask) for a symbol",
  { symbol: z.string().describe("Ticker symbol") },
  async ({ symbol }) => {
    const data = await alpacaRequest(
      `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest`,
      { dataApi: true },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_bars",
  "Get historical OHLCV bars for a symbol",
  {
    symbol: z.string().describe("Ticker symbol"),
    timeframe: z.string().default("1Day").describe("Bar timeframe (1Min, 5Min, 15Min, 1Hour, 1Day, 1Week, 1Month)"),
    start: z.string().optional().describe("Start date (ISO 8601 or YYYY-MM-DD)"),
    end: z.string().optional().describe("End date (ISO 8601 or YYYY-MM-DD)"),
    limit: z.number().positive().max(10000).default(100).describe("Max number of bars"),
  },
  async ({ symbol, timeframe, start, end, limit }) => {
    const params = new URLSearchParams({
      timeframe,
      limit: String(limit),
    });
    if (start) params.set("start", start);
    if (end) params.set("end", end);

    const data = await alpacaRequest(
      `/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`,
      { dataApi: true },
    );
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  "get_snapshot",
  "Get a snapshot of a symbol including latest trade, quote, minute bar, daily bar, and previous daily bar",
  { symbol: z.string().describe("Ticker symbol") },
  async ({ symbol }) => {
    const data = await alpacaRequest(
      `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`,
      { dataApi: true },
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
  console.error("broker-alpaca MCP server error:", err);
  process.exit(1);
});
