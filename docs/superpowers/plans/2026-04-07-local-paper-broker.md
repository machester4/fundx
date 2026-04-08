# Local Paper Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Alpaca broker integration with a local paper broker that executes trades by updating `portfolio.json` directly, using FMP for market prices.

**Architecture:** Create `paper-trading.ts` with pure trade execution functions, a `broker-local` MCP server that wraps them for Claude sessions, and simplify the daemon's stop-loss monitor to use FMP + local execution. Delete all Alpaca code, credentials, live trading, and sync.

**Tech Stack:** TypeScript, MCP SDK (`@modelcontextprotocol/sdk`), FMP API, better-sqlite3, Zod

---

### Task 1: Create `paper-trading.ts` — core execution logic

**Files:**
- Create: `src/paper-trading.ts`

- [ ] **Step 1: Create `paper-trading.ts` with `executeBuy` and `executeSell`**

```typescript
// src/paper-trading.ts
import type { Portfolio } from "./types.js";

export interface TradeExecution {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  total_value: number;
  reason: string;
}

export interface PaperTradeResult {
  portfolio: Portfolio;
  trade: TradeExecution;
}

/**
 * Execute a paper buy: deduct cash, add/update position, recalculate weights.
 * Pure function — caller persists the result.
 */
export function executeBuy(
  portfolio: Portfolio,
  symbol: string,
  qty: number,
  price: number,
  stopLoss?: number,
  entryReason?: string,
): PaperTradeResult {
  const cost = qty * price;
  if (cost > portfolio.cash) {
    throw new Error(
      `Insufficient cash: need $${cost.toFixed(2)} but only $${portfolio.cash.toFixed(2)} available`,
    );
  }

  const now = new Date().toISOString();
  const positions = [...portfolio.positions];
  const existing = positions.findIndex((p) => p.symbol === symbol);

  if (existing >= 0) {
    // Add to existing position — weighted average cost
    const pos = { ...positions[existing] };
    const totalShares = pos.shares + qty;
    const totalCost = pos.avg_cost * pos.shares + price * qty;
    pos.shares = totalShares;
    pos.avg_cost = totalCost / totalShares;
    pos.current_price = price;
    pos.market_value = totalShares * price;
    pos.unrealized_pnl = (price - pos.avg_cost) * totalShares;
    pos.unrealized_pnl_pct =
      pos.avg_cost > 0 ? ((price - pos.avg_cost) / pos.avg_cost) * 100 : 0;
    if (stopLoss !== undefined) pos.stop_loss = stopLoss;
    if (entryReason) pos.entry_reason = entryReason;
    positions[existing] = pos;
  } else {
    // New position
    positions.push({
      symbol,
      shares: qty,
      avg_cost: price,
      current_price: price,
      market_value: qty * price,
      unrealized_pnl: 0,
      unrealized_pnl_pct: 0,
      weight_pct: 0, // recalculated below
      stop_loss: stopLoss,
      entry_date: now.split("T")[0],
      entry_reason: entryReason ?? "",
    });
  }

  const cash = portfolio.cash - cost;
  const positionsValue = positions.reduce((sum, p) => sum + p.market_value, 0);
  const totalValue = cash + positionsValue;

  // Recalculate weight_pct for all positions
  for (const pos of positions) {
    pos.weight_pct = totalValue > 0 ? (pos.market_value / totalValue) * 100 : 0;
  }

  return {
    portfolio: {
      last_updated: now,
      cash,
      total_value: totalValue,
      positions,
    },
    trade: {
      symbol,
      side: "buy",
      qty,
      price,
      total_value: cost,
      reason: entryReason ?? "",
    },
  };
}

/**
 * Execute a paper sell: add proceeds to cash, reduce/remove position, recalculate weights.
 * Pure function — caller persists the result.
 */
export function executeSell(
  portfolio: Portfolio,
  symbol: string,
  qty: number,
  price: number,
  reason?: string,
): PaperTradeResult {
  const positions = [...portfolio.positions.map((p) => ({ ...p }))];
  const idx = positions.findIndex((p) => p.symbol === symbol);

  if (idx < 0) {
    throw new Error(`No position found for symbol '${symbol}'`);
  }

  const pos = positions[idx];
  if (qty > pos.shares) {
    throw new Error(
      `Cannot sell ${qty} shares of ${symbol} — only ${pos.shares} held`,
    );
  }

  const proceeds = qty * price;

  if (qty === pos.shares) {
    // Close entire position
    positions.splice(idx, 1);
  } else {
    // Partial sell
    pos.shares -= qty;
    pos.current_price = price;
    pos.market_value = pos.shares * price;
    pos.unrealized_pnl = (price - pos.avg_cost) * pos.shares;
    pos.unrealized_pnl_pct =
      pos.avg_cost > 0 ? ((price - pos.avg_cost) / pos.avg_cost) * 100 : 0;
  }

  const cash = portfolio.cash + proceeds;
  const positionsValue = positions.reduce((sum, p) => sum + p.market_value, 0);
  const totalValue = cash + positionsValue;

  for (const p of positions) {
    p.weight_pct = totalValue > 0 ? (p.market_value / totalValue) * 100 : 0;
  }

  return {
    portfolio: {
      last_updated: new Date().toISOString(),
      cash,
      total_value: totalValue,
      positions,
    },
    trade: {
      symbol,
      side: "sell",
      qty,
      price,
      total_value: proceeds,
      reason: reason ?? "",
    },
  };
}
```

- [ ] **Step 2: Commit**

```
git add src/paper-trading.ts
git commit -m "feat: add paper-trading.ts with pure executeBuy/executeSell functions"
```

---

### Task 2: Create `broker-local` MCP server

**Files:**
- Create: `src/mcp/broker-local.ts`

- [ ] **Step 1: Create `src/mcp/broker-local.ts`**

```typescript
// src/mcp/broker-local.ts
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { executeBuy, executeSell } from "../paper-trading.js";

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

    // Update prices from FMP if positions exist
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
        // Return stale prices if FMP fails — better than erroring
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
```

- [ ] **Step 2: Commit**

```
git add src/mcp/broker-local.ts
git commit -m "feat: add broker-local MCP server for paper trading via FMP"
```

---

### Task 3: Wire `broker-local` into `agent.ts` and `paths.ts`

**Files:**
- Modify: `src/paths.ts:59-64`
- Modify: `src/agent.ts:1-148`

- [ ] **Step 1: Update `paths.ts` — replace `brokerAlpaca` with `brokerLocal`**

In `src/paths.ts`, replace the `brokerAlpaca` entry in `MCP_SERVERS`:

```typescript
// OLD
brokerAlpaca: join(__dirname, "mcp", IS_DEV ? "broker-alpaca.ts" : "broker-alpaca.js"),
// NEW
brokerLocal: join(__dirname, "mcp", IS_DEV ? "broker-local.ts" : "broker-local.js"),
```

- [ ] **Step 2: Rewrite `buildMcpServers` in `agent.ts`**

Remove the `getAlpacaCredentials` import. Replace the broker section with `broker-local`:

```typescript
// Remove this import:
// import { getAlpacaCredentials } from "./alpaca-helpers.js";

// Replace buildMcpServers body:
export async function buildMcpServers(
  fundName: string,
): Promise<Record<string, McpStdioConfig>> {
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(fundName);
  const paths = fundPaths(fundName);

  const servers: Record<string, McpStdioConfig> = {
    "broker-local": {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.brokerLocal],
      env: {
        FUND_DIR: paths.root,
        ...(globalConfig.market_data?.fmp_api_key
          ? { FMP_API_KEY: globalConfig.market_data.fmp_api_key }
          : {}),
      },
    },
    "market-data": {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.marketData],
      env: {
        ...(globalConfig.market_data?.fmp_api_key
          ? { FMP_API_KEY: globalConfig.market_data.fmp_api_key }
          : {}),
      },
    },
  };

  // Conditionally add telegram-notify (keep existing logic unchanged)
  if (
    globalConfig.telegram.bot_token &&
    globalConfig.telegram.chat_id &&
    fundConfig.notifications.telegram.enabled
  ) {
    const tg = fundConfig.notifications.telegram;
    const qh = fundConfig.notifications.quiet_hours;
    const telegramEnv: Record<string, string> = {
      TELEGRAM_BOT_TOKEN: globalConfig.telegram.bot_token,
      TELEGRAM_CHAT_ID: globalConfig.telegram.chat_id,
      NOTIFY_TRADE_ALERTS: String(tg.trade_alerts),
      NOTIFY_STOP_LOSS_ALERTS: String(tg.stop_loss_alerts),
      NOTIFY_DAILY_DIGEST: String(tg.daily_digest),
      NOTIFY_WEEKLY_DIGEST: String(tg.weekly_digest),
      NOTIFY_MILESTONE_ALERTS: String(tg.milestone_alerts),
      NOTIFY_DRAWDOWN_ALERTS: String(tg.drawdown_alerts),
    };
    if (qh.enabled) {
      telegramEnv.QUIET_HOURS_START = qh.start;
      telegramEnv.QUIET_HOURS_END = qh.end;
      telegramEnv.QUIET_HOURS_ALLOW_CRITICAL = String(qh.allow_critical);
    }
    servers["telegram-notify"] = {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.telegramNotify],
      env: telegramEnv,
    };
  }

  // Conditionally add SWS (keep existing logic unchanged)
  if (globalConfig.sws?.auth_token) {
    servers["sws"] = {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.sws],
      env: { SWS_AUTH_TOKEN: globalConfig.sws.auth_token },
    };
  }

  return servers;
}
```

- [ ] **Step 3: Commit**

```
git add src/paths.ts src/agent.ts
git commit -m "refactor: wire broker-local MCP into agent.ts and paths.ts"
```

---

### Task 4: Rewrite `stoploss.ts` to use FMP + local execution

**Files:**
- Modify: `src/stoploss.ts`

- [ ] **Step 1: Rewrite `stoploss.ts`**

Replace the entire file. Remove all Alpaca imports, use FMP for prices and `executeSell` for local execution:

```typescript
// src/stoploss.ts
import { loadGlobalConfig } from "./config.js";
import { readPortfolio, writePortfolio } from "./state.js";
import { openJournal, insertTrade } from "./journal.js";
import { executeSell } from "./paper-trading.js";

const FMP_BASE = "https://financialmodelingprep.com/api/v3";

// ── Stop-Loss Check ───────────────────────────────────────────

export interface StopLossEvent {
  symbol: string;
  shares: number;
  stopPrice: number;
  currentPrice: number;
  avgCost: number;
  loss: number;
  lossPct: number;
}

async function fetchPricesFromFmp(symbols: string[]): Promise<Record<string, number>> {
  const config = await loadGlobalConfig();
  const apiKey = config.market_data?.fmp_api_key;
  if (!apiKey) throw new Error("FMP_API_KEY not configured for stop-loss monitoring");

  const resp = await fetch(
    `${FMP_BASE}/quote/${symbols.join(",")}?apikey=${apiKey}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!resp.ok) throw new Error(`FMP API error ${resp.status}`);
  const data = (await resp.json()) as Array<{ symbol: string; price: number }>;
  const result: Record<string, number> = {};
  for (const item of data) result[item.symbol] = item.price;
  return result;
}

/**
 * Check all positions against their stop-loss levels.
 * Returns positions that have triggered their stop-loss.
 */
export async function checkStopLosses(
  fundName: string,
): Promise<StopLossEvent[]> {
  const portfolio = await readPortfolio(fundName);
  const positionsWithStops = portfolio.positions.filter(
    (p): p is typeof p & { stop_loss: number } =>
      p.stop_loss !== undefined && p.stop_loss > 0 && p.shares > 0,
  );

  if (positionsWithStops.length === 0) return [];

  const symbols = positionsWithStops.map((p) => p.symbol);
  const prices = await fetchPricesFromFmp(symbols);

  const triggered: StopLossEvent[] = [];

  for (const pos of positionsWithStops) {
    const currentPrice = prices[pos.symbol];
    if (currentPrice === undefined) continue;

    if (currentPrice <= pos.stop_loss) {
      const loss = (currentPrice - pos.avg_cost) * pos.shares;
      const lossPct = ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100;

      triggered.push({
        symbol: pos.symbol,
        shares: pos.shares,
        stopPrice: pos.stop_loss,
        currentPrice,
        avgCost: pos.avg_cost,
        loss,
        lossPct,
      });
    }
  }

  return triggered;
}

/**
 * Execute stop-loss sells for triggered positions.
 * Updates portfolio locally and logs trades in the journal.
 */
export async function executeStopLosses(
  fundName: string,
  events: StopLossEvent[],
): Promise<void> {
  if (events.length === 0) return;

  let portfolio = await readPortfolio(fundName);
  const db = openJournal(fundName);

  try {
    for (const event of events) {
      const result = executeSell(
        portfolio,
        event.symbol,
        event.shares,
        event.currentPrice,
        `Stop-loss triggered at $${event.stopPrice.toFixed(2)}. Current price: $${event.currentPrice.toFixed(2)}. Loss: $${event.loss.toFixed(2)} (${event.lossPct.toFixed(1)}%)`,
      );

      portfolio = result.portfolio;

      insertTrade(db, {
        timestamp: new Date().toISOString(),
        fund: fundName,
        symbol: event.symbol,
        side: "sell",
        quantity: event.shares,
        price: event.currentPrice,
        total_value: event.currentPrice * event.shares,
        order_type: "market",
        session_type: "stop_loss",
        reasoning: result.trade.reason,
      });
    }
  } finally {
    db.close();
  }

  await writePortfolio(fundName, portfolio);
}

/**
 * Auto-apply stop-loss levels based on fund risk config.
 * Sets stop_loss for positions that don't have one.
 */
export async function applyDefaultStopLosses(fundName: string): Promise<number> {
  const { loadFundConfig } = await import("./services/fund.service.js");
  const config = await loadFundConfig(fundName);
  const portfolio = await readPortfolio(fundName);
  const stopLossPct = config.risk.stop_loss_pct;

  let updated = 0;
  for (const pos of portfolio.positions) {
    if (pos.stop_loss === undefined || pos.stop_loss === 0) {
      pos.stop_loss = pos.avg_cost * (1 - stopLossPct / 100);
      updated++;
    }
  }

  if (updated > 0) {
    await writePortfolio(fundName, portfolio);
  }

  return updated;
}
```

- [ ] **Step 2: Commit**

```
git add src/stoploss.ts
git commit -m "refactor: stoploss uses FMP prices + local executeSell, no Alpaca"
```

---

### Task 5: Simplify Zod schemas in `types.ts`

**Files:**
- Modify: `src/types.ts:119-123` (fundConfigSchema broker block)
- Modify: `src/types.ts:208-215` (globalConfigSchema broker block)
- Modify: `src/types.ts:357-370` (remove LiveTradingConfirmation)
- Modify: `src/types.ts:385-398` (remove BrokerCapabilities)
- Modify: `src/types.ts:657-662` (remove fundCredentialsSchema)

- [ ] **Step 1: Simplify the `broker` block in `fundConfigSchema`**

```typescript
// OLD (lines 119-123)
  broker: z.object({
    provider: z.enum(["alpaca", "ibkr", "binance", "manual"]).default("manual"),
    mode: z.enum(["paper", "live"]).default("paper"),
    sync_enabled: z.boolean().default(true),
  }),

// NEW — passthrough() so existing configs with stale fields still parse
  broker: z.object({
    mode: z.literal("paper").default("paper"),
  }).passthrough(),
```

- [ ] **Step 2: Simplify the `broker` block in `globalConfigSchema`**

```typescript
// OLD (lines 208-215)
  broker: z
    .object({
      provider: z.string().default("manual"),
      api_key: z.string().optional(),
      secret_key: z.string().optional(),
      mode: z.enum(["paper", "live"]).default("paper"),
    })
    .default({}),

// NEW — passthrough() for backward compat with existing config.yaml files
  broker: z
    .object({})
    .passthrough()
    .default({}),
```

- [ ] **Step 3: Remove `liveTradingConfirmationSchema` and `brokerCapabilitiesSchema`**

Delete the following blocks:

```typescript
// Delete: Phase 5: Live Trading Safety Schema (lines ~357-370)
export const liveTradingConfirmationSchema = ...;
export type LiveTradingConfirmation = ...;

// Delete: Phase 5: Broker Adapter Schema (lines ~385-398)
export const brokerCapabilitiesSchema = ...;
export type BrokerCapabilities = ...;
```

- [ ] **Step 4: Remove `fundCredentialsSchema`**

Delete:

```typescript
// Delete (lines ~657-662)
export const fundCredentialsSchema = ...;
export type FundCredentials = ...;
```

- [ ] **Step 5: Commit**

```
git add src/types.ts
git commit -m "refactor: simplify broker schemas, remove live trading and credential types"
```

---

### Task 6: Delete Alpaca files and live trading

**Files:**
- Delete: `src/mcp/broker-alpaca.ts`
- Delete: `src/alpaca-helpers.ts`
- Delete: `src/sync.ts`
- Delete: `src/credentials.ts`
- Delete: `src/broker-adapter.ts`
- Delete: `src/services/live-trading.service.ts`
- Delete: `src/commands/fund/credentials.tsx`
- Delete: `src/commands/live/enable.tsx`
- Delete: `src/commands/live/disable.tsx`

- [ ] **Step 1: Delete all files**

```
rm src/mcp/broker-alpaca.ts
rm src/alpaca-helpers.ts
rm src/sync.ts
rm src/credentials.ts
rm src/broker-adapter.ts
rm src/services/live-trading.service.ts
rm src/commands/fund/credentials.tsx
rm src/commands/live/enable.tsx
rm src/commands/live/disable.tsx
```

- [ ] **Step 2: Remove `live-trading.service.js` from barrel export in `src/services/index.ts`**

Delete this line from `src/services/index.ts`:
```typescript
export * from "./live-trading.service.js";
```

- [ ] **Step 3: Commit**

```
git add -u
git commit -m "refactor: delete Alpaca broker, sync, credentials, and live trading code"
```

---

### Task 7: Fix all broken imports and references

**Files:**
- Modify: `src/services/daemon.service.ts`
- Modify: `src/services/portfolio.service.ts`
- Modify: `src/services/status.service.ts`
- Modify: `src/services/market.service.ts`
- Modify: `src/services/chat.service.ts`
- Modify: `src/services/ask.service.ts`
- Modify: `src/services/session.service.ts`
- Modify: `src/services/fund.service.ts`
- Modify: `src/services/gateway.service.ts`
- Modify: `src/commands/fund/create.tsx`

- [ ] **Step 1: Fix `daemon.service.ts`**

Remove the `syncPortfolio` import and the portfolio sync block (lines 506-518).
Keep `checkStopLosses` and `executeStopLosses` imports — they still exist but now use FMP.

```typescript
// Remove this import:
// import { syncPortfolio } from "../sync.js";

// Delete the portfolio sync block (lines ~506-518):
// if (currentTime === PORTFOLIO_SYNC_TIME) { ... syncPortfolio(name) ... }
```

- [ ] **Step 2: Fix `portfolio.service.ts`**

Remove `syncPortfolio` import and the sync branch. The service just reads local state:

```typescript
// src/services/portfolio.service.ts
import { loadFundConfig } from "./fund.service.js";
import { readPortfolio } from "../state.js";

export interface PortfolioDisplayData {
  fundDisplayName: string;
  lastUpdated: string;
  totalValue: number;
  cash: number;
  cashPct: number;
  initialCapital: number;
  pnl: number;
  pnlPct: number;
  positions: Array<{
    symbol: string;
    shares: number;
    avgCost: number;
    currentPrice: number;
    marketValue: number;
    unrealizedPnl: number;
    unrealizedPnlPct: number;
    weightPct: number;
    stopLoss: number | null;
  }>;
}

export async function getPortfolioDisplay(
  fundName: string,
): Promise<PortfolioDisplayData> {
  const config = await loadFundConfig(fundName);
  const portfolio = await readPortfolio(fundName);

  const pnl = portfolio.total_value - config.capital.initial;
  const pnlPct = (pnl / config.capital.initial) * 100;
  const cashPct =
    portfolio.total_value > 0
      ? (portfolio.cash / portfolio.total_value) * 100
      : 0;

  return {
    fundDisplayName: config.fund.display_name,
    lastUpdated: portfolio.last_updated,
    totalValue: portfolio.total_value,
    cash: portfolio.cash,
    cashPct,
    initialCapital: config.capital.initial,
    pnl,
    pnlPct,
    positions: portfolio.positions.map((pos) => ({
      symbol: pos.symbol,
      shares: pos.shares,
      avgCost: pos.avg_cost,
      currentPrice: pos.current_price,
      marketValue: pos.market_value,
      unrealizedPnl: pos.unrealized_pnl,
      unrealizedPnlPct: pos.unrealized_pnl_pct,
      weightPct: pos.weight_pct,
      stopLoss: pos.stop_loss ?? null,
    })),
  };
}
```

- [ ] **Step 3: Fix `status.service.ts`**

Remove `ALPACA_PAPER_URL` import (line 8). In `checkMarketDataStatus`, remove the `alpaca` provider branch (lines ~176-191). Hard-code `brokerMode: "paper"` in `getAllFundStatuses` (line 54).

- [ ] **Step 4: Fix `market.service.ts`**

Remove `import { ALPACA_PAPER_URL, ALPACA_DATA_URL } from "../alpaca-helpers.js"` (line 3). In `detectProvider()`, remove the alpaca credentials check (lines ~73-77) — fall through directly from FMP check to yfinance. Remove `ALPACA_INDICES` constant (lines 36-44). Remove any Alpaca data fetching functions.

- [ ] **Step 5: Fix `chat.service.ts`**

Line 275 — change `Broker: ${globalConfig.broker.provider} (${globalConfig.broker.mode} mode)` to `Mode: paper trading`.

Line 291 — change `Broker: ${config.broker.provider} (${config.broker.mode})` to `Mode: paper`.

In `buildChatMcpServers` (line ~651+): remove `globalConfig.broker.api_key`, `globalConfig.broker.secret_key`, and `ALPACA_MODE` env vars from workspace mode market-data config.

- [ ] **Step 6: Fix `ask.service.ts`**

Line 17 — change `Broker: ${config.broker.provider} (${config.broker.mode})` to `Mode: paper`.

- [ ] **Step 7: Fix `session.service.ts`**

Line 67 — change `Use MCP broker-alpaca tools for trading and position management` to `Use MCP broker-local tools for trading and position management`.

- [ ] **Step 8: Fix `fund.service.ts`**

Remove `import { hasFundCredentials } from "../credentials.js"`. Remove the `hasCreds` check in `upgradeFund` (already partially done). In `createFund`: set `broker: { mode: "paper" as const }`. Remove `brokerMode` parameter if it exists.

- [ ] **Step 9: Fix `gateway.service.ts`**

Line ~117 — change `Broker: ${config.broker.provider} (${config.broker.mode})` to `Mode: paper`.

- [ ] **Step 10: Fix `commands/fund/create.tsx`**

Remove `brokerMode` and `credentials` from the `Step` type and wizard flow. Remove `fundSpecificCredentials` from `CreationData`. In `doCreateFund`: hardcode `broker: { mode: "paper" as const }`.

- [ ] **Step 11: Fix `commands/portfolio.tsx` if it uses sync**

Check if `src/commands/portfolio.tsx` imports `syncPortfolio` or passes `sync` option. If so, remove the sync option — portfolio always reads local state.

- [ ] **Step 12: Commit**

```
git add -u
git commit -m "refactor: fix all broken imports and references after Alpaca removal"
```

---

### Task 8: Update templates and rules

**Files:**
- Modify: `src/template.ts:145-153` (session protocol)
- Modify: `src/skills.ts` (state-consistency rule — already updated earlier)
- Modify: `src/services/init.service.ts` (workspace rule reference to broker)

- [ ] **Step 1: Update session protocol in `template.ts`**

In the session protocol step 5, replace:

```typescript
// FROM:
5. **Execute** — Place trades, set stop-losses, and update all state files (\`portfolio.json\`, \`objective_tracker.json\`, \`session_log.json\`).
// TO:
5. **Execute** — Place trades via the \`broker-local\` MCP tool (\`place_order\`). This updates \`portfolio.json\` and the trade journal automatically. Set stop-losses as position metadata — the daemon monitors them. Update \`objective_tracker.json\` and \`session_log.json\`.
```

- [ ] **Step 2: Remove live trading references from `init.service.ts` workspace rules**

Find the line mentioning `fundx live enable` and change it:

```typescript
// FROM:
// - Always set `broker.mode: paper` — users enable live trading explicitly via `fundx live enable`
// TO:
// - The system operates in paper mode — trades execute locally against portfolio.json
```

- [ ] **Step 3: Commit**

```
git add src/template.ts src/skills.ts src/services/init.service.ts
git commit -m "docs: update templates and rules to reflect local paper broker"
```

---

### Task 9: Update `tsup.config.ts` and build

**Files:**
- Modify: `tsup.config.ts`

- [ ] **Step 1: Replace `broker-alpaca.ts` with `broker-local.ts` in tsup config**

```typescript
// In the second config block, change:
// "src/mcp/broker-alpaca.ts",
// To:
"src/mcp/broker-local.ts",
```

- [ ] **Step 2: Build and verify no errors**

Run `pnpm build`. Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```
git add tsup.config.ts
git commit -m "build: replace broker-alpaca with broker-local in tsup config"
```

---

### Task 10: Typecheck, build, upgrade, and verify

- [ ] **Step 1: Run typecheck**

Run `pnpm typecheck`. Expected: No type errors.

- [ ] **Step 2: Build production**

Run `pnpm build`. Expected: Compiles successfully.

- [ ] **Step 3: Upgrade all funds**

Run `pnpm dev fund upgrade --all`. Expected: All funds upgraded with new rules and CLAUDE.md.

- [ ] **Step 4: Verify Growth portfolio was preserved**

Run `cat ~/.fundx/funds/Growth/state/portfolio.json`. Expected: Positions for URA and ITA still present with correct field names.

- [ ] **Step 5: Verify the state-consistency rule was deployed**

Run `cat ~/.fundx/funds/Growth/.claude/rules/state-consistency.md`. Expected: Contains the portfolio.json schema section.

- [ ] **Step 6: Commit any remaining changes**

```
git add -A
git commit -m "chore: upgrade all funds after local paper broker migration"
```
