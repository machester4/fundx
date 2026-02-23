import { describe, it, expect } from "vitest";
import {
  tradeRecordSchema,
  sessionRecordSchema,
  alpacaAccountSchema,
  alpacaPositionSchema,
  alpacaOrderSchema,
  alpacaBarSchema,
  alpacaQuoteSchema,
} from "../src/types.js";

describe("tradeRecordSchema", () => {
  it("parses a valid trade record", () => {
    const result = tradeRecordSchema.parse({
      timestamp: "2026-02-22T09:00:00Z",
      fund: "runway",
      symbol: "GDX",
      side: "buy",
      quantity: 100,
      price: 45.0,
      total_value: 4500,
      order_type: "market",
      session_type: "pre_market",
      reasoning: "Gold breakout",
    });
    expect(result.symbol).toBe("GDX");
    expect(result.side).toBe("buy");
    expect(result.order_type).toBe("market");
  });

  it("accepts all order types", () => {
    const types = ["market", "limit", "stop", "stop_limit", "trailing_stop"] as const;
    for (const ot of types) {
      const result = tradeRecordSchema.parse({
        timestamp: "2026-02-22T09:00:00Z",
        fund: "test",
        symbol: "SPY",
        side: "buy",
        quantity: 10,
        price: 100,
        total_value: 1000,
        order_type: ot,
      });
      expect(result.order_type).toBe(ot);
    }
  });

  it("rejects invalid side", () => {
    expect(() =>
      tradeRecordSchema.parse({
        timestamp: "2026-02-22T09:00:00Z",
        fund: "test",
        symbol: "SPY",
        side: "short",
        quantity: 10,
        price: 100,
        total_value: 1000,
        order_type: "market",
      }),
    ).toThrow();
  });

  it("accepts optional close fields", () => {
    const result = tradeRecordSchema.parse({
      timestamp: "2026-02-22T09:00:00Z",
      fund: "test",
      symbol: "SPY",
      side: "buy",
      quantity: 10,
      price: 100,
      total_value: 1000,
      order_type: "market",
      closed_at: "2026-02-23T09:00:00Z",
      close_price: 105,
      pnl: 50,
      pnl_pct: 5.0,
      lessons_learned: "Good entry timing",
    });
    expect(result.pnl).toBe(50);
    expect(result.lessons_learned).toBe("Good entry timing");
  });
});

describe("sessionRecordSchema", () => {
  it("parses a valid session record", () => {
    const result = sessionRecordSchema.parse({
      timestamp: "2026-02-22T09:00:00Z",
      fund: "runway",
      session_type: "pre_market",
      duration_seconds: 600,
      trades_executed: 2,
      summary: "Analyzed market conditions",
      claude_model: "opus",
    });
    expect(result.fund).toBe("runway");
    expect(result.trades_executed).toBe(2);
  });

  it("applies defaults for optional fields", () => {
    const result = sessionRecordSchema.parse({
      timestamp: "2026-02-22T09:00:00Z",
      fund: "runway",
      session_type: "pre_market",
    });
    expect(result.trades_executed).toBe(0);
  });
});

describe("alpacaAccountSchema", () => {
  it("parses an Alpaca account response", () => {
    const result = alpacaAccountSchema.parse({
      id: "abc123",
      account_number: "PA1234",
      status: "ACTIVE",
      currency: "USD",
      cash: "50000.00",
      portfolio_value: "75000.00",
      buying_power: "100000.00",
      equity: "75000.00",
      last_equity: "74500.00",
      long_market_value: "25000.00",
      short_market_value: "0.00",
      daytrade_count: 0,
      pattern_day_trader: false,
    });
    expect(result.cash).toBe("50000.00");
    expect(result.status).toBe("ACTIVE");
  });
});

describe("alpacaPositionSchema", () => {
  it("parses an Alpaca position response", () => {
    const result = alpacaPositionSchema.parse({
      asset_id: "xyz789",
      symbol: "GDX",
      exchange: "ARCA",
      asset_class: "us_equity",
      avg_entry_price: "43.10",
      qty: "150",
      side: "long",
      market_value: "6780.00",
      cost_basis: "6465.00",
      unrealized_pl: "315.00",
      unrealized_plpc: "0.0487",
      current_price: "45.20",
      lastday_price: "44.80",
      change_today: "0.0089",
    });
    expect(result.symbol).toBe("GDX");
    expect(result.qty).toBe("150");
  });
});

describe("alpacaOrderSchema", () => {
  it("parses an Alpaca order response", () => {
    const result = alpacaOrderSchema.parse({
      id: "order123",
      client_order_id: "client456",
      created_at: "2026-02-22T09:00:00Z",
      submitted_at: "2026-02-22T09:00:01Z",
      filled_at: null,
      expired_at: null,
      canceled_at: null,
      asset_id: "asset789",
      symbol: "GDX",
      asset_class: "us_equity",
      qty: "100",
      filled_qty: "0",
      type: "limit",
      side: "buy",
      time_in_force: "day",
      limit_price: "44.00",
      stop_price: null,
      filled_avg_price: null,
      status: "new",
    });
    expect(result.symbol).toBe("GDX");
    expect(result.type).toBe("limit");
    expect(result.status).toBe("new");
  });
});

describe("alpacaBarSchema", () => {
  it("parses an Alpaca bar", () => {
    const result = alpacaBarSchema.parse({
      t: "2026-02-22T14:30:00Z",
      o: 44.5,
      h: 45.2,
      l: 44.1,
      c: 45.0,
      v: 1234567,
      n: 5000,
      vw: 44.75,
    });
    expect(result.o).toBe(44.5);
    expect(result.c).toBe(45.0);
    expect(result.v).toBe(1234567);
  });
});

describe("alpacaQuoteSchema", () => {
  it("parses an Alpaca quote", () => {
    const result = alpacaQuoteSchema.parse({
      t: "2026-02-22T14:30:00Z",
      ap: 45.05,
      as: 200,
      bp: 44.95,
      bs: 300,
      ax: "V",
      bx: "Q",
    });
    expect(result.ap).toBe(45.05);
    expect(result.bp).toBe(44.95);
  });
});
