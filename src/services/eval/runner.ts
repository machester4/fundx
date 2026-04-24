import type {
  EvalCase,
  EvalCaseResult,
  EvalRunCapture,
} from "../../types.js";
import type { ChatMcpServers } from "../chat.service.js";
import { evaluateRun, evaluateCase } from "./assertions.js";
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
  buildChatContext: (fundName: string) => Promise<string>;
  buildChatMcpServers: (fundName: string) => Promise<ChatMcpServers>;
}

export async function runEvalCase(caseDef: EvalCase, deps: RunnerDeps): Promise<EvalCaseResult> {
  const startedAt = Date.now();
  const handle = await deps.seed(caseDef.fund_state);
  const runs: EvalRunCapture[] = [];

  try {
    const mcpServers = await deps.buildChatMcpServers(handle.fundName);
    const context = await deps.buildChatContext(handle.fundName);

    for (let i = 0; i < caseDef.runs; i++) {
      const capture = await runOnce(i + 1, caseDef, context, mcpServers, handle.fundName, deps);
      runs.push(evaluateRun(capture, caseDef.expect));
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
    const result = await withTimeout(
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
