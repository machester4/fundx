import { describe, it, expect, vi } from "vitest";
import { runEvalCase } from "../src/services/eval/runner.js";
import type { EvalCase } from "../src/types.js";

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
    const buildChatContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(makeCase(), {
      model: "claude-sonnet-4-6",
      timeoutMs: 60000,
      seed,
      runChatTurn,
      buildChatContext,
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
    const buildChatContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(makeCase(), {
      model: "claude-sonnet-4-6",
      timeoutMs: 60000,
      seed, runChatTurn, buildChatContext, buildChatMcpServers,
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
    const buildChatContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(makeCase({ runs: 2, threshold: 1 }), {
      model: "claude-sonnet-4-6",
      timeoutMs: 50,
      seed, runChatTurn, buildChatContext, buildChatMcpServers,
    });

    expect(result.passed).toBe(false);
    expect(result.runs.every((r) => r.error?.includes("timeout"))).toBe(true);
  });
});
