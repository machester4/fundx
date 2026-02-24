import Database from "better-sqlite3";
import { fundPaths } from "./paths.js";
import { ensureEmbeddingSchema } from "./embeddings.js";
import type { TradeRecord } from "./types.js";

/** Initialize the trade journal database for a fund */
export function openJournal(fundName: string): Database.Database {
  const paths = fundPaths(fundName);
  const db = new Database(paths.state.journal);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  ensureEmbeddingSchema(db);
  return db;
}

/** Ensure journal tables exist */
function ensureSchema(db: Database.Database): void {
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
}

/** Insert a trade record */
export function insertTrade(db: Database.Database, trade: TradeRecord): number {
  const stmt = db.prepare(`
    INSERT INTO trades (
      timestamp, fund, symbol, side, quantity, price, total_value,
      order_type, session_type, reasoning, analysis_ref, market_context
    ) VALUES (
      @timestamp, @fund, @symbol, @side, @quantity, @price, @total_value,
      @order_type, @session_type, @reasoning, @analysis_ref, @market_context
    )
  `);
  const result = stmt.run({
    timestamp: trade.timestamp,
    fund: trade.fund,
    symbol: trade.symbol,
    side: trade.side,
    quantity: trade.quantity,
    price: trade.price,
    total_value: trade.total_value,
    order_type: trade.order_type,
    session_type: trade.session_type ?? null,
    reasoning: trade.reasoning ?? null,
    analysis_ref: trade.analysis_ref ?? null,
    market_context: trade.market_context ?? null,
  });
  return Number(result.lastInsertRowid);
}

/** Get recent trades for a fund */
export function getRecentTrades(
  db: Database.Database,
  fundName: string,
  limit = 20,
): TradeRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM trades
    WHERE fund = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  return stmt.all(fundName, limit) as TradeRecord[];
}

/** Get trades for a fund on a specific date */
export function getTradesByDate(
  db: Database.Database,
  fundName: string,
  date: string,
): TradeRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM trades
    WHERE fund = ? AND timestamp LIKE ?
    ORDER BY timestamp DESC
  `);
  return stmt.all(fundName, `${date}%`) as TradeRecord[];
}

/** Get trades for a fund in the last N days */
export function getTradesInDays(
  db: Database.Database,
  fundName: string,
  days: number,
): TradeRecord[] {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const stmt = db.prepare(`
    SELECT * FROM trades
    WHERE fund = ? AND timestamp >= ?
    ORDER BY timestamp DESC
  `);
  return stmt.all(fundName, since.toISOString()) as TradeRecord[];
}

/** Get trade summary stats for a fund */
export function getTradeSummary(
  db: Database.Database,
  fundName: string,
): {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  total_pnl: number;
  avg_pnl_pct: number;
  best_trade_pnl: number;
  worst_trade_pnl: number;
} {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END) as losing_trades,
      COALESCE(SUM(pnl), 0) as total_pnl,
      COALESCE(AVG(pnl_pct), 0) as avg_pnl_pct,
      COALESCE(MAX(pnl), 0) as best_trade_pnl,
      COALESCE(MIN(pnl), 0) as worst_trade_pnl
    FROM trades
    WHERE fund = ? AND closed_at IS NOT NULL
  `);
  return stmt.get(fundName) as {
    total_trades: number;
    winning_trades: number;
    losing_trades: number;
    total_pnl: number;
    avg_pnl_pct: number;
    best_trade_pnl: number;
    worst_trade_pnl: number;
  };
}
