import { describe, it, expect } from "vitest";
import {
  subAgentTypeSchema,
  subAgentConfigSchema,
  subAgentResultSchema,
  similarTradeResultSchema,
} from "../src/types.js";

describe("subAgentTypeSchema", () => {
  it("accepts valid agent types", () => {
    expect(subAgentTypeSchema.parse("macro")).toBe("macro");
    expect(subAgentTypeSchema.parse("technical")).toBe("technical");
    expect(subAgentTypeSchema.parse("sentiment")).toBe("sentiment");
    expect(subAgentTypeSchema.parse("risk")).toBe("risk");
    expect(subAgentTypeSchema.parse("custom")).toBe("custom");
  });

  it("rejects invalid agent types", () => {
    expect(() => subAgentTypeSchema.parse("invalid")).toThrow();
    expect(() => subAgentTypeSchema.parse("")).toThrow();
  });
});

describe("subAgentConfigSchema", () => {
  it("parses a valid config", () => {
    const config = subAgentConfigSchema.parse({
      type: "macro",
      name: "Macro Analyst",
      prompt: "Analyze macroeconomic conditions",
    });

    expect(config.type).toBe("macro");
    expect(config.name).toBe("Macro Analyst");
    expect(config.max_turns).toBe(20); // default
  });

  it("accepts optional model and custom max_turns", () => {
    const config = subAgentConfigSchema.parse({
      type: "technical",
      name: "Tech Analyst",
      prompt: "Analyze charts",
      max_turns: 30,
      model: "opus",
    });

    expect(config.max_turns).toBe(30);
    expect(config.model).toBe("opus");
  });

  it("rejects missing required fields", () => {
    expect(() =>
      subAgentConfigSchema.parse({ type: "macro", name: "Test" }),
    ).toThrow();
  });
});

describe("subAgentResultSchema", () => {
  it("parses a successful result", () => {
    const result = subAgentResultSchema.parse({
      type: "macro",
      name: "Macro Analyst",
      started_at: "2026-02-24T09:00:00Z",
      ended_at: "2026-02-24T09:05:00Z",
      status: "success",
      output: "Analysis output here",
    });

    expect(result.status).toBe("success");
    expect(result.output).toBe("Analysis output here");
    expect(result.error).toBeUndefined();
  });

  it("parses an error result", () => {
    const result = subAgentResultSchema.parse({
      type: "technical",
      name: "Tech Analyst",
      started_at: "2026-02-24T09:00:00Z",
      ended_at: "2026-02-24T09:01:00Z",
      status: "error",
      output: "",
      error: "Connection timeout",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("Connection timeout");
  });

  it("parses a timeout result", () => {
    const result = subAgentResultSchema.parse({
      type: "sentiment",
      name: "Sentiment Analyst",
      started_at: "2026-02-24T09:00:00Z",
      ended_at: "2026-02-24T09:10:00Z",
      status: "timeout",
      output: "",
    });

    expect(result.status).toBe("timeout");
  });
});

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
