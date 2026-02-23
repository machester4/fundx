import { describe, it, expect } from "vitest";
import {
  fundConfigSchema,
  globalConfigSchema,
  portfolioSchema,
  objectiveTrackerSchema,
  sessionLogSchema,
} from "../src/types.js";

describe("fundConfigSchema", () => {
  const validConfig = {
    fund: {
      name: "test-fund",
      display_name: "Test Fund",
      description: "A test fund",
      created: "2026-01-01",
      status: "active",
    },
    capital: { initial: 10000, currency: "USD" },
    objective: { type: "growth", target_multiple: 2 },
    risk: { profile: "moderate" },
    universe: { allowed: [{ type: "etf", tickers: ["SPY", "QQQ"] }] },
    schedule: {
      sessions: {
        pre_market: {
          time: "09:00",
          enabled: true,
          focus: "Analyze overnight developments.",
        },
      },
    },
    broker: { provider: "alpaca", mode: "paper" },
    claude: { model: "sonnet" },
  };

  it("parses a valid fund config", () => {
    const result = fundConfigSchema.parse(validConfig);
    expect(result.fund.name).toBe("test-fund");
    expect(result.capital.initial).toBe(10000);
    expect(result.objective.type).toBe("growth");
    expect(result.risk.profile).toBe("moderate");
  });

  it("applies default values", () => {
    const result = fundConfigSchema.parse(validConfig);
    expect(result.risk.max_drawdown_pct).toBe(15);
    expect(result.risk.max_position_pct).toBe(25);
    expect(result.risk.stop_loss_pct).toBe(8);
    expect(result.risk.max_leverage).toBe(1);
  });

  it("validates all objective types", () => {
    const types = [
      { type: "runway", target_months: 18, monthly_burn: 2000 },
      { type: "growth", target_multiple: 2 },
      { type: "accumulation", target_asset: "BTC", target_amount: 1 },
      { type: "income", target_monthly_income: 500 },
      { type: "custom", description: "My goal" },
    ];
    for (const obj of types) {
      const cfg = { ...validConfig, objective: obj };
      const result = fundConfigSchema.parse(cfg);
      expect(result.objective.type).toBe(obj.type);
    }
  });

  it("rejects invalid objective type", () => {
    const cfg = {
      ...validConfig,
      objective: { type: "invalid" },
    };
    expect(() => fundConfigSchema.parse(cfg)).toThrow();
  });

  it("rejects negative capital", () => {
    const cfg = {
      ...validConfig,
      capital: { initial: -1000, currency: "USD" },
    };
    expect(() => fundConfigSchema.parse(cfg)).toThrow();
  });
});

describe("globalConfigSchema", () => {
  it("applies sensible defaults", () => {
    const result = globalConfigSchema.parse({});
    expect(result.claude_path).toBe("claude");
    expect(result.default_model).toBe("sonnet");
    expect(result.timezone).toBe("UTC");
    expect(result.broker.provider).toBe("manual");
    expect(result.broker.mode).toBe("paper");
  });

  it("parses a full config", () => {
    const result = globalConfigSchema.parse({
      claude_path: "/usr/local/bin/claude",
      default_model: "opus",
      timezone: "America/New_York",
      broker: {
        provider: "alpaca",
        api_key: "test-key",
        secret_key: "test-secret",
        mode: "paper",
      },
      telegram: {
        bot_token: "123:ABC",
        chat_id: "456",
      },
    });
    expect(result.claude_path).toBe("/usr/local/bin/claude");
    expect(result.default_model).toBe("opus");
    expect(result.broker.api_key).toBe("test-key");
    expect(result.telegram.bot_token).toBe("123:ABC");
  });
});

describe("portfolioSchema", () => {
  it("parses an empty portfolio", () => {
    const result = portfolioSchema.parse({
      last_updated: "2026-01-01T00:00:00Z",
      cash: 10000,
      total_value: 10000,
      positions: [],
    });
    expect(result.cash).toBe(10000);
    expect(result.positions).toHaveLength(0);
  });

  it("parses a portfolio with positions", () => {
    const result = portfolioSchema.parse({
      last_updated: "2026-01-01T00:00:00Z",
      cash: 5000,
      total_value: 15000,
      positions: [
        {
          symbol: "SPY",
          shares: 20,
          avg_cost: 450,
          current_price: 500,
          market_value: 10000,
          unrealized_pnl: 1000,
          unrealized_pnl_pct: 11.1,
          weight_pct: 66.7,
          entry_date: "2026-01-01",
        },
      ],
    });
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe("SPY");
  });
});

describe("objectiveTrackerSchema", () => {
  it("parses a valid tracker", () => {
    const result = objectiveTrackerSchema.parse({
      type: "growth",
      initial_capital: 10000,
      current_value: 12000,
      progress_pct: 40,
      status: "ahead",
    });
    expect(result.progress_pct).toBe(40);
    expect(result.status).toBe("ahead");
  });

  it("rejects invalid status", () => {
    expect(() =>
      objectiveTrackerSchema.parse({
        type: "growth",
        initial_capital: 10000,
        current_value: 12000,
        progress_pct: 40,
        status: "unknown",
      }),
    ).toThrow();
  });
});

describe("sessionLogSchema", () => {
  it("parses a valid session log", () => {
    const result = sessionLogSchema.parse({
      fund: "test-fund",
      session_type: "pre_market",
      started_at: "2026-01-01T09:00:00Z",
      ended_at: "2026-01-01T09:15:00Z",
      trades_executed: 2,
      summary: "Analyzed market conditions.",
    });
    expect(result.fund).toBe("test-fund");
    expect(result.trades_executed).toBe(2);
  });

  it("applies default values", () => {
    const result = sessionLogSchema.parse({
      fund: "test-fund",
      session_type: "pre_market",
      started_at: "2026-01-01T09:00:00Z",
    });
    expect(result.trades_executed).toBe(0);
    expect(result.summary).toBe("");
  });
});
