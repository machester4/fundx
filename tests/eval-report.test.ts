import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTerminal, buildReport, writeJsonReport } from "../src/services/eval/report.js";
import { evalReportSchema, type EvalCaseResult } from "../src/types.js";

function caseResult(partial: Partial<EvalCaseResult>): EvalCaseResult {
  return {
    id: "x",
    description: "x",
    passed: true,
    passing_runs: 3,
    total_runs: 3,
    threshold: 2,
    runs: [],
    total_duration_ms: 10000,
    total_cost_usd: 0.06,
    ...partial,
  };
}

describe("buildReport", () => {
  it("produces a schema-valid report", () => {
    const report = buildReport({
      model: "claude-sonnet-4-6",
      cases: [
        caseResult({ id: "mvp-a", passed: true, passing_runs: 3 }),
        caseResult({ id: "mvp-b", passed: false, passing_runs: 1 }),
      ],
      runsPassed: 4,
      runsFailed: 2,
      durationMs: 20000,
      costUsd: 0.12,
    });
    const parsed = evalReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
    expect(report.summary.cases_passed).toBe(1);
    expect(report.summary.cases_failed).toBe(1);
    expect(report.summary.runs_passed).toBe(4);
  });

  it("includes total_judge_cost_usd when at least one case had judge", () => {
    const report = buildReport({
      model: "claude-sonnet-4-6",
      cases: [
        caseResult({ id: "judged-case", total_judge_cost_usd: 0.91 }),
        caseResult({ id: "non-judged-case" }),
      ],
      runsPassed: 6,
      runsFailed: 0,
      durationMs: 20000,
      costUsd: 0.12,
    });
    expect(report.total_judge_cost_usd).toBe(0.91);
  });

  it("omits total_judge_cost_usd when no case had judge", () => {
    const report = buildReport({
      model: "claude-sonnet-4-6",
      cases: [caseResult({ id: "no-judge" })],
      runsPassed: 3,
      runsFailed: 0,
      durationMs: 10000,
      costUsd: 0.06,
    });
    expect(report.total_judge_cost_usd).toBeUndefined();
  });
});

describe("renderTerminal", () => {
  it("marks passing cases with a check and failing with an x", () => {
    const out = renderTerminal([
      caseResult({ id: "pass-case", passed: true }),
      caseResult({ id: "fail-case", passed: false, passing_runs: 1, runs: [
        { run_index: 1, passed: true, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null, failures: [] },
        { run_index: 2, passed: false, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null, failures: [
          { type: "must_invoke", detail: "missing tool", expected: "mcp__screener__watchlist_query", actual: "(none)" },
        ] },
        { run_index: 3, passed: false, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null, failures: [
          { type: "must_invoke", detail: "missing tool", expected: "mcp__screener__watchlist_query", actual: "(none)" },
        ] },
      ] }),
    ]);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("pass-case");
    expect(plain).toContain("fail-case");
    expect(plain).toContain("PASS");
    expect(plain).toContain("FAIL");
    expect(plain).toContain("mcp__screener__watchlist_query");
  });

  it("emits a summary line", () => {
    const out = renderTerminal([caseResult({ id: "a" }), caseResult({ id: "b", passed: false, passing_runs: 1 })]);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/Cases:\s+1 passed, 1 failed/);
  });

  it("renders a judge sub-line when case has judge data", () => {
    const out = renderTerminal([
      caseResult({
        id: "judged-case",
        passed: true,
        passing_runs: 1,
        total_runs: 1,
        runs: [
          {
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
              scores: { data_grounding: 5, task_completion: 4 },
              rationale: { data_grounding: "ok", task_completion: "ok" },
              judge_cost_usd: 0.31,
            },
          },
        ],
        total_duration_ms: 1000,
        total_cost_usd: 0.05,
        total_judge_cost_usd: 0.31,
      }),
    ]);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("judge:");
    expect(plain).toContain("data_grounding=5.0");
    expect(plain).toContain("task_completion=4.0");
  });
});

describe("writeJsonReport", () => {
  it("writes a JSON file that parses back to the schema", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "eval-report-"));
    try {
      const path = join(tmp, "r.json");
      const report = buildReport({
        model: "m",
        cases: [caseResult({ id: "x" })],
        runsPassed: 3, runsFailed: 0,
        durationMs: 1000, costUsd: 0.01,
      });
      await writeJsonReport(path, report);
      const raw = await readFile(path, "utf8");
      const parsed = evalReportSchema.safeParse(JSON.parse(raw));
      expect(parsed.success).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
