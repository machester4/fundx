import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  EvalRunCapture,
  EvalFailure,
  JudgeConfig,
  JudgeDim,
  JudgeResult,
} from "../../types.js";

export interface GradeRunOptions {
  /** Override judge model. Defaults to "claude-opus-4-7". */
  model?: string;
  /** Path to calibration directory. Defaults to "tests/eval/calibration". */
  calibrationDir?: string;
  /** AbortSignal for the underlying SDK call. */
  signal?: AbortSignal;
}

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_CALIBRATION_DIR = "tests/eval/calibration";

/** Run the LLM-as-judge against an EvalRunCapture. Returns the run augmented
 *  with `judge` field populated and any judge_below_threshold failures appended.
 *  Pure async — no global state mutation, no input mutation. */
export async function gradeRun(
  run: EvalRunCapture,
  judgeConfig: JudgeConfig,
  options?: GradeRunOptions,
): Promise<EvalRunCapture> {
  const calibrationDir = options?.calibrationDir ?? DEFAULT_CALIBRATION_DIR;
  const model = options?.model ?? DEFAULT_MODEL;

  const dims = Object.keys(judgeConfig.dims) as JudgeDim[];
  const calibration = await loadCalibration(dims, calibrationDir);
  const prompt = buildJudgePrompt(run, dims, calibration);

  const { scores, rationale, parserFailed, judge_cost_usd } = await callJudge(
    prompt,
    model,
    options?.signal,
  );

  const finalScores: Partial<Record<JudgeDim, number>> = {};
  const finalRationale: Partial<Record<JudgeDim, string>> = {};
  for (const dim of dims) {
    if (parserFailed) {
      finalScores[dim] = 1;
      finalRationale[dim] = `parser failed: ${rationale.parserError ?? "unknown"}`;
    } else {
      // Clamp to 1-5
      const raw = scores[dim] ?? 1;
      finalScores[dim] = Math.max(1, Math.min(5, raw));
      finalRationale[dim] = rationale[dim] ?? "(no rationale)";
    }
  }

  const judgeResult: JudgeResult = {
    scores: finalScores as Record<JudgeDim, number>,
    rationale: finalRationale as Record<JudgeDim, string>,
    judge_cost_usd,
  };

  const newFailures: EvalFailure[] = [];
  for (const dim of dims) {
    const score = finalScores[dim]!;
    const threshold = judgeConfig.dims[dim]!;
    if (score < threshold) {
      newFailures.push({
        type: "judge_below_threshold",
        detail: `${dim} scored below threshold`,
        expected: `${dim} >= ${threshold}`,
        actual: `${dim} = ${score}: '${finalRationale[dim]}'`,
      });
    }
  }

  return {
    ...run,
    judge: judgeResult,
    failures: [...run.failures, ...newFailures],
    passed: run.passed && newFailures.length === 0,
  };
}

async function loadCalibration(
  dims: JudgeDim[],
  calibrationDir: string,
): Promise<Map<JudgeDim, string>> {
  const map = new Map<JudgeDim, string>();
  for (const dim of dims) {
    const path = join(calibrationDir, `${dim}.md`);
    try {
      const content = await readFile(path, "utf-8");
      map.set(dim, content);
    } catch (err) {
      throw new Error(
        `Calibration file missing for dim "${dim}" at ${path}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return map;
}

function buildJudgePrompt(
  run: EvalRunCapture,
  dims: JudgeDim[],
  calibration: Map<JudgeDim, string>,
): string {
  const dimsSections = dims.map((dim) => `## ${dim}\n${calibration.get(dim)}`).join("\n\n");
  const toolHistoryYaml = run.tool_history
    .map((t) => `- name: ${t.name}\n  elapsed_s: ${t.elapsed.toFixed(2)}`)
    .join("\n") || "(none)";

  const outputSpec = dims
    .flatMap((dim) => [`${dim}: <1-5>`, `${dim}_rationale: <one sentence>`])
    .join("\n");

  return `You are an evaluator scoring an AI agent's output against a rubric.

# Agent's final response
<agent_output>
${run.final_response}
</agent_output>

# Tools the agent invoked (chronological)
<tool_history>
${toolHistoryYaml}
</tool_history>

# Dimensions to score (1-5 scale)

${dimsSections}

# Output format

Score each dimension 1-5 based on the calibration. Provide one-sentence
rationale per dimension.

<judge_score>
${outputSpec}
</judge_score>`;
}

interface CallJudgeResult {
  scores: Partial<Record<JudgeDim, number>>;
  rationale: Partial<Record<JudgeDim, string>> & { parserError?: string };
  parserFailed: boolean;
  judge_cost_usd: number;
}

async function callJudge(
  prompt: string,
  model: string,
  signal?: AbortSignal,
): Promise<CallJudgeResult> {
  let output = "";
  let costUsd = 0;

  const abortController = new AbortController();
  if (signal) {
    signal.addEventListener("abort", () => abortController.abort());
  }

  for await (const message of query({
    prompt,
    options: {
      model,
      maxTurns: 1,
      maxBudgetUsd: 5,
      cwd: process.cwd(),
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      abortController,
    },
  })) {
    if (
      message.type === "result" &&
      "subtype" in message &&
      message.subtype === "success" &&
      "result" in message
    ) {
      output = (message as { result: string }).result;
      costUsd = (message as { total_cost_usd?: number }).total_cost_usd ?? 0;
    }
  }

  return parseJudgeResponse(output, costUsd);
}

const SCORE_LINE_RE = /^([a-z_]+):\s*(\d+)\s*$/im;
const RATIONALE_LINE_RE = /^([a-z_]+)_rationale:\s*(.+)$/im;
const JUDGE_BLOCK_RE = /<judge_score>([\s\S]*?)<\/judge_score>/;

export function parseJudgeResponse(text: string, costUsd: number): CallJudgeResult {
  const blockMatch = text.match(JUDGE_BLOCK_RE);
  if (!blockMatch) {
    return {
      scores: {},
      rationale: { parserError: "no <judge_score> block found" },
      parserFailed: true,
      judge_cost_usd: costUsd,
    };
  }

  const inner = blockMatch[1];
  const lines = inner.split("\n").map((l) => l.trim()).filter(Boolean);

  const scores: Partial<Record<JudgeDim, number>> = {};
  const rationale: Partial<Record<JudgeDim, string>> = {};

  for (const line of lines) {
    const ratMatch = line.match(RATIONALE_LINE_RE);
    if (ratMatch) {
      const dim = ratMatch[1] as JudgeDim;
      rationale[dim] = ratMatch[2].trim();
      continue;
    }
    const scoreMatch = line.match(SCORE_LINE_RE);
    if (scoreMatch) {
      const dim = scoreMatch[1] as JudgeDim;
      const score = parseInt(scoreMatch[2], 10);
      if (!Number.isNaN(score)) {
        scores[dim] = score;
      }
    }
  }

  return {
    scores,
    rationale,
    parserFailed: false,
    judge_cost_usd: costUsd,
  };
}
