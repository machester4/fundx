import { describe, it, expect } from "vitest";
import {
  fundConfigSchema,
  globalConfigSchema,
  portfolioSchema,
  objectiveTrackerSchema,
  sessionLogSchema,
  dailySnapshotSchema,
  notifiedMilestonesSchema,
  universeSchema,
  fmpScreenerFiltersSchema,
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
    universe: { preset: "sp500" },
    schedule: {
      sessions: {
        pre_market: {
          time: "09:00",
          enabled: true,
          focus: "Analyze overnight developments.",
        },
      },
    },
    broker: { mode: "paper" },
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
    expect(result.default_model).toBe("sonnet");
    expect(result.timezone).toBe("UTC");
  });

  it("parses a full config", () => {
    const result = globalConfigSchema.parse({
      default_model: "opus",
      timezone: "America/New_York",
      broker: {
        mode: "paper",
      },
      telegram: {
        bot_token: "123:ABC",
        chat_id: "456",
      },
    });
    expect(result.default_model).toBe("opus");
    expect(result.broker.mode).toBe("paper");
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

describe("dailySnapshotSchema", () => {
  it("parses a valid daily snapshot", () => {
    const result = dailySnapshotSchema.parse({
      date: "2026-04-08",
      total_value: 10024.41,
    });
    expect(result.date).toBe("2026-04-08");
    expect(result.total_value).toBe(10024.41);
  });
});

describe("notifiedMilestonesSchema", () => {
  it("parses valid milestone tracking data", () => {
    const result = notifiedMilestonesSchema.parse({
      thresholds_notified: [10, 25],
      peak_value: 12500,
      drawdown_thresholds_notified: [50],
      last_checked: "2026-04-08T15:30:00Z",
    });
    expect(result.thresholds_notified).toEqual([10, 25]);
    expect(result.peak_value).toBe(12500);
    expect(result.drawdown_thresholds_notified).toEqual([50]);
  });

  it("provides defaults for empty object", () => {
    const result = notifiedMilestonesSchema.parse({});
    expect(result.thresholds_notified).toEqual([]);
    expect(result.peak_value).toBe(0);
    expect(result.drawdown_thresholds_notified).toEqual([]);
    expect(result.last_checked).toBe("");
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

describe("universeSchema (per-fund universe)", () => {
  it("accepts a preset block", () => {
    const u = universeSchema.parse({ preset: "sp500" });
    expect(u.preset).toBe("sp500");
    expect(u.include_tickers).toEqual([]);
  });

  it("accepts a filters block", () => {
    const u = universeSchema.parse({
      filters: { market_cap_min: 1e10, exchange: ["NYSE", "NASDAQ"] },
    });
    expect(u.filters?.market_cap_min).toBe(1e10);
  });

  it("rejects both preset and filters", () => {
    expect(() =>
      universeSchema.parse({ preset: "sp500", filters: { limit: 100 } }),
    ).toThrow(/exactly one/);
  });

  it("rejects neither preset nor filters", () => {
    expect(() => universeSchema.parse({})).toThrow(/exactly one/);
  });

  it("rejects unknown exchange", () => {
    expect(() =>
      universeSchema.parse({ filters: { exchange: ["NYSE", "FAKE"] } }),
    ).toThrow();
  });

  it("rejects unknown sector", () => {
    expect(() =>
      universeSchema.parse({ filters: { sector: ["Tech"] } }),
    ).toThrow();
  });

  it("rejects market_cap_min >= max", () => {
    expect(() =>
      universeSchema.parse({
        filters: { market_cap_min: 1e10, market_cap_max: 1e9 },
      }),
    ).toThrow(/market_cap_min must be/);
  });

  it("uppercases include/exclude tickers", () => {
    const u = universeSchema.parse({
      preset: "sp500",
      include_tickers: ["tsm", "asml"],
      exclude_tickers: ["tsla"],
    });
    expect(u.include_tickers).toEqual(["TSM", "ASML"]);
    expect(u.exclude_tickers).toEqual(["TSLA"]);
  });

  it("validates country as ISO-2", () => {
    expect(() =>
      universeSchema.parse({ filters: { country: "USA" } }),
    ).toThrow();
    expect(universeSchema.parse({ filters: { country: "US" } }).filters?.country).toBe("US");
  });
});
