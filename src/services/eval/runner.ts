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
                type: "judge_below_threshold",
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
    judge_total_cost_usd:
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
    const result = caseDef.surface === "ask"
      ? await withTimeout(
          deps.runAsk!(fundName, caseDef.prompt, { model: deps.model }),
          deps.timeoutMs,
        )
      : await withTimeout(
          deps.runChatTurn(fundName, undefined, caseDef.prompt, context, {
            model: deps.model,
            readonly: true,
            mcpServers,
            maxBudgetUsd: 0.5,
          }),
          deps.timeoutMs,
        );
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`eval timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(t); resolve(value); },
      (err) => { clearTimeout(t); reject(err); },
    );
  });
}
