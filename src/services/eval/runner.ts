import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fundPaths } from "../../paths.js";
import type {
  EvalCase,
  EvalCaseResult,
  EvalRunCapture,
} from "../../types.js";
import type { ChatMcpServers } from "../chat.service.js";
import { evaluateRun, evaluateCase } from "./assertions.js";
import { gradeRun } from "./grader.js";
import type { SeedEvalFundHandle } from "./seed.js";

export interface RunChatTurnResult {
  sessionId: string;
  response: string;
  costUsd: number;
  numTurns: number;
  tokensIn: number;
  tokensOut: number;
  toolHistory: Array<{ name: string; elapsed: number }>;
}

export interface RunnerDeps {
  model: string;
  timeoutMs: number;
  seed: (state: EvalCase["fund_state"]) => Promise<SeedEvalFundHandle>;
  runChatTurn: (
    fundName: string,
    sessionId: string | undefined,
    prompt: string,
    context: string,
    opts: { model: string; readonly: boolean; mcpServers: ChatMcpServers; maxBudgetUsd?: number },
  ) => Promise<RunChatTurnResult>;
  runAsk?: (
    fundName: string,
    question: string,
    opts: { model: string },
  ) => Promise<RunChatTurnResult>;
  /** Required when any case has surface="meta_reflection". Runs one
   *  meta-reflection cycle and returns the eval-compatible result shape.
   *  The `response` field carries the post-run memory file contents for the
   *  LLM judge to evaluate. */
  runMetaReflectionEval?: (
    fundName: string,
    opts: { model: string },
  ) => Promise<RunChatTurnResult>;
  buildFundContext: (
    fundName: string,
    opts?: { watchlistDbPath?: string },
  ) => Promise<string>;
  buildChatMcpServers: (fundName: string) => Promise<ChatMcpServers>;
}

export async function runEvalCase(caseDef: EvalCase, deps: RunnerDeps): Promise<EvalCaseResult> {
  if (caseDef.surface === "ask" && !deps.runAsk) {
    throw new Error(
      `Case "${caseDef.id}" has surface "ask" but RunnerDeps.runAsk was not provided`,
    );
  }
  if (caseDef.surface === "meta_reflection" && !deps.runMetaReflectionEval) {
    throw new Error(
      `Case "${caseDef.id}" has surface "meta_reflection" but RunnerDeps.runMetaReflectionEval was not provided`,
    );
  }
  const startedAt = Date.now();
  const handle = await deps.seed(caseDef.fund_state);
  const runs: EvalRunCapture[] = [];

  try {
    const mcpServers = await deps.buildChatMcpServers(handle.fundName);
    // Pass the seeder's watchlist DB path explicitly to avoid the
    // process.env.FUNDX_WATCHLIST_DB_PATH race when concurrency > 1: two
    // concurrent seeds mutate the env var, so a context built after the
    // second seed would see the first seed's DB.
    const context = await deps.buildFundContext(handle.fundName, {
      watchlistDbPath: handle.watchlistDbPath,
    });

    for (let i = 0; i < caseDef.runs; i++) {
      const capture = await runOnce(i + 1, caseDef, context, mcpServers, handle.fundName, deps);
      let run = evaluateRun(capture, caseDef.expect);

      if (caseDef.expect.judge && !run.error) {
        try {
          run = await gradeRun(run, caseDef.expect.judge);
        } catch (err) {
          console.warn(
            `[eval-grader] gradeRun threw for case ${caseDef.id} run ${i + 1}:`,
            err instanceof Error ? err.message : err,
          );
          run = {
            ...run,
            failures: [
              ...run.failures,
              {
                type: "judge_invocation_error",
                detail: "Judge invocation failed",
                expected: "judge to complete",
                actual: err instanceof Error ? err.message : String(err),
              },
            ],
            passed: false,
          };
        }
      }

      runs.push(run);
    }
  } finally {
    await handle.cleanup();
  }

  const aggregate = evaluateCase(runs, caseDef.threshold);
  return {
    id: caseDef.id,
    description: caseDef.description,
    passed: aggregate.passed,
    passing_runs: aggregate.passing_runs,
    total_runs: aggregate.total_runs,
    threshold: caseDef.threshold,
    runs,
    total_duration_ms: Date.now() - startedAt,
    total_cost_usd: runs.reduce((acc, r) => acc + r.cost_usd, 0),
    total_judge_cost_usd:
      runs.some((r) => r.judge !== undefined)
        ? runs.reduce((sum, r) => sum + (r.judge?.judge_cost_usd ?? 0), 0)
        : undefined,
  };
}

async function runOnce(
  runIndex: number,
  caseDef: EvalCase,
  context: string,
  mcpServers: ChatMcpServers,
  fundName: string,
  deps: RunnerDeps,
): Promise<EvalRunCapture> {
  const startedAt = Date.now();
  try {
    let result: RunChatTurnResult;
    if (caseDef.surface === "ask") {
      result = await withTimeout(
        deps.runAsk!(fundName, caseDef.prompt!, { model: deps.model }),
        deps.timeoutMs,
      );
    } else if (caseDef.surface === "meta_reflection") {
      // Run the meta-reflection cycle, then read the resulting memory files
      // so the LLM judge can evaluate what was actually written.
      result = await withTimeout(
        deps.runMetaReflectionEval!(fundName, { model: deps.model }),
        deps.timeoutMs,
      );
      // Override response with memory file contents for the judge rubric.
      const memoryContents = await readMemoryFilesForJudge(fundName);
      result = { ...result, response: memoryContents };
    } else {
      result = await withTimeout(
        deps.runChatTurn(fundName, undefined, caseDef.prompt!, context, {
          model: deps.model,
          readonly: true,
          mcpServers,
          maxBudgetUsd: 0.5,
        }),
        deps.timeoutMs,
      );
    }
    return {
      run_index: runIndex,
      passed: false,
      tool_history: result.toolHistory,
      tokens_in: result.tokensIn,
      tokens_out: result.tokensOut,
      num_turns: result.numTurns,
      duration_ms: Date.now() - startedAt,
      cost_usd: result.costUsd,
      final_response: result.response,
      error: null,
      failures: [],
    };
  } catch (err) {
    return {
      run_index: runIndex,
      passed: false,
      tool_history: [],
      tokens_in: 0,
      tokens_out: 0,
      num_turns: 0,
      duration_ms: Date.now() - startedAt,
      cost_usd: 0,
      final_response: "",
      error: (err as Error).message,
      failures: [],
    };
  }
}

/** Read memory files post-run and concatenate their contents for the LLM judge.
 *  Returns a formatted string the judge can assess against the rubric. */
async function readMemoryFilesForJudge(fundName: string): Promise<string> {
  const paths = fundPaths(fundName);
  const files = ["market-lessons.md", "trading-patterns.md", "fund-notes.md"];
  const parts: string[] = [];
  for (const name of files) {
    try {
      const content = await readFile(join(paths.memory, name), "utf-8");
      parts.push(`=== ${name} ===\n${content}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      parts.push(`=== ${name} ===\n(file not created)`);
    }
  }
  return parts.join("\n\n");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`eval timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(t); resolve(value); },
      (err) => { clearTimeout(t); reject(err); },
    );
  });
}
