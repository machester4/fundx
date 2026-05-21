import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { z } from "zod";
import { join } from "node:path";
import {
  loadEvalCases,
  filterCases,
  seedEvalFund,
  sweepEvalOrphans,
  runEvalCase,
  renderTerminal,
  buildReport,
  writeJsonReport,
} from "../services/eval/index.js";
import {
  runChatTurn,
  buildFundContext,
  buildChatMcpServers,
} from "../services/chat.service.js";
import { runAskQuery } from "../services/ask.service.js";
import { runMetaReflection } from "../services/meta-reflection.service.js";
import type { EvalCaseResult } from "../types.js";

export const description = "Run the prompt evaluation suite against the chat surface";

export const options = z.object({
  case: z.string().optional().describe("Run a single case by id"),
  filter: z.string().optional().describe("Substring match on case id"),
  json: z.string().optional().describe("Write full JSON report to this path"),
  concurrency: z.coerce.number().int().positive().default(2),
  runs: z.coerce.number().int().positive().optional().describe("Override per-case K"),
  model: z.string().default("claude-sonnet-4-6"),
  bail: z.boolean().default(false).describe("Stop at first failing case"),
  timeout: z.coerce
    .number()
    .int()
    .positive()
    .default(120)
    .describe("Per-run wallclock timeout (s)"),
});

type Options = z.infer<typeof options>;

type Props = { options: Options };

export default function EvalCommand({ options: opts }: Props) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<"loading" | "running" | "done" | "error">(
    "loading",
  );
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [finalOutput, setFinalOutput] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function main(): Promise<void> {
      try {
        setStatusLines(["Loading cases..."]);

        // Sweep any orphaned fundx-eval-* dirs left over from a previously
        // interrupted run. Dirs younger than 30 min are preserved in case a
        // sibling eval process is still using them.
        try {
          const sweep = await sweepEvalOrphans();
          if (sweep.removed.length > 0) {
            appendStatus(
              setStatusLines,
              `Cleaned ${sweep.removed.length} orphan eval fund(s): ${sweep.removed.join(", ")}`,
            );
          }
        } catch (err) {
          appendStatus(
            setStatusLines,
            `Warning: orphan sweep failed: ${(err as Error).message}`,
          );
        }

        const casesDir = join(process.cwd(), "tests", "eval", "cases");
        const fixturesDir = join(process.cwd(), "tests", "eval", "fixtures");
        const allCases = await loadEvalCases({ casesDir, fixturesDir });
        const cases = filterCases(allCases, {
          case: opts.case,
          filter: opts.filter,
        }).map((c) =>
          opts.runs
            ? {
                ...c,
                runs: opts.runs,
                threshold: Math.min(c.threshold, opts.runs),
              }
            : c,
        );

        if (cases.length === 0) {
          setPhase("error");
          setFinalOutput("No cases matched the filter.");
          exit();
          return;
        }

        setPhase("running");
        appendStatus(
          setStatusLines,
          `Loaded ${cases.length} case(s). model=${opts.model} concurrency=${opts.concurrency}`,
        );

        const startedAt = Date.now();
        const results: EvalCaseResult[] = [];
        let totalCost = 0;
        let costWarned = false;

        const limit = makeLimit(opts.concurrency);
        const tasks = cases.map((c) =>
          limit(async () => {
            if (cancelled) return;
            const started = Date.now();
            appendStatus(setStatusLines, `> ${c.id} started`);
            const result = await runEvalCase(c, {
              model: opts.model,
              timeoutMs: opts.timeout * 1000,
              seed: (state) => seedEvalFund(state),
              runChatTurn: async (fundName, sessionId, prompt, context, runOpts) => {
                // Bridge: remap ChatTurnResult field names to RunChatTurnResult shape.
                // ChatTurnResult uses cost_usd / num_turns / responseText;
                // RunChatTurnResult expects costUsd / numTurns / response.
                const out = await runChatTurn(
                  fundName,
                  sessionId,
                  prompt,
                  context,
                  {
                    model: runOpts.model,
                    readonly: runOpts.readonly,
                    mcpServers: runOpts.mcpServers,
                    maxBudgetUsd: runOpts.maxBudgetUsd,
                  },
                );
                return {
                  sessionId: out.sessionId,
                  response: out.responseText,
                  costUsd: out.cost_usd,
                  numTurns: out.num_turns,
                  tokensIn: out.tokensIn,
                  tokensOut: out.tokensOut,
                  toolHistory: out.toolHistory,
                };
              },
              runAsk: async (fundName, question, runOpts) => {
                const r = await runAskQuery(question, { fund: fundName, model: runOpts.model, search: false });
                return {
                  sessionId: "",
                  response: r.output,
                  costUsd: r.costUsd,
                  numTurns: r.numTurns,
                  tokensIn: r.tokensIn,
                  tokensOut: r.tokensOut,
                  toolHistory: r.toolHistory,
                };
              },
              runMetaReflectionEval: async (fundName, _runOpts) => {
                // runMetaReflection returns void. The runner reads memory files via
                // readMemoryFilesForJudge and overwrites result.response for the judge,
                // so there is no need to capture output here.
                await runMetaReflection(fundName);
                return {
                  sessionId: "",
                  response: "",
                  costUsd: 0,
                  numTurns: 0,
                  tokensIn: 0,
                  tokensOut: 0,
                  toolHistory: [],
                };
              },
              buildFundContext: (fundName, opts) => buildFundContext(fundName, opts),
              buildChatMcpServers: (fundName) => buildChatMcpServers(fundName),
            });
            results.push(result);
            totalCost += result.total_cost_usd;
            const ms = Date.now() - started;
            const verdict = result.passed ? "PASS" : "FAIL";
            appendStatus(
              setStatusLines,
              `${result.passed ? "+" : "x"} ${c.id}  ${verdict} ${result.passing_runs}/${result.total_runs}  ${(ms / 1000).toFixed(1)}s  $${result.total_cost_usd.toFixed(4)}`,
            );

            if (!result.passed && opts.bail) cancelled = true;

            if (!costWarned && totalCost > 10) {
              costWarned = true;
              appendStatus(
                setStatusLines,
                `WARNING: cumulative cost exceeded $10 — continuing.`,
              );
            }
          }),
        );
        await Promise.all(tasks);

        const runsPassed = results.reduce((acc, c) => acc + c.passing_runs, 0);
        const runsFailed = results.reduce(
          (acc, c) => acc + (c.total_runs - c.passing_runs),
          0,
        );
        const durationMs = Date.now() - startedAt;
        const report = buildReport({
          model: opts.model,
          cases: results,
          runsPassed,
          runsFailed,
          durationMs,
          costUsd: totalCost,
        });

        if (opts.json) await writeJsonReport(opts.json, report);

        setFinalOutput(renderTerminal(results));
        setPhase("done");
        const anyFail = results.some((r) => !r.passed);
        if (anyFail) process.exitCode = 1;
        exit();
      } catch (err) {
        setPhase("error");
        setFinalOutput(
          `Eval failed: ${(err as Error).message}\n${(err as Error).stack ?? ""}`,
        );
        process.exitCode = 2;
        exit();
      }
    }

    void main();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase === "loading" || phase === "running") {
    return (
      <Box flexDirection="column">
        {statusLines.slice(-20).map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>{finalOutput}</Text>
    </Box>
  );
}

function appendStatus(
  setter: React.Dispatch<React.SetStateAction<string[]>>,
  line: string,
): void {
  setter((prev) => [...prev, line]);
}

/** Hand-rolled concurrency limiter (semaphore). */
function makeLimit(
  concurrency: number,
): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];

  function next(): void {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    job();
  }

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(
          (v) => {
            active--;
            resolve(v);
            next();
          },
          (e) => {
            active--;
            reject(e);
            next();
          },
        );
      });
      next();
    });
  };
}
