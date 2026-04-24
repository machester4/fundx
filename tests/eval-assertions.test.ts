import { describe, it, expect } from "vitest";
import { evaluateRun, evaluateCase } from "../src/services/eval/assertions.js";
import type { EvalRunCapture, EvalAssertions } from "../src/types.js";

function capture(partial: Partial<EvalRunCapture>): EvalRunCapture {
  return {
    run_index: 1,
    passed: true,
    tool_history: [],
    tokens_in: 100,
    tokens_out: 100,
    num_turns: 1,
    duration_ms: 1000,
    cost_usd: 0.01,
    final_response: "",
    error: null,
    failures: [],
    ...partial,
  };
}

describe("evaluateRun", () => {
  it("passes with empty assertions", () => {
    const r = evaluateRun(capture({}), {} as EvalAssertions);
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails must_invoke when tool missing", () => {
    const r = evaluateRun(
      capture({ tool_history: [{ name: "bar", elapsed: 1 }] }),
      { must_invoke: ["foo"], must_not_invoke: [] },
    );
    expect(r.passed).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].type).toBe("must_invoke");
    expect(r.failures[0].expected).toContain("foo");
  });

  it("passes must_invoke when tool present", () => {
    const r = evaluateRun(
      capture({ tool_history: [{ name: "foo", elapsed: 1 }] }),
      { must_invoke: ["foo"], must_not_invoke: [] },
    );
    expect(r.passed).toBe(true);
  });

  it("fails must_not_invoke when tool present", () => {
    const r = evaluateRun(
      capture({ tool_history: [{ name: "foo", elapsed: 1 }] }),
      { must_invoke: [], must_not_invoke: ["foo"] },
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0].type).toBe("must_not_invoke");
  });

  it("reports multiple failures", () => {
    const r = evaluateRun(
      capture({ tool_history: [{ name: "forbidden", elapsed: 1 }], num_turns: 20 }),
      { must_invoke: ["required"], must_not_invoke: ["forbidden"], max_turns: 5 },
    );
    expect(r.failures.map((f) => f.type).sort()).toEqual(["max_turns", "must_invoke", "must_not_invoke"]);
  });

  it("fails max_turns when exceeded", () => {
    const r = evaluateRun(capture({ num_turns: 10 }), { must_invoke: [], must_not_invoke: [], max_turns: 5 });
    expect(r.passed).toBe(false);
    expect(r.failures[0].type).toBe("max_turns");
  });

  it("fails max_tokens_out when exceeded", () => {
    const r = evaluateRun(capture({ tokens_out: 6000 }), { must_invoke: [], must_not_invoke: [], max_tokens_out: 5000 });
    expect(r.passed).toBe(false);
    expect(r.failures[0].type).toBe("max_tokens_out");
  });

  it("short-circuits to run_errored when error is set", () => {
    const r = evaluateRun(
      capture({ error: "timeout" }),
      { must_invoke: ["foo"], must_not_invoke: [] },
    );
    expect(r.passed).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].type).toBe("run_errored");
  });
});

describe("evaluateCase", () => {
  const runs = (passes: boolean[]): EvalRunCapture[] =>
    passes.map((p, i) => capture({
      run_index: i + 1,
      passed: p,
      failures: p ? [] : [{ type: "must_invoke", detail: "x", expected: "x", actual: "x" }],
    }));

  it("passes when passing_runs >= threshold", () => {
    const out = evaluateCase(runs([true, true, false]), 2);
    expect(out.passed).toBe(true);
    expect(out.passing_runs).toBe(2);
    expect(out.total_runs).toBe(3);
  });

  it("fails when passing_runs < threshold", () => {
    const out = evaluateCase(runs([true, false, false]), 2);
    expect(out.passed).toBe(false);
    expect(out.passing_runs).toBe(1);
  });

  it("aggregates failure types across runs", () => {
    const out = evaluateCase(runs([false, false, false]), 2);
    expect(out.aggregate_failures.must_invoke).toBe(3);
  });
});
