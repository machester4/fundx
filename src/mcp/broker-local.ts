import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { executeBuy, executeSell } from "../paper-trading.js";
import {
  isInQuietHoursEnv,
  shouldSendNotification,
  formatTradeAlert,
  formatStopLossAlert,
  sendTelegram,
} from "./broker-local-notify.js";

// ── State helpers ────────────────────────────────────────────

const FUND_DIR = process.env.FUND_DIR!;
const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

const portfolioPath = join(FUND_DIR, "state", "portfolio.json");
const journalPath = join(FUND_DIR, "state", "trade_journal.sqlite");

interface Position {
  symbol: string;
  shares: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  weight_pct: number;
  stop_loss?: number;
  entry_date: string;
  entry_reason: string;
}

interface Portfolio {
  last_updated: string;
  cash: number;
  total_value: number;
  positions: Position[];
}

async function readPortfolio(): Promise<Portfolio> {
  const raw = await readFile(portfolioPath, "utf-8");
  return JSON.parse(raw) as Portfolio;
}

async function writePortfolioAtomic(portfolio: Portfolio): Promise<void> {
  await mkdir(dirname(portfolioPath), { recursive: true });
  const tmp = portfolioPath + ".tmp";
  await writeFile(tmp, JSON.stringify(portfolio, null, 2), "utf-8");
  await rename(tmp, portfolioPath);
}

function logTrade(trade: {
  symbol: string;
  side: string;
  qty: number;
  price: number;
  total_value: number;
  reason: string;
  sessionType: string;
}): void {
  const db = new Database(journalPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      fund TEXT NOT NULL,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      total_value REAL NOT NULL,
      order_type TEXT NOT NULL,
      session_type TEXT,
      reasoning TEXT,
      analysis_ref TEXT,
      closed_at TEXT,
      close_price REAL,
      pnl REAL,
      pnl_pct REAL,
      lessons_learned TEXT,
      market_context TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trades_fund ON trades(fund);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
  `);
  const fundName = FUND_DIR.split("/").pop() ?? "unknown";
  db.prepare(`
    INSERT INTO trades (timestamp, fund, symbol, side, quantity, price, total_value, order_type, session_type, reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    fundName,
    trade.symbol,
    trade.side,
    trade.qty,
    trade.price,
    trade.total_value,
    "market",
    trade.sessionType,
    trade.reason,
  );
  db.close();
}

async function fetchFmpPrice(symbol: string): Promise<number> {
  if (!FMP_API_KEY) throw new Error("FMP_API_KEY not configured");
  const resp = await fetch(`${FMP_BASE}/quote/${encodeURIComponent(symbol)}?apikey=${FMP_API_KEY}`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`FMP API error ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as Array<{ symbol: string; price: number }>;
  if (!Array.isArray(data) || data.length === 0) throw new Error(`No quote data for ${symbol}`);
  return data[0].price;
}

async function fetchFmpPrices(symbols: string[]): Promise<Record<string, number>> {
  if (!FMP_API_KEY) throw new Error("FMP_API_KEY not configured");
  const resp = await fetch(
    `${FMP_BASE}/quote/${symbols.join(",")}?apikey=${FMP_API_KEY}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!resp.ok) throw new Error(`FMP API error ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as Array<{ symbol: string; price: number }>;
  const result: Record<string, number> = {};
  for (const item of data) result[item.symbol] = item.price;
  return result;
}

// ── MCP Server ───────────────────────────────────────────────

const server = new McpServer(
  { name: "broker-local", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.tool(
  "get_account",
  "Get paper account information: cash balance, total portfolio value, and number of positions",
  {},
  async () => {
    const portfolio = await readPortfolio();
    const account = {
      cash: portfolio.cash,
      total_value: portfolio.total_value,
      positions_count: portfolio.positions.length,
      last_updated: portfolio.last_updated,
      mode: "paper",
    };
    return { content: [{ type: "text", text: JSON.stringify(account, null, 2) }] };
  },
);

server.tool(
  "get_positions",
  "Get all current paper positions with P&L information",
  {},
  async () => {
    const portfolio = await readPortfolio();

    if (portfolio.positions.length > 0) {
      try {
        const symbols = portfolio.positions.map((p) => p.symbol);
        const prices = await fetchFmpPrices(symbols);
        for (const pos of portfolio.positions) {
          const price = prices[pos.symbol];
          if (price !== undefined) {
            pos.current_price = price;
            pos.market_value = pos.shares * price;
            pos.unrealized_pnl = (price - pos.avg_cost) * pos.shares;
            pos.unrealized_pnl_pct = pos.avg_cost > 0 ? ((price - pos.avg_cost) / pos.avg_cost) * 100 : 0;
          }
        }
        const positionsValue = portfolio.positions.reduce((s, p) => s + p.market_value, 0);
        portfolio.total_value = portfolio.cash + positionsValue;
        for (const pos of portfolio.positions) {
          pos.weight_pct = portfolio.total_value > 0 ? (pos.market_value / portfolio.total_value) * 100 : 0;
        }
        await writePortfolioAtomic(portfolio);
      } catch {
        // Return stale prices if FMP fails
      }
    }

    return { content: [{ type: "text", text: JSON.stringify(portfolio.positions, null, 2) }] };
  },
);

server.tool(
  "get_position",
  "Get a specific paper position by symbol",
  { symbol: z.string().describe("Ticker symbol (e.g. AAPL, GDX)") },
  async ({ symbol }) => {
    const portfolio = await readPortfolio();
    const pos = portfolio.positions.find((p) => p.symbol === symbol.toUpperCase());
    if (!pos) {
      return { content: [{ type: "text", text: `No position found for ${symbol}` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(pos, null, 2) }] };
  },
);

server.tool(
  "place_order",
  "Place a paper buy or sell order. Fetches current market price from FMP and executes immediately. Returns the updated position and trade details.",
  {
    symbol: z.string().describe("Ticker symbol"),
    qty: z.number().positive().describe("Number of shares"),
    side: z.enum(["buy", "sell"]).describe("Order side"),
    stop_loss: z.number().positive().optional().describe("Stop-loss price (set on buy, optional)"),
    entry_reason: z.string().optional().describe("Thesis or reason for the trade"),
  },
  async ({ symbol, qty, side, stop_loss, entry_reason }) => {
    const price = await fetchFmpPrice(symbol.toUpperCase());
    const portfolio = await readPortfolio();

    // Save position info before sell so we can compute accurate loss for stop-loss alerts
    const preSellPosition = side === "sell"
      ? portfolio.positions.find((p) => p.symbol === symbol.toUpperCase())
      : undefined;

    const result = side === "buy"
      ? executeBuy(portfolio, symbol.toUpperCase(), qty, price, stop_loss, entry_reason)
      : executeSell(portfolio, symbol.toUpperCase(), qty, price, entry_reason);

    await writePortfolioAtomic(result.portfolio);

    logTrade({
      symbol: symbol.toUpperCase(),
      side,
      qty,
      price,
      total_value: result.trade.total_value,
      reason: result.trade.reason,
      sessionType: "agent",
    });

    // ── Notify via Telegram (best-effort) ──────────────────────
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      const fundDisplayName = FUND_DIR.split("/").pop() ?? "unknown";
      const isStopLoss = /stop/i.test(entry_reason ?? "");
      const notifyEnabled = isStopLoss
        ? process.env.NOTIFY_STOP_LOSS_ALERTS !== "false"
        : process.env.NOTIFY_TRADE_ALERTS !== "false";

      if (notifyEnabled) {
        const inQuiet = isInQuietHoursEnv(
          process.env.QUIET_HOURS_START,
          process.env.QUIET_HOURS_END,
        );
        const allowCrit = process.env.QUIET_HOURS_ALLOW_CRITICAL === "true";

        if (shouldSendNotification(inQuiet, isStopLoss, allowCrit)) {
          let message: string;
          if (isStopLoss) {
            // Use pre-sell avg_cost for accurate loss computation
            const avgCost = preSellPosition?.avg_cost ?? price;
            const loss = (price - avgCost) * qty;
            const lossPct = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;
            message = formatStopLossAlert(
              fundDisplayName,
              symbol.toUpperCase(),
              qty,
              price,
              loss,
              lossPct,
            );
          } else {
            message = formatTradeAlert(
              fundDisplayName,
              symbol.toUpperCase(),
              side,
              qty,
              price,
              entry_reason,
            );
          }
          await sendTelegram(botToken, chatId, message);
        }
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "filled",
          ...result.trade,
          portfolio_cash: result.portfolio.cash,
          portfolio_total_value: result.portfolio.total_value,
        }, null, 2),
      }],
    };
  },
);

server.tool(
  "get_quote",
  "Get the current market price for a symbol via FMP",
  { symbol: z.string().describe("Ticker symbol") },
  async ({ symbol }) => {
    const price = await fetchFmpPrice(symbol.toUpperCase());
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ symbol: symbol.toUpperCase(), price, timestamp: new Date().toISOString() }, null, 2),
      }],
    };
  },
);

// ── Start ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("broker-local MCP server error:", err);
  process.exit(1);
});
