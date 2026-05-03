import { describe, it, expect } from "vitest";
import {
  evalFundStateSchema,
  evalAssertionsSchema,
  evalCaseSchema,
  evalRunCaptureSchema,
  evalCaseResultSchema,
  evalReportSchema,
  evalFailureSchema,
  judgeConfigSchema,
  judgeResultSchema,
} from "../src/types.js";

describe("evalFundStateSchema", () => {
  it("accepts a minimal state (portfolio only)", () => {
    const parsed = evalFundStateSchema.parse({ portfolio: { cash: 10000 } });
    expect(parsed.portfolio.cash).toBe(10000);
    expect(parsed.portfolio.positions).toEqual([]);
    expect(parsed.watchlist).toEqual([]);
  });

  it("accepts full state with fixture base", () => {
    const parsed = evalFundStateSchema.parse({
      base: "runway-with-candidates",
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: {
        cash: 5000,
        positions: [{ symbol: "NVDA", shares: 10, avg_cost: 400, current_price: 450, entry_reason: "thesis" }],
      },
      tracker: { progress_pct: 25, status: "on_track" },
      watchlist: [{ ticker: "AMD", status: "candidate", peak_score: 0.8, screens: ["momentum-12-1"], first_surfaced_days_ago: 7 }],
    });
    expect(parsed.base).toBe("runway-with-candidates");
    expect(parsed.portfolio.positions).toHaveLength(1);
    expect(parsed.watchlist).toHaveLength(1);
  });

  it("rejects negative cash", () => {
    expect(() => evalFundStateSchema.parse({ portfolio: { cash: -5 } })).toThrow();
  });
});

describe("evalAssertionsSchema", () => {
  it("defaults empty assertion arrays", () => {
    const parsed = evalAssertionsSchema.parse({});
    expect(parsed.must_invoke).toEqual([]);
    expect(parsed.must_not_invoke).toEqual([]);
    expect(parsed.max_turns).toBeUndefined();
  });

  it("parses full assertion block", () => {
    const parsed = evalAssertionsSchema.parse({
      must_invoke: ["mcp__screener__watchlist_query"],
      must_not_invoke: ["mcp__broker-local__place_order"],
      max_turns: 10,
      max_tokens_out: 5000,
    });
    expect(parsed.must_invoke).toEqual(["mcp__screener__watchlist_query"]);
    expect(parsed.max_turns).toBe(10);
  });
});

describe("evalCaseSchema", () => {
  const base = {
    description: "x",
    prompt: "y",
    fund_state: { portfolio: { cash: 0 } },
    expect: {},
  };

  it("rejects uppercase and special chars in id", () => {
    expect(() => evalCaseSchema.parse({ ...base, id: "Foo Bar" })).toThrow();
    expect(() => evalCaseSchema.parse({ ...base, id: "foo_bar" })).toThrow();
    expect(() => evalCaseSchema.parse({ ...base, id: "mvp-foo-bar" })).not.toThrow();
  });

  it("rejects threshold greater than runs", () => {
    expect(() =>
      evalCaseSchema.parse({ ...base, id: "x", runs: 3, threshold: 5 }),
    ).toThrow(/threshold must be/);
  });

  it("applies default runs=3 threshold=2 language=es", () => {
    const parsed = evalCaseSchema.parse({ ...base, id: "x" });
    expect(parsed.runs).toBe(3);
    expect(parsed.threshold).toBe(2);
    expect(parsed.language).toBe("es");
  });
});

describe("evalFailureSchema", () => {
  it("accepts each failure type", () => {
    for (const type of ["must_invoke", "must_not_invoke", "max_turns", "max_tokens_out", "run_errored"] as const) {
      expect(() =>
        evalFailureSchema.parse({ type, detail: "d", expected: "e", actual: "a" }),
      ).not.toThrow();
    }
  });
});

describe("evalRunCaptureSchema", () => {
  it("parses a captured run with tool history", () => {
    const parsed = evalRunCaptureSchema.parse({
      run_index: 1,
      passed: true,
      tool_history: [{ name: "mcp__screener__watchlist_query", elapsed: 1.2 }],
      tokens_in: 1000, tokens_out: 500, num_turns: 2,
      duration_ms: 5000, cost_usd: 0.02,
      final_response: "ok",
      error: null,
      failures: [],
    });
    expect(parsed.passed).toBe(true);
    expect(parsed.tool_history[0].name).toBe("mcp__screener__watchlist_query");
  });
});

describe("evalReportSchema", () => {
  it("requires schema_version=1", () => {
    expect(() =>
      evalReportSchema.parse({
        schema_version: 2, timestamp: "t", model: "m",
        total_cost_usd: 0, total_duration_ms: 0,
        summary: { cases_passed: 0, cases_failed: 0, runs_passed: 0, runs_failed: 0 },
        cases: [],
      }),
    ).toThrow();
  });
});

describe("evalCaseResultSchema", () => {
  it("validates a pass case with 3 runs", () => {
    const parsed = evalCaseResultSchema.parse({
      id: "x", description: "x", passed: true,
      passing_runs: 3, total_runs: 3, threshold: 2,
      runs: [],
      total_duration_ms: 10000, total_cost_usd: 0.06,
    });
    expect(parsed.passed).toBe(true);
  });
});

describe("judgeConfigSchema", () => {
  it("parses a valid judge config with both dims", () => {
    const out = judgeConfigSchema.parse({
      dims: { data_grounding: 4, task_completion: 4 },
    });
    expect(out.dims.data_grounding).toBe(4);
    expect(out.dims.task_completion).toBe(4);
  });

  it("rejects scores outside 1-5", () => {
    expect(() =>
      judgeConfigSchema.parse({ dims: { data_grounding: 0 } }),
    ).toThrow();
    expect(() =>
      judgeConfigSchema.parse({ dims: { data_grounding: 6 } }),
    ).toThrow();
  });

  it("rejects unknown dim names", () => {
    expect(() =>
      judgeConfigSchema.parse({ dims: { unknown_dim: 3 } }),
    ).toThrow();
  });
});

describe("evalAssertionsSchema with judge", () => {
  it("accepts assertions without judge (back-compat)", () => {
    const out = evalAssertionsSchema.parse({
      must_invoke: [],
      must_not_invoke: [],
    });
    expect(out.judge).toBeUndefined();
  });

  it("accepts assertions with judge block", () => {
    const out = evalAssertionsSchema.parse({
      must_invoke: [],
      must_not_invoke: [],
      judge: { dims: { data_grounding: 4 } },
    });
    expect(out.judge?.dims.data_grounding).toBe(4);
  });
});

describe("evalRunCaptureSchema with judge", () => {
  it("accepts run capture without judge (back-compat)", () => {
    const out = evalRunCaptureSchema.parse({
      run_index: 1,
      passed: true,
      tool_history: [],
      tokens_in: 100,
      tokens_out: 50,
      num_turns: 1,
      duration_ms: 1000,
      cost_usd: 0.05,
      final_response: "ok",
      error: null,
      failures: [],
    });
    expect(out.judge).toBeUndefined();
  });

  it("accepts run capture with judge result", () => {
    const out = evalRunCaptureSchema.parse({
      run_index: 1,
      passed: true,
      tool_history: [],
      tokens_in: 100,
      tokens_out: 50,
      num_turns: 1,
      duration_ms: 1000,
      cost_usd: 0.05,
      final_response: "ok",
      error: null,
      failures: [],
      judge: {
        scores: { data_grounding: 4 },
        rationale: { data_grounding: "all numbers retrieved this session" },
        judge_cost_usd: 0.31,
      },
    });
    expect(out.judge?.scores.data_grounding).toBe(4);
    expect(out.judge?.judge_cost_usd).toBe(0.31);
  });
});

describe("evalFailureSchema judge_below_threshold variant", () => {
  it("accepts judge_below_threshold failure type", () => {
    const out = evalFailureSchema.parse({
      type: "judge_below_threshold",
      detail: "data_grounding scored below threshold",
      expected: "data_grounding >= 4",
      actual: "data_grounding = 2",
    });
    expect(out.type).toBe("judge_below_threshold");
  });
});

describe("evalFailureSchema judge_invocation_error variant", () => {
  it("accepts judge_invocation_error failure type", () => {
    const out = evalFailureSchema.parse({
      type: "judge_invocation_error",
      detail: "Judge invocation failed",
      expected: "judge to complete",
      actual: "ENOENT: no such file or directory",
    });
    expect(out.type).toBe("judge_invocation_error");
  });
});
