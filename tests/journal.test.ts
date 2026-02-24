import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  insertTrade,
  getRecentTrades,
  getTradesByDate,
  getTradesInDays,
  getTradeSummary,
} from "../src/journal.js";
import type { TradeRecord } from "../src/types.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
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

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      fund TEXT NOT NULL,
      session_type TEXT NOT NULL,
      duration_seconds INTEGER,
      trades_executed INTEGER DEFAULT 0,
      analysis_file TEXT,
      summary TEXT,
      claude_model TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_trades_fund ON trades(fund);
    CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_fund ON sessions(fund);
  `);
});

afterEach(() => {
  db.close();
});

const FUND = "test-fund";

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    timestamp: new Date().toISOString(),
    fund: FUND,
    symbol: "GDX",
    side: "buy",
    quantity: 100,
    price: 45.0,
    total_value: 4500,
    order_type: "market",
    session_type: "pre_market",
    reasoning: "Gold breakout above 200-day MA",
    ...overrides,
  };
}

describe("insertTrade", () => {
  it("inserts a trade and returns its ID", () => {
    const id = insertTrade(db, makeTrade());
    expect(id).toBe(1);
  });

  it("increments trade IDs", () => {
    const id1 = insertTrade(db, makeTrade({ symbol: "GDX" }));
    const id2 = insertTrade(db, makeTrade({ symbol: "SLV" }));
    expect(id2).toBe(id1 + 1);
  });

  it("stores all trade fields", () => {
    const trade = makeTrade({
      reasoning: "Test reasoning",
      analysis_ref: "analysis/2026-02-22_pre.md",
      market_context: '{"dxy": 103.5}',
    });
    insertTrade(db, trade);

    const row = db.prepare("SELECT * FROM trades WHERE id = 1").get() as Record<string, unknown>;
    expect(row.symbol).toBe("GDX");
    expect(row.side).toBe("buy");
    expect(row.quantity).toBe(100);
    expect(row.price).toBe(45.0);
    expect(row.reasoning).toBe("Test reasoning");
    expect(row.analysis_ref).toBe("analysis/2026-02-22_pre.md");
    expect(row.market_context).toBe('{"dxy": 103.5}');
  });
});

describe("getRecentTrades", () => {
  it("returns trades ordered by most recent first", () => {
    insertTrade(db, makeTrade({ timestamp: "2026-02-20T09:00:00Z", symbol: "GDX" }));
    insertTrade(db, makeTrade({ timestamp: "2026-02-21T09:00:00Z", symbol: "SLV" }));
    insertTrade(db, makeTrade({ timestamp: "2026-02-22T09:00:00Z", symbol: "GLD" }));

    const trades = getRecentTrades(db, FUND, 10);
    expect(trades).toHaveLength(3);
    expect(trades[0].symbol).toBe("GLD");
    expect(trades[2].symbol).toBe("GDX");
  });

  it("respects limit", () => {
    insertTrade(db, makeTrade({ timestamp: "2026-02-20T09:00:00Z" }));
    insertTrade(db, makeTrade({ timestamp: "2026-02-21T09:00:00Z" }));
    insertTrade(db, makeTrade({ timestamp: "2026-02-22T09:00:00Z" }));

    const trades = getRecentTrades(db, FUND, 2);
    expect(trades).toHaveLength(2);
  });

  it("filters by fund", () => {
    insertTrade(db, makeTrade({ fund: "fund-a" }));
    insertTrade(db, makeTrade({ fund: "fund-b" }));

    expect(getRecentTrades(db, "fund-a")).toHaveLength(1);
    expect(getRecentTrades(db, "fund-b")).toHaveLength(1);
    expect(getRecentTrades(db, "fund-c")).toHaveLength(0);
  });
});

describe("getTradesByDate", () => {
  it("returns trades for a specific date", () => {
    insertTrade(db, makeTrade({ timestamp: "2026-02-22T09:00:00Z" }));
    insertTrade(db, makeTrade({ timestamp: "2026-02-22T13:00:00Z" }));
    insertTrade(db, makeTrade({ timestamp: "2026-02-23T09:00:00Z" }));

    const trades = getTradesByDate(db, FUND, "2026-02-22");
    expect(trades).toHaveLength(2);
  });
});

describe("getTradesInDays", () => {
  it("returns trades within the time window", () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 10);

    insertTrade(db, makeTrade({ timestamp: now.toISOString() }));
    insertTrade(db, makeTrade({ timestamp: yesterday.toISOString() }));
    insertTrade(db, makeTrade({ timestamp: weekAgo.toISOString() }));

    const trades = getTradesInDays(db, FUND, 7);
    expect(trades).toHaveLength(2);
  });
});

describe("getTradeSummary", () => {
  it("returns zeros when no closed trades", () => {
    insertTrade(db, makeTrade()); // open trade

    const summary = getTradeSummary(db, FUND);
    expect(summary.total_trades).toBe(0);
    expect(summary.total_pnl).toBe(0);
  });
});
