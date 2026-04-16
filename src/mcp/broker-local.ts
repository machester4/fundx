import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import yaml from "js-yaml";
import { executeBuy, executeSell } from "../paper-trading.js";
import {
  isInQuietHoursEnv,
  shouldSendNotification,
  formatTradeAlert,
  formatStopLossAlert,
  sendTelegram,
} from "./broker-local-notify.js";
import { fundConfigSchema, fmpScreenerFiltersSchema } from "../types.js";
import type { UniverseResolution, FundConfig } from "../types.js";
import type { UpdateUniverseInput } from "./broker-local-universe.js";
import {
  resolveUniverse,
  checkSectorExclusion,
  isInUniverse,
  invalidateUniverseCache,
} from "../services/universe.service.js";
import {
  handleCheckUniverse,
  handleListUniverse,
  handleBuyGate,
  handleUpdateUniverse,
  MIN_OOU_REASON_LENGTH,
} from "./broker-local-universe.js";
import { getCompanyProfile } from "../services/market.service.js";

// ── State helpers ────────────────────────────────────────────

const FUND_DIR = process.env.FUND_DIR!;
const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

// Lazy path getters — evaluated at call time so tests importing pure handlers
// don't trigger errors when FUND_DIR is undefined.
function getPortfolioPath(): string { return join(FUND_DIR, "state", "portfolio.json"); }
function getJournalPath(): string { return join(FUND_DIR, "state", "trade_journal.sqlite"); }

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
  const raw = await readFile(getPortfolioPath(), "utf-8");
  return JSON.parse(raw) as Portfolio;
}

async function writePortfolioAtomic(portfolio: Portfolio): Promise<void> {
  const portfolioPath = getPortfolioPath();
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
  outOfUniverse?: boolean;
  outOfUniverseReason?: string | null;
}): void {
  const db = new Database(getJournalPath());
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
      market_context TEXT,
      out_of_universe INTEGER NOT NULL DEFAULT 0,
      out_of_universe_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trades_fund ON trades(fund);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
  `);
  // Idempotent column additions for databases created before these columns existed.
  // SQLite ALTER TABLE ADD COLUMN throws if the column already exists, so we catch
  // and ignore the duplicate-column error to make upgrades safe.
  try { db.exec(`ALTER TABLE trades ADD COLUMN out_of_universe INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE trades ADD COLUMN out_of_universe_reason TEXT`); } catch { /* already exists */ }
  const fundName = FUND_DIR.split("/").pop() ?? "unknown";
  db.prepare(`
    INSERT INTO trades (timestamp, fund, symbol, side, quantity, price, total_value, order_type, session_type, reasoning, out_of_universe, out_of_universe_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    trade.outOfUniverse ? 1 : 0,
    trade.outOfUniverseReason ?? null,
  );
  db.close();
}

// ── Fund config (cached) ─────────────────────────────────────
// Cache scope: per-MCP-subprocess. The broker-local MCP is spawned fresh
// at each session start, so this cache is never stale across sessions.
// Invalidates on:
//   - update_universe write (sets cachedFundConfig = null)
//   - fund_config.yaml mtime advance (external edits)
interface CachedFundConfig {
  value: FundConfig;
  mtimeMs: number;
}
let cachedFundConfig: CachedFundConfig | null = null;

export async function loadFundConfigForMcp(): Promise<FundConfig> {
  // Read FUND_DIR lazily (from env) so tests can set process.env.FUND_DIR before calling.
  const yamlPath = join(process.env.FUND_DIR!, "fund_config.yaml");
  const stats = await stat(yamlPath);
  if (cachedFundConfig && cachedFundConfig.mtimeMs === stats.mtimeMs) {
    return cachedFundConfig.value;
  }
  const raw = await readFile(yamlPath, "utf-8");
  const parsed = yaml.load(raw);
  const validated = fundConfigSchema.parse(parsed);
  cachedFundConfig = { value: validated, mtimeMs: stats.mtimeMs };
  return validated;
}

/** For tests only. */
export function _resetFundConfigCacheForTests(): void {
  cachedFundConfig = null;
}

function fundNameFromEnv(): string {
  return basename(FUND_DIR);
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
  "Place a paper buy or sell order. Fetches current market price from FMP and executes immediately. For buys, the ticker is checked against this fund's universe (see check_universe). Hard-excluded tickers/sectors cannot be traded. Out-of-universe tickers require out_of_universe_reason (>=20 chars) describing a material, time-sensitive thesis. Sells are always allowed. Returns the updated position and trade details.",
  {
    symbol: z.string().describe("Ticker symbol"),
    qty: z.number().positive().describe("Number of shares"),
    side: z.enum(["buy", "sell"]).describe("Order side"),
    stop_loss: z.number().positive().optional().describe("Stop-loss price (set on buy, optional)"),
    entry_reason: z.string().optional().describe("Thesis or reason for the trade"),
    out_of_universe_reason: z.string().optional().describe(`Required when buying a ticker outside the fund universe (>=${MIN_OOU_REASON_LENGTH} chars)`),
  },
  async ({ symbol, qty, side, stop_loss, entry_reason, out_of_universe_reason }) => {
    // Universe gate: buys only — sells are always allowed
    let outOfUniverse = false;
    let outOfUniverseReason: string | null = null;
    if (side === "buy") {
      if (!FMP_API_KEY) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "FMP_API_KEY not configured for universe check" }) }] };
      }
      const cfg = await loadFundConfigForMcp();
      const fundName = fundNameFromEnv();
      const apiKey = FMP_API_KEY;
      const resolve = () => resolveUniverse(fundName, cfg.universe, apiKey);
      const checkSector = (t: string, res: UniverseResolution) => checkSectorExclusion(res, t, apiKey);
      const gate = await handleBuyGate({ symbol, out_of_universe_reason }, { resolve, checkSector });
      if (!gate.ok) {
        return { content: [{ type: "text", text: JSON.stringify({ error: gate.code, message: gate.message }) }] };
      }
      outOfUniverse = gate.out_of_universe;
      outOfUniverseReason = gate.out_of_universe_reason;
    } else {
      // Sell: universe gate does NOT apply (always allow), but tag the journal
      // with whether the sold ticker is currently out-of-universe (for audit).
      if (FMP_API_KEY) {
        try {
          const cfg = await loadFundConfigForMcp();
          const fundName = fundNameFromEnv();
          const resolution = await resolveUniverse(fundName, cfg.universe, FMP_API_KEY);
          const status = isInUniverse(resolution, symbol.toUpperCase());
          // Only set the flag when we can confirm; leave false on uncertain.
          outOfUniverse = !status.in_universe && !status.exclude_hard_block;
        } catch {
          // Swallow — journal will report outOfUniverse=false (conservative default).
        }
      }
    }

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
      outOfUniverse,
      outOfUniverseReason,
    });

    // ── Notify via Telegram (best-effort) ──────────────────────
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      const fundDisplayName = FUND_DIR.split("/").pop() ?? "unknown";
      const isStopLoss = /stop/i.test(entry_reason ?? "");
      const notifyEnabled = isStopLoss
        ? process.env.NOTIFY_STOP_LOSS_ALERTS === "true"
        : process.env.NOTIFY_TRADE_ALERTS === "true";

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
            // For regular sells, compute realized P&L
            const sellPnl = preSellPosition ? (price - preSellPosition.avg_cost) * qty : undefined;
            const sellPnlPct = preSellPosition && preSellPosition.avg_cost > 0
              ? ((price - preSellPosition.avg_cost) / preSellPosition.avg_cost) * 100
              : undefined;
            message = formatTradeAlert(
              fundDisplayName,
              symbol.toUpperCase(),
              side,
              qty,
              price,
              entry_reason,
              sellPnl,
              sellPnlPct,
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

server.tool(
  "check_universe",
  "Check whether a ticker is in this fund's universe, and why. Returns base_match, include_override, exclude_hard_block, requires_justification.",
  { ticker: z.string().describe("The ticker symbol to check (e.g. 'AAPL')") },
  async (args) => {
    if (!FMP_API_KEY) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "FMP_API_KEY not set" }) }] };
    }
    const cfg = await loadFundConfigForMcp();
    const fundName = fundNameFromEnv();
    const apiKey = FMP_API_KEY;
    const resolve = () => resolveUniverse(fundName, cfg.universe, apiKey);
    const checkSector = (t: string, res: UniverseResolution) => checkSectorExclusion(res, t, apiKey);
    const r = await handleCheckUniverse({ ticker: args.ticker }, { resolve, checkSector });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

server.tool(
  "list_universe",
  "List this fund's resolved universe tickers. Optionally filter by sector (preset mode performs profile lookups with 10x concurrency; defaults limit to 50 when sector is set). Pass verbose: true to also return the current include/exclude config lists — required before calling update_universe to add/remove individual items.",
  {
    sector: z.string().optional().describe("Filter to tickers in this sector (e.g. 'Technology')"),
    limit: z.number().int().positive().optional().describe("Max tickers to return"),
    verbose: z.boolean().optional().describe("When true, include current include/exclude config lists in the output (needed to modify the universe via update_universe)"),
  },
  async (args) => {
    if (!FMP_API_KEY) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "FMP_API_KEY not set" }) }] };
    }
    const cfg = await loadFundConfigForMcp();
    const fundName = fundNameFromEnv();
    const apiKey = FMP_API_KEY;
    const resolve = () => resolveUniverse(fundName, cfg.universe, apiKey);
    const getProfile = (t: string) => getCompanyProfile(t, apiKey);
    const r = await handleListUniverse(args, { resolve, getProfile });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  },
);

server.tool(
  "update_universe",
  "Mutate this fund's universe. Validates with Zod, writes fund_config.yaml atomically, invalidates resolver cache, and regenerates CLAUDE.md. Use this instead of editing fund_config.yaml directly. Pass dry_run: true to preview the diff + resolved count + warnings WITHOUT committing.",
  {
    mode: z.object({
      preset: z.enum(["sp500", "nasdaq100", "dow30"]).optional().describe("Switch to a canonical index preset"),
      filters: fmpScreenerFiltersSchema.optional().describe("Switch to custom FMP screener filters. If provided, REPLACES any current filters. Must pass Zod validation (see universe schema)."),
    }).optional().describe("Change the universe source. Omit to keep current preset/filters. Pass exactly one of preset OR filters."),
    include_tickers: z.array(z.string()).optional().describe("REPLACES the current include_tickers list (always-include tickers, bypass universe filters)"),
    exclude_tickers: z.array(z.string()).optional().describe("REPLACES the current exclude_tickers list (hard-block these tickers)"),
    exclude_sectors: z.array(z.string()).optional().describe("REPLACES the current exclude_sectors list (hard-block these sectors, FMP canonical names like 'Technology', 'Energy')"),
    dry_run: z.boolean().optional().describe("Preview the change without persisting. Returns the same output shape with dry_run=true. Note: the resolver cache may be updated with the preview resolution — run `refresh-universe` to restore if needed."),
  },
  async (args) => {
    try {
      const r = await handleUpdateUniverse(args as UpdateUniverseInput, {
        loadCurrentConfig: async () => {
          // Bypass the module cache to always read fresh
          const yamlPath = join(FUND_DIR, "fund_config.yaml");
          const raw = await readFile(yamlPath, "utf-8");
          return fundConfigSchema.parse(yaml.load(raw));
        },
        writeConfigYaml: async (config) => {
          const yamlPath = join(FUND_DIR, "fund_config.yaml");
          const tmp = `${yamlPath}.tmp`;
          await writeFile(tmp, yaml.dump(config, { lineWidth: 120 }), "utf-8");
          await rename(tmp, yamlPath);
          cachedFundConfig = null; // invalidate module cache
        },
        invalidateUniverseCache: async () => {
          const fundName = fundNameFromEnv();
          await invalidateUniverseCache(fundName);
        },
        regenerateClaudeMd: async (config) => {
          const { generateFundClaudeMd } = await import("../template.js");
          await generateFundClaudeMd(config);
        },
        resolveNewUniverse: async (config, opts) => {
          if (!FMP_API_KEY) throw new Error("FMP_API_KEY not configured for post-write validation");
          const fundName = fundNameFromEnv();
          return resolveUniverse(fundName, config.universe, FMP_API_KEY, {
            force: true,
            persist: !opts.dryRun,
          });
        },
        auditLog: async (entry) => {
          const { join: pathJoin } = await import("node:path");
          const { appendFile, mkdir: mkdirAsync } = await import("node:fs/promises");
          const auditPath = pathJoin(FUND_DIR, "state", "universe_audit.log");
          const line = JSON.stringify({ ...entry, source: "update_universe" }) + "\n";
          await mkdirAsync(pathJoin(FUND_DIR, "state"), { recursive: true });
          await appendFile(auditPath, line, "utf-8");
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }] };
    }
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
