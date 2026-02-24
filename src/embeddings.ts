import type Database from "better-sqlite3";
import type { SimilarTradeResult, TradeRecord } from "./types.js";

/**
 * Trade journal embeddings and similarity search using SQLite FTS5.
 *
 * Provides full-text indexing of trade reasoning, market context, and lessons
 * learned, enabling similarity search across trade history. This is used by
 * `fundx ask` and Claude sessions to find relevant historical trades.
 */

/** Ensure FTS5 virtual table exists alongside the trades table */
export function ensureEmbeddingSchema(db: Database.Database): void {
  // Check if FTS table already exists
  const exists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='trades_fts'`,
    )
    .get();

  if (!exists) {
    // Standalone FTS5 table (content='' means FTS manages its own content)
    db.exec(`
      CREATE VIRTUAL TABLE trades_fts USING fts5(
        trade_id UNINDEXED,
        symbol,
        side,
        reasoning,
        market_context,
        lessons_learned,
        tokenize='porter unicode61'
      );
    `);

    // Populate FTS from any existing trades
    db.exec(`
      INSERT INTO trades_fts(trade_id, symbol, side, reasoning, market_context, lessons_learned)
      SELECT id, symbol, side,
        COALESCE(reasoning, ''),
        COALESCE(market_context, ''),
        COALESCE(lessons_learned, '')
      FROM trades;
    `);
  }

  // Create triggers to keep FTS in sync with trades table
  const triggerExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name='trades_ai'`,
    )
    .get();

  if (!triggerExists) {
    db.exec(`
      CREATE TRIGGER trades_ai AFTER INSERT ON trades BEGIN
        INSERT INTO trades_fts(trade_id, symbol, side, reasoning, market_context, lessons_learned)
        VALUES (new.id, new.symbol, new.side,
          COALESCE(new.reasoning, ''),
          COALESCE(new.market_context, ''),
          COALESCE(new.lessons_learned, ''));
      END;

      CREATE TRIGGER trades_au AFTER UPDATE ON trades BEGIN
        DELETE FROM trades_fts WHERE trade_id = CAST(old.id AS TEXT);
        INSERT INTO trades_fts(trade_id, symbol, side, reasoning, market_context, lessons_learned)
        VALUES (new.id, new.symbol, new.side,
          COALESCE(new.reasoning, ''),
          COALESCE(new.market_context, ''),
          COALESCE(new.lessons_learned, ''));
      END;

      CREATE TRIGGER trades_ad AFTER DELETE ON trades BEGIN
        DELETE FROM trades_fts WHERE trade_id = CAST(old.id AS TEXT);
      END;
    `);
  }
}

/** Rebuild FTS index from scratch (useful after bulk inserts or schema changes) */
export function rebuildIndex(db: Database.Database): void {
  db.exec(`
    DELETE FROM trades_fts;
    INSERT INTO trades_fts(trade_id, symbol, side, reasoning, market_context, lessons_learned)
    SELECT id, symbol, side,
      COALESCE(reasoning, ''),
      COALESCE(market_context, ''),
      COALESCE(lessons_learned, '')
    FROM trades;
  `);
}

/**
 * Search for trades matching a text query using FTS5 ranking.
 * Returns trades sorted by relevance score.
 */
export function searchTrades(
  db: Database.Database,
  query: string,
  fundName?: string,
  limit = 10,
): SimilarTradeResult[] {
  // Sanitize query for FTS5: wrap terms in double quotes to handle special chars
  const sanitized = sanitizeFtsQuery(query);

  const whereClause = fundName ? "AND t.fund = ?" : "";
  const params: (string | number)[] = fundName
    ? [sanitized, fundName, limit]
    : [sanitized, limit];

  const stmt = db.prepare(`
    SELECT
      t.id as trade_id,
      t.symbol,
      t.side,
      t.timestamp,
      t.reasoning,
      t.market_context,
      t.lessons_learned,
      t.pnl,
      t.pnl_pct,
      fts.rank as fts_rank
    FROM trades_fts fts
    JOIN trades t ON t.id = CAST(fts.trade_id AS INTEGER)
    WHERE trades_fts MATCH ?
    ${whereClause}
    ORDER BY fts.rank
    LIMIT ?
  `);

  const rows = stmt.all(...params) as Array<{
    trade_id: number;
    symbol: string;
    side: string;
    timestamp: string;
    reasoning: string | null;
    market_context: string | null;
    lessons_learned: string | null;
    pnl: number | null;
    pnl_pct: number | null;
    fts_rank: number;
  }>;

  return rows.map((row, i) => ({
    trade_id: row.trade_id,
    symbol: row.symbol,
    side: row.side as "buy" | "sell",
    timestamp: row.timestamp,
    reasoning: row.reasoning ?? undefined,
    market_context: row.market_context ?? undefined,
    lessons_learned: row.lessons_learned ?? undefined,
    pnl: row.pnl ?? undefined,
    pnl_pct: row.pnl_pct ?? undefined,
    rank: i + 1,
    score: Math.abs(row.fts_rank),
  }));
}

/**
 * Find trades similar to a given trade by using its text fields as a query.
 */
export function findSimilarTrades(
  db: Database.Database,
  tradeId: number,
  fundName?: string,
  limit = 5,
): SimilarTradeResult[] {
  const trade = db
    .prepare("SELECT * FROM trades WHERE id = ?")
    .get(tradeId) as TradeRecord | undefined;

  if (!trade) return [];

  // Build query from trade's text fields
  const queryParts: string[] = [];
  if (trade.reasoning) queryParts.push(trade.reasoning);
  if (trade.market_context) queryParts.push(trade.market_context);
  if (trade.symbol) queryParts.push(trade.symbol);

  if (queryParts.length === 0) return [];

  const query = queryParts.join(" ");
  const results = searchTrades(db, query, fundName, limit + 1);

  // Exclude the source trade itself
  return results
    .filter((r) => r.trade_id !== tradeId)
    .slice(0, limit);
}

/**
 * Get trade context summary for a fund, suitable for including in prompts.
 * Returns a markdown-formatted summary of recent and notable trades.
 */
export function getTradeContextSummary(
  db: Database.Database,
  fundName: string,
  maxTrades = 20,
): string {
  const recentTrades = db
    .prepare(
      `SELECT * FROM trades WHERE fund = ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(fundName, maxTrades) as TradeRecord[];

  if (recentTrades.length === 0) {
    return "No trade history yet.";
  }

  const lines: string[] = ["## Recent Trade History\n"];

  for (const trade of recentTrades) {
    const date = trade.timestamp.split("T")[0];
    const pnlStr =
      trade.pnl != null
        ? ` | P&L: $${trade.pnl.toFixed(2)} (${trade.pnl_pct?.toFixed(1)}%)`
        : "";
    lines.push(
      `- **${date}** ${trade.side.toUpperCase()} ${trade.quantity} ${trade.symbol} @ $${trade.price}${pnlStr}`,
    );
    if (trade.reasoning) {
      lines.push(`  Reasoning: ${trade.reasoning}`);
    }
    if (trade.lessons_learned) {
      lines.push(`  Lessons: ${trade.lessons_learned}`);
    }
  }

  return lines.join("\n");
}

/** Sanitize a query string for FTS5 MATCH syntax */
function sanitizeFtsQuery(query: string): string {
  // Split into words, filter empty, join with OR for broader matching
  const terms = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (terms.length === 0) return '""';

  // Use OR between terms for broader matching
  return terms.map((t) => `"${t}"`).join(" OR ");
}
