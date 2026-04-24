import { describe, it, expect } from "vitest";
import { buildIssueSpecs } from "../src/services/eval/open-issue.js";
import type { EvalReport } from "../src/types.js";

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    schema_version: 1,
    timestamp: "2026-04-23T00:00:00Z",
    model: "claude-sonnet-4-6",
    total_cost_usd: 0.2,
    total_duration_ms: 12000,
    summary: { cases_passed: 0, cases_failed: 0, runs_passed: 0, runs_failed: 0 },
    cases: [],
    ...overrides,
  };
}

describe("buildIssueSpecs", () => {
  it("returns empty when no cases failed", () => {
    const out = buildIssueSpecs(
      report({
        cases: [{
          id: "mvp-a", description: "d", passed: true,
          passing_runs: 3, total_runs: 3, threshold: 2,
          runs: [], total_duration_ms: 100, total_cost_usd: 0.02,
        }],
      }),
      "https://example.com/run/1",
    );
    expect(out).toEqual([]);
  });

  it("returns one spec per (case_id, failure_type) grouping", () => {
    const out = buildIssueSpecs(
      report({
        cases: [{
          id: "mvp-a", description: "d", passed: false,
          passing_runs: 0, total_runs: 3, threshold: 2,
          runs: [
            { run_index: 1, passed: false, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null,
              failures: [{ type: "must_invoke", detail: "x", expected: "foo", actual: "bar" }] },
            { run_index: 2, passed: false, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null,
              failures: [
                { type: "must_invoke", detail: "x", expected: "foo", actual: "baz" },
                { type: "max_turns", detail: "y", expected: "10", actual: "20" },
              ] },
            { run_index: 3, passed: true, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null, failures: [] },
          ],
          total_duration_ms: 100, total_cost_usd: 0.02,
        }],
      }),
      "https://example.com/run/1",
    );
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.title).sort()).toEqual([
      "[eval] mvp-a — max_turns",
      "[eval] mvp-a — must_invoke",
    ]);
    expect(out[0].body).toContain("https://example.com/run/1");
    expect(out[0].body).toContain("Run #");
    expect(out[0].labels).toContain("eval-failure");
  });
});
