import { describe, it, expect } from "vitest";
import {
  budgetSchema,
  fundBudgetConfigSchema,
  fundConfigSchema,
  globalConfigSchema,
  sessionLogV2Schema,
} from "../src/types.js";

describe("budgetSchema", () => {
  it("parses a valid budget", () => {
    const out = budgetSchema.parse({ maxTurns: 40, maxUsd: 5 });
    expect(out).toEqual({ maxTurns: 40, maxUsd: 5 });
  });

  it("rejects non-positive turns", () => {
    expect(() => budgetSchema.parse({ maxTurns: 0, maxUsd: 5 })).toThrow();
    expect(() => budgetSchema.parse({ maxTurns: -1, maxUsd: 5 })).toThrow();
  });

  it("rejects non-positive usd", () => {
    expect(() => budgetSchema.parse({ maxTurns: 40, maxUsd: 0 })).toThrow();
    expect(() => budgetSchema.parse({ maxTurns: 40, maxUsd: -1 })).toThrow();
  });

  it("rejects non-integer turns", () => {
    expect(() => budgetSchema.parse({ maxTurns: 1.5, maxUsd: 5 })).toThrow();
  });
});

describe("fundBudgetConfigSchema", () => {
  it("accepts undefined", () => {
    const out = fundBudgetConfigSchema.parse(undefined);
    expect(out).toBeUndefined();
  });

  it("accepts a default-only block", () => {
    const out = fundBudgetConfigSchema.parse({
      default: { maxTurns: 30, maxUsd: 4 },
    });
    expect(out?.default).toEqual({ maxTurns: 30, maxUsd: 4 });
  });

  it("accepts perSessionType overrides", () => {
    const out = fundBudgetConfigSchema.parse({
      perSessionType: {
        "pre-market": { maxTurns: 40, maxUsd: 5 },
        "post-market": { maxTurns: 60, maxUsd: 7 },
      },
    });
    expect(out?.perSessionType?.["pre-market"]).toEqual({ maxTurns: 40, maxUsd: 5 });
  });
});

describe("fundConfigSchema with budget", () => {
  it("accepts a fund config without budget (back-compat)", () => {
    const minimal = {
      fund: { name: "f", display_name: "F", created: "2026-04-27" },
      capital: { initial: 1000 },
      objective: { type: "growth", target_multiple: 2 },
      risk: { profile: "moderate" as const, max_position_pct: 25, max_drawdown_pct: 25 },
      universe: { preset: "sp500" },
      schedule: { sessions: {} },
      broker: { mode: "paper" as const },
    };
    const out = fundConfigSchema.parse(minimal);
    expect(out.budget).toBeUndefined();
  });

  it("accepts a fund config with budget block", () => {
    const withBudget = {
      fund: { name: "f", display_name: "F", created: "2026-04-27" },
      capital: { initial: 1000 },
      objective: { type: "growth", target_multiple: 2 },
      risk: { profile: "moderate" as const, max_position_pct: 25, max_drawdown_pct: 25 },
      universe: { preset: "sp500" },
      schedule: { sessions: {} },
      broker: { mode: "paper" as const },
      budget: { default: { maxTurns: 50, maxUsd: 6 } },
    };
    const out = fundConfigSchema.parse(withBudget);
    expect(out.budget?.default).toEqual({ maxTurns: 50, maxUsd: 6 });
  });
});

describe("globalConfigSchema with budget", () => {
  it("accepts an empty global config (back-compat)", () => {
    const out = globalConfigSchema.parse({});
    expect(out.budget).toBeUndefined();
  });

  it("accepts a global config with budget block", () => {
    const out = globalConfigSchema.parse({
      budget: { default: { maxTurns: 100, maxUsd: 10 } },
    });
    expect(out.budget?.default).toEqual({ maxTurns: 100, maxUsd: 10 });
  });
});

describe("sessionLogV2Schema with budget_resolved", () => {
  it("accepts a session log without budget_resolved (back-compat)", () => {
    const out = sessionLogV2Schema.parse({
      fund: "f",
      session_type: "pre-market",
      started_at: "2026-04-27T10:00:00.000Z",
    });
    expect(out.budget_resolved).toBeUndefined();
  });

  it("accepts a session log with budget_resolved", () => {
    const out = sessionLogV2Schema.parse({
      fund: "f",
      session_type: "pre-market",
      started_at: "2026-04-27T10:00:00.000Z",
      budget_resolved: { maxTurns: 40, maxUsd: 5 },
    });
    expect(out.budget_resolved).toEqual({ maxTurns: 40, maxUsd: 5 });
  });
});
