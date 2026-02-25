import { describe, it, expect } from "vitest";
import { tradeRecordSchema } from "../src/types.js";

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
