import { describe, it, expect } from "vitest";
import {
  similarTradeResultSchema,
} from "../src/types.js";

describe("similarTradeResultSchema", () => {
  it("parses a full similar trade result", () => {
    const result = similarTradeResultSchema.parse({
      trade_id: 42,
      symbol: "GDX",
      side: "buy",
      timestamp: "2026-02-20T09:00:00Z",
      reasoning: "Gold breakout",
      market_context: '{"dxy": 103}',
      lessons_learned: "Good entry timing",
      pnl: 300,
      pnl_pct: 6.67,
      rank: 1,
      score: 0.95,
    });

    expect(result.trade_id).toBe(42);
    expect(result.symbol).toBe("GDX");
    expect(result.rank).toBe(1);
    expect(result.score).toBe(0.95);
  });

  it("allows optional fields", () => {
    const result = similarTradeResultSchema.parse({
      trade_id: 1,
      symbol: "SPY",
      side: "sell",
      timestamp: "2026-02-20T09:00:00Z",
      rank: 3,
      score: 0.5,
    });

    expect(result.reasoning).toBeUndefined();
    expect(result.pnl).toBeUndefined();
  });
});
