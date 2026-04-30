import { describe, it, expect } from "vitest";
import {
  budgetSchema,
  fundBudgetConfigSchema,
  fundConfigSchema,
  globalConfigSchema,
  sessionLogV2Schema,
} from "../src/types.js";
import { resolveBudget, buildBudgetAlert } from "../src/services/session.service.js";
import type { FundConfig, GlobalConfig } from "../src/types.js";

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

  it("accepts a session log with handoff_written field", () => {
    const out = sessionLogV2Schema.parse({
      fund: "f",
      session_type: "pre_market",
      started_at: "2026-04-30T10:00:00.000Z",
      handoff_written: true,
    });
    expect(out.handoff_written).toBe(true);
  });

  it("accepts a session log without handoff_written (back-compat)", () => {
    const out = sessionLogV2Schema.parse({
      fund: "f",
      session_type: "pre_market",
      started_at: "2026-04-30T10:00:00.000Z",
    });
    expect(out.handoff_written).toBeUndefined();
  });
});

const baseFund = (): FundConfig => ({
  fund: { name: "f", display_name: "F", description: "", created: "2026-04-27", status: "active" },
  capital: { initial: 1000, currency: "USD" },
  objective: { type: "growth", target_multiple: 2 } as FundConfig["objective"],
  risk: { profile: "moderate", max_position_pct: 25, max_drawdown_pct: 25 } as FundConfig["risk"],
  universe: { preset: "sp500" } as FundConfig["universe"],
  schedule: { sessions: {} },
  broker: { mode: "paper" },
  notifications: {
    telegram: { enabled: false, trade_alerts: true, stop_loss_alerts: true, daily_digest: true, weekly_digest: true, milestone_alerts: true, drawdown_alerts: true },
    quiet_hours: { enabled: true, start: "23:00", end: "07:00", allow_critical: true },
  },
  claude: { model: "sonnet", personality: "", decision_framework: "" },
});

const baseGlobal = (): GlobalConfig => ({
  default_model: "sonnet",
  timezone: "UTC",
  broker: {},
  telegram: { enabled: false },
  market_data: { provider: "fmp" },
});

describe("resolveBudget cascade", () => {
  it("level 1 — fund per-session-type wins over everything", () => {
    const fund = baseFund();
    fund.budget = {
      perSessionType: { "pre_market": { maxTurns: 11, maxUsd: 1 } },
      default: { maxTurns: 22, maxUsd: 2 },
    };
    const global = baseGlobal();
    global.budget = {
      perSessionType: { "pre_market": { maxTurns: 33, maxUsd: 3 } },
      default: { maxTurns: 44, maxUsd: 4 },
    };
    expect(resolveBudget(fund, global, "pre_market")).toEqual({ maxTurns: 11, maxUsd: 1 });
  });

  it("level 2 — fund default wins when no fund per-session-type for that type", () => {
    const fund = baseFund();
    fund.budget = {
      perSessionType: { "post_market": { maxTurns: 99, maxUsd: 9 } },
      default: { maxTurns: 22, maxUsd: 2 },
    };
    const global = baseGlobal();
    global.budget = { default: { maxTurns: 44, maxUsd: 4 } };
    expect(resolveBudget(fund, global, "pre_market")).toEqual({ maxTurns: 22, maxUsd: 2 });
  });

  it("level 3 — global per-session-type wins when no fund budget at all", () => {
    const fund = baseFund();
    const global = baseGlobal();
    global.budget = {
      perSessionType: { "pre_market": { maxTurns: 33, maxUsd: 3 } },
      default: { maxTurns: 44, maxUsd: 4 },
    };
    expect(resolveBudget(fund, global, "pre_market")).toEqual({ maxTurns: 33, maxUsd: 3 });
  });

  it("level 4 — global default wins when no per-session-type at any level", () => {
    const fund = baseFund();
    const global = baseGlobal();
    global.budget = { default: { maxTurns: 44, maxUsd: 4 } };
    expect(resolveBudget(fund, global, "pre_market")).toEqual({ maxTurns: 44, maxUsd: 4 });
  });

  it("level 5 — known session-type default when no config at all", () => {
    const fund = baseFund();
    const global = baseGlobal();
    expect(resolveBudget(fund, global, "pre_market")).toEqual({ maxTurns: 40, maxUsd: 5 });
    expect(resolveBudget(fund, global, "mid_session")).toEqual({ maxTurns: 25, maxUsd: 3 });
    expect(resolveBudget(fund, global, "post_market")).toEqual({ maxTurns: 60, maxUsd: 7 });
  });

  it("level 6 — fallback default for unknown session type", () => {
    const fund = baseFund();
    const global = baseGlobal();
    expect(resolveBudget(fund, global, "made-up-type")).toEqual({ maxTurns: 50, maxUsd: 5 });
    expect(resolveBudget(fund, global, "catchup_pre_market")).toEqual({ maxTurns: 50, maxUsd: 5 });
    expect(resolveBudget(fund, global, "special_fomc")).toEqual({ maxTurns: 50, maxUsd: 5 });
  });
});

describe("buildBudgetAlert", () => {
  it("formats an error_max_budget alert with all fields", () => {
    const out = buildBudgetAlert({
      displayName: "My Fund",
      sessionType: "pre-market",
      status: "error_max_budget",
      budget: { maxTurns: 40, maxUsd: 5 },
      numTurns: 22,
      costUsd: 5.03,
    });
    expect(out).toContain("My Fund");
    expect(out).toContain("pre-market");
    expect(out).toContain("stopped at budget");
    expect(out).toContain("40 turns");
    expect(out).toContain("$5");
    expect(out).toContain("22 turns");
    expect(out).toContain("$5.03");
    expect(out).toContain("error_max_budget");
  });

  it("formats an error_max_turns alert", () => {
    const out = buildBudgetAlert({
      displayName: "My Fund",
      sessionType: "post-market",
      status: "error_max_turns",
      budget: { maxTurns: 60, maxUsd: 7 },
      numTurns: 60,
      costUsd: 4.21,
    });
    expect(out).toContain("error_max_turns");
    expect(out).toContain("60 turns");
    expect(out).toContain("$7");
  });

  it("escapes HTML-special characters in displayName", () => {
    const out = buildBudgetAlert({
      displayName: "Fund & <Co>",
      sessionType: "pre-market",
      status: "error_max_budget",
      budget: { maxTurns: 40, maxUsd: 5 },
      numTurns: 22,
      costUsd: 5.0,
    });
    expect(out).toContain("Fund &amp; &lt;Co&gt;");
    expect(out).not.toContain("Fund & <Co>");
  });
});
