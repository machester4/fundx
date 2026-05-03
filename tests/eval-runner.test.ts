import { describe, it, expect, vi } from "vitest";
import { runEvalCase } from "../src/services/eval/runner.js";
import type { EvalCase } from "../src/types.js";

vi.mock("../src/services/eval/grader.js", () => ({
  gradeRun: vi.fn(async (run, _config, _opts) => ({
    ...run,
    judge: {
      scores: { data_grounding: 5 },
      rationale: { data_grounding: "ok" },
      judge_cost_usd: 0.31,
    },
  })),
}));

function makeCase(partial: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "mvp-test",
    description: "t",
    prompt: "hi",
    language: "es",
    fund_state: {
      fund_config: {},
      portfolio: { cash: 100, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [],
    },
    expect: { must_invoke: ["foo"], must_not_invoke: [] },
    runs: 3,
    threshold: 2,
    ...partial,
  };
}

describe("runEvalCase", () => {
  it("passes when enough runs meet assertions", async () => {
    const seed = vi.fn().mockResolvedValue({
      fundName: "fundx-eval-abc",
      watchlistDbPath: "/tmp/x",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    const runChatTurn = vi.fn().mockResolvedValue({
      sessionId: "s",
      response: "ok",
      costUsd: 0.02,
      numTurns: 2,
      tokensIn: 100,
      tokensOut: 50,
      toolHistory: [{ name: "foo", elapsed: 0.5 }],
    });
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(makeCase(), {
      model: "claude-sonnet-4-6",
      timeoutMs: 60000,
      seed,
      runChatTurn,
      buildFundContext,
      buildChatMcpServers,
    });

    expect(result.passed).toBe(true);
    expect(result.passing_runs).toBe(3);
    expect(result.runs).toHaveLength(3);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(runChatTurn).toHaveBeenCalledTimes(3);
  });

  it("calls cleanup even when a run throws", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const seed = vi.fn().mockResolvedValue({ fundName: "fundx-eval-x", watchlistDbPath: "/tmp/x", cleanup });
    const runChatTurn = vi.fn().mockRejectedValue(new Error("boom"));
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(makeCase(), {
      model: "claude-sonnet-4-6",
      timeoutMs: 60000,
      seed, runChatTurn, buildFundContext, buildChatMcpServers,
    });

    expect(cleanup).toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.runs.every((r) => r.error === "boom")).toBe(true);
    expect(result.runs.every((r) => r.failures.some((f) => f.type === "run_errored"))).toBe(true);
  });

  it("times out when a run hangs", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const seed = vi.fn().mockResolvedValue({ fundName: "fundx-eval-x", watchlistDbPath: "/tmp/x", cleanup });
    const runChatTurn = vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(makeCase({ runs: 2, threshold: 1 }), {
      model: "claude-sonnet-4-6",
      timeoutMs: 50,
      seed, runChatTurn, buildFundContext, buildChatMcpServers,
    });

    expect(result.passed).toBe(false);
    expect(result.runs.every((r) => r.error?.includes("timeout"))).toBe(true);
  });

  it("dispatches to runAsk when surface is 'ask' and skips runChatTurn", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const seed = vi.fn().mockResolvedValue({
      fundName: "fundx-eval-x",
      watchlistDbPath: "/tmp/x",
      cleanup,
    });
    const runChatTurn = vi.fn();
    const runAsk = vi.fn().mockResolvedValue({
      sessionId: "",
      response: "ok",
      costUsd: 0.02,
      numTurns: 1,
      tokensIn: 100,
      tokensOut: 50,
      toolHistory: [{ name: "foo", elapsed: 0.5 }],
    });
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(
      makeCase({ surface: "ask", expect: { must_invoke: ["foo"], must_not_invoke: [] } }),
      {
        model: "claude-sonnet-4-6",
        timeoutMs: 60000,
        seed,
        runChatTurn,
        runAsk,
        buildFundContext,
        buildChatMcpServers,
      },
    );

    expect(runAsk).toHaveBeenCalledTimes(3);
    expect(runChatTurn).not.toHaveBeenCalled();
    expect(result.passed).toBe(true);
  });

  it("throws a clear error when surface is 'ask' but runAsk is missing from deps", async () => {
    const seed = vi.fn();
    const runChatTurn = vi.fn();
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    await expect(
      runEvalCase(
        makeCase({ surface: "ask" }),
        {
          model: "claude-sonnet-4-6",
          timeoutMs: 60000,
          seed,
          runChatTurn,
          // runAsk omitted intentionally
          buildFundContext,
          buildChatMcpServers,
        },
      ),
    ).rejects.toThrow(/surface "ask" but RunnerDeps\.runAsk was not provided/);

    // seed was never called — the validation runs before any side effect
    expect(seed).not.toHaveBeenCalled();
  });

  it("calls gradeRun when case.expect.judge is configured", async () => {
    const { gradeRun } = await import("../src/services/eval/grader.js");
    vi.mocked(gradeRun).mockClear();

    const seed = vi.fn().mockResolvedValue({
      fundName: "fundx-eval-x",
      watchlistDbPath: "/tmp/x",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    const runChatTurn = vi.fn().mockResolvedValue({
      sessionId: "s",
      response: "ok",
      costUsd: 0.02,
      numTurns: 1,
      tokensIn: 100,
      tokensOut: 50,
      toolHistory: [{ name: "foo", elapsed: 0.5 }],
    });
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    await runEvalCase(
      makeCase({
        expect: {
          must_invoke: [],
          must_not_invoke: [],
          judge: { dims: { data_grounding: 4 } },
        },
      }),
      {
        model: "claude-sonnet-4-6",
        timeoutMs: 60000,
        seed,
        runChatTurn,
        buildFundContext,
        buildChatMcpServers,
      },
    );

    expect(vi.mocked(gradeRun)).toHaveBeenCalled();
  });

  it("does NOT call gradeRun when no judge configured", async () => {
    const { gradeRun } = await import("../src/services/eval/grader.js");
    vi.mocked(gradeRun).mockClear();

    const seed = vi.fn().mockResolvedValue({
      fundName: "fundx-eval-x",
      watchlistDbPath: "/tmp/x",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    const runChatTurn = vi.fn().mockResolvedValue({
      sessionId: "s",
      response: "ok",
      costUsd: 0.02,
      numTurns: 1,
      tokensIn: 100,
      tokensOut: 50,
      toolHistory: [{ name: "foo", elapsed: 0.5 }],
    });
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    await runEvalCase(makeCase(), {
      model: "claude-sonnet-4-6",
      timeoutMs: 60000,
      seed,
      runChatTurn,
      buildFundContext,
      buildChatMcpServers,
    });

    expect(vi.mocked(gradeRun)).not.toHaveBeenCalled();
  });

  it("does NOT call gradeRun if run errored before grading", async () => {
    const { gradeRun } = await import("../src/services/eval/grader.js");
    vi.mocked(gradeRun).mockClear();

    const seed = vi.fn().mockResolvedValue({
      fundName: "fundx-eval-x",
      watchlistDbPath: "/tmp/x",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    const runChatTurn = vi.fn().mockRejectedValue(new Error("simulated run error"));
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    await runEvalCase(
      makeCase({
        expect: {
          must_invoke: [],
          must_not_invoke: [],
          judge: { dims: { data_grounding: 4 } },
        },
      }),
      {
        model: "claude-sonnet-4-6",
        timeoutMs: 60000,
        seed,
        runChatTurn,
        buildFundContext,
        buildChatMcpServers,
      },
    );

    expect(vi.mocked(gradeRun)).not.toHaveBeenCalled();
  });

  it("emits judge_invocation_error (not judge_below_threshold) when gradeRun throws", async () => {
    const { gradeRun } = await import("../src/services/eval/grader.js");
    vi.mocked(gradeRun).mockReset();
    vi.mocked(gradeRun).mockRejectedValueOnce(new Error("calibration missing"));

    const seed = vi.fn().mockResolvedValue({
      fundName: "fundx-eval-x",
      watchlistDbPath: "/tmp/x",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    const runChatTurn = vi.fn().mockResolvedValue({
      sessionId: "s",
      response: "ok",
      costUsd: 0.02,
      numTurns: 1,
      tokensIn: 100,
      tokensOut: 50,
      toolHistory: [{ name: "foo", elapsed: 0.5 }],
    });
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(
      makeCase({
        runs: 1,
        threshold: 1,
        expect: {
          must_invoke: [],
          must_not_invoke: [],
          judge: { dims: { data_grounding: 4 } },
        },
      }),
      {
        model: "claude-sonnet-4-6",
        timeoutMs: 60000,
        seed,
        runChatTurn,
        buildFundContext,
        buildChatMcpServers,
      },
    );

    const failures = result.runs[0].failures;
    expect(failures.find((f) => f.type === "judge_invocation_error")).toBeDefined();
    expect(failures.find((f) => f.type === "judge_below_threshold")).toBeUndefined();
    expect(failures.find((f) => f.type === "judge_invocation_error")?.actual).toContain("calibration missing");

    // Reset mock to default for subsequent tests
    vi.mocked(gradeRun).mockImplementation(async (run) => ({
      ...run,
      judge: {
        scores: { data_grounding: 5 },
        rationale: { data_grounding: "ok" },
        judge_cost_usd: 0.31,
      },
    }));
  });

  it("aggregates judge_cost_usd into total_judge_cost_usd on the case result", async () => {
    const { gradeRun } = await import("../src/services/eval/grader.js");
    vi.mocked(gradeRun).mockClear();

    const seed = vi.fn().mockResolvedValue({
      fundName: "fundx-eval-x",
      watchlistDbPath: "/tmp/x",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    const runChatTurn = vi.fn().mockResolvedValue({
      sessionId: "s",
      response: "ok",
      costUsd: 0.02,
      numTurns: 1,
      tokensIn: 100,
      tokensOut: 50,
      toolHistory: [{ name: "foo", elapsed: 0.5 }],
    });
    const buildFundContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(
      makeCase({
        runs: 2,
        threshold: 1,
        expect: {
          must_invoke: [],
          must_not_invoke: [],
          judge: { dims: { data_grounding: 4 } },
        },
      }),
      {
        model: "claude-sonnet-4-6",
        timeoutMs: 60000,
        seed,
        runChatTurn,
        buildFundContext,
        buildChatMcpServers,
      },
    );

    expect(result.total_judge_cost_usd).toBeDefined();
    expect(result.total_judge_cost_usd).toBeCloseTo(0.62, 2); // 2 runs × $0.31 from mock
  });
});
