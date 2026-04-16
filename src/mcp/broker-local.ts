import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
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
import { fundConfigSchema, universeSchema } from "../types.js";
import type { UniverseResolution, FundConfig, Universe, UniversePreset, FmpScreenerFilters } from "../types.js";
import {
  resolveUniverse,
  checkSectorExclusion,
  isInUniverse,
} from "../services/universe.service.js";
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

// ── Fund config (cached) ──────────────────────────────────────
// Cache scope: per-MCP-subprocess. The broker-local MCP is spawned fresh
// at each session start, so this cache is never stale across sessions.
// Mid-session YAML edits to fund_config.yaml are NOT picked up — restart
// the session (or the daemon) to apply config changes.
let cachedFundConfig: FundConfig | null = null;

async function loadFundConfigForMcp(): Promise<FundConfig> {
  if (cachedFundConfig) return cachedFundConfig;
  const yamlPath = join(FUND_DIR, "fund_config.yaml");
  const raw = await readFile(yamlPath, "utf-8");
  const parsed = yaml.load(raw);
  cachedFundConfig = fundConfigSchema.parse(parsed);
  return cachedFundConfig;
}

function fundNameFromEnv(): string {
  return basename(FUND_DIR);
}

// ── Universe tool handlers (pure, testable) ───────────────────
export interface CheckUniverseInput { ticker: string }
export interface CheckUniverseDeps {
  resolve: () => Promise<UniverseResolution>;
  checkSector: (ticker: string, resolution: UniverseResolution) => Promise<{ excluded: boolean; sector?: string }>;
}
export interface CheckUniverseOutput {
  in_universe: boolean;
  base_match: boolean;
  include_override: boolean;
  exclude_hard_block: boolean;
  exclude_reason?: "ticker" | "sector";
  requires_justification: boolean;
  resolved_at: number;
  resolved_from: string;
}

export async function handleCheckUniverse(
  input: CheckUniverseInput,
  deps: CheckUniverseDeps,
): Promise<CheckUniverseOutput> {
  const resolution = await deps.resolve();
  const status = isInUniverse(resolution, input.ticker);
  // Hard block: excluded by ticker config
  if (status.exclude_hard_block) {
    return {
      in_universe: false,
      base_match: status.base_match,
      include_override: false,
      exclude_hard_block: true,
      exclude_reason: status.exclude_reason,
      requires_justification: false,
      resolved_at: resolution.resolved_at,
      resolved_from: resolution.resolved_from,
    };
  }
  // Explicit include_tickers takes precedence over exclude_sectors
  if (status.include_override) {
    return {
      in_universe: true,
      base_match: status.base_match,
      include_override: true,
      exclude_hard_block: false,
      requires_justification: false,
      resolved_at: resolution.resolved_at,
      resolved_from: resolution.resolved_from,
    };
  }
  // Preset mode: check sector exclusion via profile
  const sectorCheck = await deps.checkSector(input.ticker, resolution);
  if (sectorCheck.excluded) {
    return {
      in_universe: false,
      base_match: status.base_match,
      include_override: false,
      exclude_hard_block: true,
      exclude_reason: "sector",
      requires_justification: false,
      resolved_at: resolution.resolved_at,
      resolved_from: resolution.resolved_from,
    };
  }
  return {
    in_universe: status.in_universe,
    base_match: status.base_match,
    include_override: false,
    exclude_hard_block: false,
    requires_justification: !status.in_universe,
    resolved_at: resolution.resolved_at,
    resolved_from: resolution.resolved_from,
  };
}

export interface ListUniverseInput { sector?: string; limit?: number }
export interface ListUniverseDeps {
  resolve: () => Promise<UniverseResolution>;
  getProfile: (ticker: string) => Promise<{ sector?: string } | null>;
}
export interface ListUniverseOutput {
  tickers: string[];
  total: number;
  resolved_at: number;
  resolved_from: string;
}

export async function handleListUniverse(
  input: ListUniverseInput,
  deps: ListUniverseDeps,
): Promise<ListUniverseOutput> {
  const resolution = await deps.resolve();
  let tickers = resolution.final_tickers;
  if (input.sector) {
    const matching: string[] = [];
    const BATCH_SIZE = 10;
    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const profiles = await Promise.all(
        batch.map((t) => deps.getProfile(t).then((p) => ({ t, p }))),
      );
      for (const { t, p } of profiles) {
        if (p?.sector === input.sector) matching.push(t);
      }
    }
    tickers = matching;
  }
  const total = tickers.length;
  const effectiveLimit = input.limit ?? (input.sector ? 50 : undefined);
  if (effectiveLimit && effectiveLimit > 0) tickers = tickers.slice(0, effectiveLimit);
  return {
    tickers,
    total,
    resolved_at: resolution.resolved_at,
    resolved_from: resolution.resolved_from,
  };
}

// ── Buy-gate handler (pure, testable) ──────────────────────────
export interface BuyGateInput {
  symbol: string;
  out_of_universe_reason?: string;
}
export interface BuyGateDeps {
  resolve: () => Promise<UniverseResolution>;
  checkSector: (ticker: string, resolution: UniverseResolution) => Promise<{ excluded: boolean; sector?: string }>;
}
export type BuyGateResult =
  | { ok: true; out_of_universe: boolean; out_of_universe_reason: string | null }
  | { ok: false; code: "UNIVERSE_EXCLUDED" | "UNIVERSE_SOFT_GATE" | "UNIVERSE_REASON_TOO_SHORT"; message: string; exclude_reason?: "ticker" | "sector" };

const MIN_OOU_REASON_LENGTH = 20;

export async function handleBuyGate(
  input: BuyGateInput,
  deps: BuyGateDeps,
): Promise<BuyGateResult> {
  const t = input.symbol.toUpperCase();
  const resolution = await deps.resolve();
  const status = isInUniverse(resolution, t);

  // Hard block by ticker config (exclude_tickers takes precedence)
  if (status.exclude_hard_block) {
    return {
      ok: false,
      code: "UNIVERSE_EXCLUDED",
      message: `${t} is in this fund's exclude_tickers list.`,
      exclude_reason: "ticker",
    };
  }

  // Explicit include_tickers bypasses sector check (matches check_universe precedence)
  if (status.include_override) {
    return { ok: true, out_of_universe: false, out_of_universe_reason: null };
  }

  // Preset mode: check sector exclusion via profile
  const sectorCheck = await deps.checkSector(t, resolution);
  if (sectorCheck.excluded) {
    return {
      ok: false,
      code: "UNIVERSE_EXCLUDED",
      message: `${t} is in sector '${sectorCheck.sector}' which is excluded by this fund.`,
      exclude_reason: "sector",
    };
  }

  if (status.in_universe) {
    return { ok: true, out_of_universe: false, out_of_universe_reason: null };
  }

  // Out-of-universe: require justification
  const raw = input.out_of_universe_reason ?? "";
  if (!raw) {
    return {
      ok: false,
      code: "UNIVERSE_SOFT_GATE",
      message: `${t} is outside this fund's universe. Pass out_of_universe_reason (>=${MIN_OOU_REASON_LENGTH} chars) describing a time-sensitive thesis to proceed.`,
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_OOU_REASON_LENGTH) {
    return {
      ok: false,
      code: "UNIVERSE_REASON_TOO_SHORT",
      message: `out_of_universe_reason must be at least ${MIN_OOU_REASON_LENGTH} characters (got ${trimmed.length}).`,
    };
  }
  return { ok: true, out_of_universe: true, out_of_universe_reason: trimmed };
}

// ── Update Universe handler (pure, testable) ──────────────────

export interface UpdateUniverseInput {
  mode?: { preset?: UniversePreset; filters?: Record<string, unknown> };
  include_tickers?: string[];
  exclude_tickers?: string[];
  exclude_sectors?: string[];
}
export interface UpdateUniverseDeps {
  loadCurrentConfig: () => Promise<FundConfig>;
  writeConfigYaml: (config: FundConfig) => Promise<void>;
  invalidateUniverseCache: () => Promise<void>;
  regenerateClaudeMd: (config: FundConfig) => Promise<void>;
}
export interface UpdateUniverseOutput {
  ok: true;
  before: { source: string; include_count: number; exclude_tickers_count: number; exclude_sectors_count: number };
  after: { source: string; include_count: number; exclude_tickers_count: number; exclude_sectors_count: number };
  note: string;
}

function summarizeUniverse(u: Universe): { source: string; include_count: number; exclude_tickers_count: number; exclude_sectors_count: number } {
  const source = u.preset ? `preset:${u.preset}` : "filters";
  return {
    source,
    include_count: u.include_tickers.length,
    exclude_tickers_count: u.exclude_tickers.length,
    exclude_sectors_count: u.exclude_sectors.length,
  };
}

export async function handleUpdateUniverse(
  input: UpdateUniverseInput,
  deps: UpdateUniverseDeps,
): Promise<UpdateUniverseOutput> {
  // Validate XOR constraint at input level first (before schema re-parse)
  if (input.mode?.preset && input.mode?.filters) {
    throw new Error("mode.preset and mode.filters are mutually exclusive — pass exactly one.");
  }

  const current = await deps.loadCurrentConfig();
  const before = summarizeUniverse(current.universe);

  // Build patched universe
  let next: Universe = { ...current.universe };
  if (input.mode?.preset) {
    next = {
      preset: input.mode.preset,
      // Drop filters when switching to preset
      include_tickers: next.include_tickers,
      exclude_tickers: next.exclude_tickers,
      exclude_sectors: next.exclude_sectors,
    };
  } else if (input.mode?.filters) {
    next = {
      filters: input.mode.filters as FmpScreenerFilters,
      // Drop preset when switching to filters
      include_tickers: next.include_tickers,
      exclude_tickers: next.exclude_tickers,
      exclude_sectors: next.exclude_sectors,
    };
  }
  if (input.include_tickers !== undefined) next.include_tickers = input.include_tickers;
  if (input.exclude_tickers !== undefined) next.exclude_tickers = input.exclude_tickers;
  if (input.exclude_sectors !== undefined) next.exclude_sectors = input.exclude_sectors as Universe["exclude_sectors"];

  // Schema validation — throws a Zod error with a clear message if bad
  const validated = universeSchema.parse(next);

  // Wrap in the full fundConfigSchema for belt-and-suspenders
  const newConfig = fundConfigSchema.parse({ ...current, universe: validated });

  // Persist
  await deps.writeConfigYaml(newConfig);
  await deps.invalidateUniverseCache();
  await deps.regenerateClaudeMd(newConfig);

  const after = summarizeUniverse(newConfig.universe);
  return {
    ok: true,
    before,
    after,
    note: "Universe updated. Next `check_universe` / `list_universe` / `place_order` calls will resolve against the new config (cache invalidated). CLAUDE.md regenerated with the updated 'Your Universe' section.",
  };
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
    out_of_universe_reason: z.string().optional().describe("Required when buying a ticker outside the fund universe (>=20 chars)"),
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
  "List this fund's resolved universe tickers. Optionally filter by sector (preset mode performs profile lookups with 10x concurrency; defaults limit to 50 when sector is set).",
  {
    sector: z.string().optional().describe("Filter to tickers in this sector (e.g. 'Technology')"),
    limit: z.number().int().positive().optional().describe("Max tickers to return"),
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
  "Mutate this fund's universe block in fund_config.yaml. Validates with the schema, writes atomically, invalidates the resolver cache, and regenerates CLAUDE.md. Use this instead of editing fund_config.yaml directly. Semantics: mode.preset|filters switches source (mutually exclusive — passing both is an error); include_tickers/exclude_tickers/exclude_sectors REPLACE their current lists (to add one item, first call check_universe or list_universe to read the current list, then pass the full new list including the addition). Omitted fields leave current values unchanged. Tickers are uppercased automatically.",
  {
    mode: z.object({
      preset: z.enum(["sp500", "nasdaq100", "dow30"]).optional().describe("Switch to a canonical index preset"),
      filters: z.record(z.string(), z.any()).optional().describe("Switch to custom FMP screener filters. If provided, REPLACES any current filters. Must pass Zod validation (see universe schema)."),
    }).optional().describe("Change the universe source. Omit to keep current preset/filters. Pass exactly one of preset OR filters."),
    include_tickers: z.array(z.string()).optional().describe("REPLACES the current include_tickers list (always-include tickers, bypass universe filters)"),
    exclude_tickers: z.array(z.string()).optional().describe("REPLACES the current exclude_tickers list (hard-block these tickers)"),
    exclude_sectors: z.array(z.string()).optional().describe("REPLACES the current exclude_sectors list (hard-block these sectors, FMP canonical names like 'Technology', 'Energy')"),
  },
  async (args) => {
    try {
      const r = await handleUpdateUniverse(args, {
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
          const { fundPaths } = await import("../paths.js");
          const fundName = fundNameFromEnv();
          const p = fundPaths(fundName).state.universe;
          try { await unlink(p); } catch { /* already absent — ignore */ }
        },
        regenerateClaudeMd: async (config) => {
          const { generateFundClaudeMd } = await import("../template.js");
          await generateFundClaudeMd(config);
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
