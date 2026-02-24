import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  ensureEmbeddingSchema,
  searchTrades,
  findSimilarTrades,
  getTradeContextSummary,
  rebuildIndex,
} from "../src/embeddings.js";
import type { TradeRecord } from "../src/types.js";

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
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
}

function insertTrade(
  database: Database.Database,
  trade: Partial<TradeRecord> & { fund: string; symbol: string },
): number {
  const stmt = database.prepare(`
    INSERT INTO trades (
      timestamp, fund, symbol, side, quantity, price, total_value,
      order_type, session_type, reasoning, analysis_ref, market_context,
      closed_at, close_price, pnl, pnl_pct, lessons_learned
    ) VALUES (
      @timestamp, @fund, @symbol, @side, @quantity, @price, @total_value,
      @order_type, @session_type, @reasoning, @analysis_ref, @market_context,
      @closed_at, @close_price, @pnl, @pnl_pct, @lessons_learned
    )
  `);
  const result = stmt.run({
    timestamp: trade.timestamp ?? new Date().toISOString(),
    fund: trade.fund,
    symbol: trade.symbol,
    side: trade.side ?? "buy",
    quantity: trade.quantity ?? 100,
    price: trade.price ?? 50,
    total_value: trade.total_value ?? 5000,
    order_type: trade.order_type ?? "market",
    session_type: trade.session_type ?? null,
    reasoning: trade.reasoning ?? null,
    analysis_ref: trade.analysis_ref ?? null,
    market_context: trade.market_context ?? null,
    closed_at: trade.closed_at ?? null,
    close_price: trade.close_price ?? null,
    pnl: trade.pnl ?? null,
    pnl_pct: trade.pnl_pct ?? null,
    lessons_learned: trade.lessons_learned ?? null,
  });
  return Number(result.lastInsertRowid);
}

const FUND = "test-fund";

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  createSchema(db);
});

afterEach(() => {
  db.close();
});

describe("ensureEmbeddingSchema", () => {
  it("creates FTS5 virtual table and triggers", () => {
    ensureEmbeddingSchema(db);

    // Check FTS table exists
    const fts = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='trades_fts'",
      )
      .get();
    expect(fts).toBeDefined();

    // Check triggers exist
    const triggers = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trades_a%'",
      )
      .all();
    expect(triggers).toHaveLength(3); // ai, au, ad
  });

  it("is idempotent — calling twice does not error", () => {
    ensureEmbeddingSchema(db);
    ensureEmbeddingSchema(db);

    const fts = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='trades_fts'",
      )
      .get();
    expect(fts).toBeDefined();
  });

  it("indexes existing trades when created", () => {
    // Insert trades BEFORE creating FTS
    insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold miners breakout above resistance",
    });
    insertTrade(db, {
      fund: FUND,
      symbol: "SLV",
      reasoning: "Silver bullish momentum",
    });

    ensureEmbeddingSchema(db);

    // Verify FTS contains the trades
    const count = db
      .prepare("SELECT COUNT(*) as cnt FROM trades_fts")
      .get() as { cnt: number };
    expect(count.cnt).toBe(2);
  });
});

describe("searchTrades", () => {
  beforeEach(() => {
    ensureEmbeddingSchema(db);
  });

  it("finds trades matching a text query", () => {
    insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold miners breakout above 200-day moving average",
    });
    insertTrade(db, {
      fund: FUND,
      symbol: "SLV",
      reasoning: "Silver showing bullish momentum divergence",
    });
    insertTrade(db, {
      fund: FUND,
      symbol: "SPY",
      reasoning: "Market index pullback to support level",
    });

    const results = searchTrades(db, "gold breakout", FUND);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].symbol).toBe("GDX");
  });

  it("filters by fund name", () => {
    insertTrade(db, {
      fund: "fund-a",
      symbol: "GDX",
      reasoning: "Gold breakout pattern",
    });
    insertTrade(db, {
      fund: "fund-b",
      symbol: "GDX",
      reasoning: "Gold breakout pattern",
    });

    const resultsA = searchTrades(db, "gold breakout", "fund-a");
    const resultsB = searchTrades(db, "gold breakout", "fund-b");

    expect(resultsA).toHaveLength(1);
    expect(resultsA[0].symbol).toBe("GDX");
    expect(resultsB).toHaveLength(1);
  });

  it("returns results ranked by relevance", () => {
    insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold miners breakout above resistance with strong volume",
      market_context: "Gold spot price at new highs",
    });
    insertTrade(db, {
      fund: FUND,
      symbol: "SPY",
      reasoning: "Market dip buying opportunity",
    });

    const results = searchTrades(db, "gold breakout resistance", FUND);
    expect(results.length).toBeGreaterThan(0);
    // GDX should rank higher due to more matching terms
    const gdxResult = results.find((r) => r.symbol === "GDX");
    expect(gdxResult).toBeDefined();
    expect(gdxResult!.rank).toBe(1);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      insertTrade(db, {
        fund: FUND,
        symbol: `T${i}`,
        reasoning: `Technical breakout pattern number ${i}`,
      });
    }

    const results = searchTrades(db, "breakout pattern", FUND, 3);
    expect(results).toHaveLength(3);
  });

  it("returns empty array for no matches", () => {
    insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold miners breakout",
    });

    const results = searchTrades(db, "cryptocurrency bitcoin", FUND);
    expect(results).toHaveLength(0);
  });

  it("includes score and rank fields", () => {
    insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold breakout",
    });

    const results = searchTrades(db, "gold", FUND);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].rank).toBe(1);
    expect(typeof results[0].score).toBe("number");
  });
});

describe("findSimilarTrades", () => {
  beforeEach(() => {
    ensureEmbeddingSchema(db);
  });

  it("finds trades similar to a reference trade", () => {
    const id1 = insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold miners breakout above resistance with strong volume",
      market_context: "Fed dovish, gold bullish",
    });
    insertTrade(db, {
      fund: FUND,
      symbol: "GLD",
      reasoning: "Gold ETF breakout above resistance level",
      market_context: "Fed policy shift favoring gold",
    });
    insertTrade(db, {
      fund: FUND,
      symbol: "SPY",
      reasoning: "Market index momentum trade on earnings season",
    });

    const similar = findSimilarTrades(db, id1, FUND, 5);
    // Should find GLD (similar gold trade) but not include the source trade itself
    expect(similar.every((r) => r.trade_id !== id1)).toBe(true);
    if (similar.length > 0) {
      expect(similar[0].symbol).toBe("GLD");
    }
  });

  it("excludes the source trade from results", () => {
    const id = insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold breakout",
    });

    const results = findSimilarTrades(db, id, FUND);
    expect(results.every((r) => r.trade_id !== id)).toBe(true);
  });

  it("returns empty array for non-existent trade", () => {
    const results = findSimilarTrades(db, 999, FUND);
    expect(results).toHaveLength(0);
  });
});

describe("getTradeContextSummary", () => {
  it("returns formatted summary for trades", () => {
    insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      timestamp: "2026-02-20T09:00:00Z",
      side: "buy",
      quantity: 100,
      price: 45,
      reasoning: "Gold breakout",
    });
    insertTrade(db, {
      fund: FUND,
      symbol: "SLV",
      timestamp: "2026-02-21T09:00:00Z",
      side: "buy",
      quantity: 200,
      price: 25,
      reasoning: "Silver momentum",
      pnl: 150,
      pnl_pct: 3.0,
    });

    const summary = getTradeContextSummary(db, FUND);
    expect(summary).toContain("Recent Trade History");
    expect(summary).toContain("GDX");
    expect(summary).toContain("SLV");
    expect(summary).toContain("Gold breakout");
  });

  it("returns message when no trades exist", () => {
    const summary = getTradeContextSummary(db, FUND);
    expect(summary).toBe("No trade history yet.");
  });

  it("respects maxTrades limit", () => {
    for (let i = 0; i < 10; i++) {
      insertTrade(db, {
        fund: FUND,
        symbol: `T${i}`,
        reasoning: `Trade ${i}`,
      });
    }

    const summary = getTradeContextSummary(db, FUND, 3);
    // Should only mention 3 trades
    const tradeLines = summary
      .split("\n")
      .filter((l) => l.startsWith("- **"));
    expect(tradeLines).toHaveLength(3);
  });
});

describe("rebuildIndex", () => {
  it("rebuilds the FTS index from scratch", () => {
    ensureEmbeddingSchema(db);

    insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold breakout",
    });

    // Manually corrupt FTS by deleting its content
    db.exec("DELETE FROM trades_fts");
    let results = searchTrades(db, "gold", FUND);
    expect(results).toHaveLength(0);

    // Rebuild
    rebuildIndex(db);
    results = searchTrades(db, "gold", FUND);
    expect(results).toHaveLength(1);
  });
});

describe("FTS trigger integration", () => {
  beforeEach(() => {
    ensureEmbeddingSchema(db);
  });

  it("auto-indexes new trades via INSERT trigger", () => {
    insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold momentum trade",
    });

    const results = searchTrades(db, "gold momentum", FUND);
    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe("GDX");
  });

  it("updates FTS on trade UPDATE", () => {
    const id = insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Initial reasoning",
    });

    // Update the trade's reasoning
    db.prepare("UPDATE trades SET reasoning = ? WHERE id = ?").run(
      "Updated reasoning about silver momentum",
      id,
    );

    // Should find with new terms
    const results = searchTrades(db, "silver momentum", FUND);
    expect(results.length).toBeGreaterThan(0);
  });

  it("removes from FTS on trade DELETE", () => {
    insertTrade(db, {
      fund: FUND,
      symbol: "GDX",
      reasoning: "Gold breakout",
    });

    // Verify it's indexed
    let results = searchTrades(db, "gold", FUND);
    expect(results).toHaveLength(1);

    // Delete the trade
    db.prepare("DELETE FROM trades WHERE fund = ?").run(FUND);

    // Should no longer be found
    results = searchTrades(db, "gold", FUND);
    expect(results).toHaveLength(0);
  });
});
