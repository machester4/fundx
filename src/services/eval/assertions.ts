import type { EvalRunCapture, EvalAssertions, EvalFailure } from "../../types.js";

export interface CaseAggregate {
  passed: boolean;
  passing_runs: number;
  total_runs: number;
  threshold: number;
  aggregate_failures: Record<EvalFailure["type"], number>;
}

/** Pure: evaluate a single run against the case's assertion block. */
export function evaluateRun(run: EvalRunCapture, expect: EvalAssertions): EvalRunCapture {
  const failures: EvalFailure[] = [];

  if (run.error) {
    failures.push({
      type: "run_errored",
      detail: `Run failed: ${run.error}`,
      expected: "no error",
      actual: run.error,
    });
    return { ...run, passed: false, failures };
  }

  const invoked = new Set(run.tool_history.map((t) => t.name));

  for (const tool of expect.must_invoke ?? []) {
    if (!invoked.has(tool)) {
      failures.push({
        type: "must_invoke",
        detail: `Expected tool "${tool}" to be invoked`,
        expected: tool,
        actual: Array.from(invoked).join(", ") || "(none)",
      });
    }
  }

  for (const tool of expect.must_not_invoke ?? []) {
    if (invoked.has(tool)) {
      failures.push({
        type: "must_not_invoke",
        detail: `Expected tool "${tool}" NOT to be invoked`,
        expected: `no ${tool}`,
        actual: tool,
      });
    }
  }

  if (expect.max_turns !== undefined && run.num_turns > expect.max_turns) {
    failures.push({
      type: "max_turns",
      detail: "Turn count exceeded the budget",
      expected: `≤ ${expect.max_turns}`,
      actual: String(run.num_turns),
    });
  }

  if (expect.max_tokens_out !== undefined && run.tokens_out > expect.max_tokens_out) {
    failures.push({
      type: "max_tokens_out",
      detail: "Output token count exceeded the budget",
      expected: `≤ ${expect.max_tokens_out}`,
      actual: String(run.tokens_out),
    });
  }

  return { ...run, passed: failures.length === 0, failures };
}

/** Pure: aggregate K run results into a case verdict against a threshold. */
export function evaluateCase(runs: EvalRunCapture[], threshold: number): CaseAggregate {
  const passingRuns = runs.filter((r) => r.passed).length;
  const aggregate: Record<EvalFailure["type"], number> = {
    must_invoke: 0,
    must_not_invoke: 0,
    max_turns: 0,
    max_tokens_out: 0,
    run_errored: 0,
    judge_below_threshold: 0,
  };
  for (const r of runs) {
    for (const f of r.failures) aggregate[f.type] += 1;
  }
  return {
    passed: passingRuns >= threshold,
    passing_runs: passingRuns,
    total_runs: runs.length,
    threshold,
    aggregate_failures: aggregate,
  };
}
