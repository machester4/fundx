import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpCalibration = join(tmpdir(), `grader-calibration-${Date.now()}`);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  AbortError: class AbortError extends Error {},
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
const mockedQuery = vi.mocked(query);

import { gradeRun } from "../../src/services/eval/grader.js";
import type { EvalRunCapture, JudgeConfig } from "../../src/types.js";

beforeEach(async () => {
  vi.clearAllMocks();
  await rm(tmpCalibration, { recursive: true, force: true });
  await mkdir(tmpCalibration, { recursive: true });
  await writeFile(
    join(tmpCalibration, "data_grounding.md"),
    "# data_grounding rubric\nScore 1: hallucinated\nScore 5: fully grounded",
    "utf-8",
  );
  await writeFile(
    join(tmpCalibration, "task_completion.md"),
    "# task_completion rubric\nScore 1: failed\nScore 5: complete",
    "utf-8",
  );
});

const baseRun = (): EvalRunCapture => ({
  run_index: 1,
  passed: true,
  tool_history: [{ name: "get_snapshot", elapsed: 1.2 }],
  tokens_in: 1000,
  tokens_out: 500,
  num_turns: 3,
  duration_ms: 5000,
  cost_usd: 0.05,
  final_response: "AAPL is at $185 (retrieved this session via get_snapshot).",
  error: null,
  failures: [],
});

const baseConfig = (): JudgeConfig => ({
  dims: { data_grounding: 4, task_completion: 4 },
});

// Helper: mock the SDK query() to yield a single result message with judge XML
function mockJudgeResponse(text: string, costUsd = 0.31): void {
  mockedQuery.mockImplementation(async function* () {
    yield {
      type: "result",
      subtype: "success",
      result: text,
      total_cost_usd: costUsd,
      num_turns: 1,
      modelUsage: { "claude-opus-4-7": { inputTokens: 100, outputTokens: 50 } },
      session_id: "judge-fake",
    };
  } as never);
}

describe("gradeRun", () => {
  it("augments run with judge field on successful scoring", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: every number retrieved
task_completion: 4
task_completion_rationale: addressed request with minor gap
</judge_score>`);

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    expect(out.judge).toBeDefined();
    expect(out.judge?.scores.data_grounding).toBe(5);
    expect(out.judge?.scores.task_completion).toBe(4);
    expect(out.judge?.rationale.data_grounding).toContain("retrieved");
    expect(out.judge?.judge_cost_usd).toBe(0.31);
  });

  it("emits judge_below_threshold failure when score is below threshold", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 2
data_grounding_rationale: cited unverified prices
task_completion: 5
task_completion_rationale: complete
</judge_score>`);

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    expect(out.failures.length).toBeGreaterThan(0);
    const judgeFailure = out.failures.find((f) => f.type === "judge_below_threshold");
    expect(judgeFailure).toBeDefined();
    expect(judgeFailure!.expected).toContain("data_grounding >= 4");
    expect(judgeFailure!.actual).toContain("data_grounding = 2");
    expect(judgeFailure!.actual).toContain("cited unverified prices");
  });

  it("emits no judge_below_threshold when all dims pass", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    const judgeFailures = out.failures.filter((f) => f.type === "judge_below_threshold");
    expect(judgeFailures).toHaveLength(0);
  });

  it("treats malformed judge response as score=1 across all dims", async () => {
    mockJudgeResponse("Sorry, I cannot evaluate this response.");

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    expect(out.judge?.scores.data_grounding).toBe(1);
    expect(out.judge?.scores.task_completion).toBe(1);
    expect(out.judge?.rationale.data_grounding).toContain("parser failed");
    // Both dims fail threshold (4 vs 1)
    expect(out.failures.filter((f) => f.type === "judge_below_threshold")).toHaveLength(2);
  });

  it("clamps out-of-range scores to 1-5", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 7
data_grounding_rationale: tried to give 7 (invalid)
task_completion: 0
task_completion_rationale: tried to give 0 (invalid)
</judge_score>`);

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    expect(out.judge?.scores.data_grounding).toBe(5);
    expect(out.judge?.scores.task_completion).toBe(1);
  });

  it("only scores the dims declared in judgeConfig", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 4
data_grounding_rationale: ok
task_completion: 4
task_completion_rationale: ok
</judge_score>`);

    const config: JudgeConfig = { dims: { data_grounding: 4 } };
    const out = await gradeRun(baseRun(), config, { calibrationDir: tmpCalibration });

    expect(out.judge?.scores.data_grounding).toBe(4);
    // task_completion was scored but config only requested data_grounding
    // Verify: no judge_below_threshold for task_completion
    const taskFailures = out.failures.filter(
      (f) => f.type === "judge_below_threshold" && f.expected.includes("task_completion"),
    );
    expect(taskFailures).toHaveLength(0);
  });

  it("throws when calibration file is missing", async () => {
    await rm(join(tmpCalibration, "data_grounding.md"));
    await expect(
      gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration }),
    ).rejects.toThrow();
  });

  it("includes calibration content in the judge prompt", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockedQuery.mock.calls[0][0] as { prompt: string };
    expect(callArgs.prompt).toContain("data_grounding rubric");
    expect(callArgs.prompt).toContain("task_completion rubric");
  });

  it("includes agent's final_response in the judge prompt", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

    const callArgs = mockedQuery.mock.calls[0][0] as { prompt: string };
    expect(callArgs.prompt).toContain("AAPL is at $185");
  });

  it("includes tool_history in the judge prompt", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

    const callArgs = mockedQuery.mock.calls[0][0] as { prompt: string };
    expect(callArgs.prompt).toContain("get_snapshot");
  });

  it("uses Opus 4.7 as default judge model", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

    const callArgs = mockedQuery.mock.calls[0][0] as { options: { model: string } };
    expect(callArgs.options.model).toBe("claude-opus-4-7");
  });

  it("respects model override option", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
      model: "claude-haiku-4-5-20251001",
    });

    const callArgs = mockedQuery.mock.calls[0][0] as { options: { model: string } };
    expect(callArgs.options.model).toBe("claude-haiku-4-5-20251001");
  });

  it("strips CLAUDECODE env var when invoking the SDK (prevents nested-session error)", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    // Set CLAUDECODE so we can verify it gets stripped
    const originalClaudeCode = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";

    try {
      await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

      const callArgs = mockedQuery.mock.calls[0][0] as { options: { env?: Record<string, string> } };
      expect(callArgs.options.env).toBeDefined();
      expect(callArgs.options.env).not.toHaveProperty("CLAUDECODE");
    } finally {
      // Restore env to original state
      if (originalClaudeCode === undefined) {
        delete process.env.CLAUDECODE;
      } else {
        process.env.CLAUDECODE = originalClaudeCode;
      }
    }
  });

  it("captures judge_cost_usd even when SDK terminates with error subtype", async () => {
    // Mock SDK ending with error_max_budget — cost should still be captured
    mockedQuery.mockImplementation(async function* () {
      yield {
        type: "result",
        subtype: "error_max_budget",
        total_cost_usd: 0.42,
        num_turns: 1,
        modelUsage: { "claude-opus-4-7": { inputTokens: 100, outputTokens: 50 } },
        session_id: "judge-fake",
      };
    } as never);

    const out = await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

    // Cost telemetry preserved even though judge didn't produce output
    expect(out.judge?.judge_cost_usd).toBe(0.42);
    // Parser failed (no output produced) — scores default to 1
    expect(out.judge?.scores.data_grounding).toBe(1);
    expect(out.judge?.rationale.data_grounding).toContain("parser failed");
  });
});
