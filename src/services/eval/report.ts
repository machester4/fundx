import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvalCaseResult, EvalReport, JudgeDim } from "../../types.js";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";

export interface BuildReportInput {
  model: string;
  cases: EvalCaseResult[];
  runsPassed: number;
  runsFailed: number;
  durationMs: number;
  costUsd: number;
}

export function buildReport(input: BuildReportInput): EvalReport {
  const passedCount = input.cases.filter((c) => c.passed).length;
  return {
    schema_version: 1,
    timestamp: new Date().toISOString(),
    model: input.model,
    total_cost_usd: input.costUsd,
    total_duration_ms: input.durationMs,
    summary: {
      cases_passed: passedCount,
      cases_failed: input.cases.length - passedCount,
      runs_passed: input.runsPassed,
      runs_failed: input.runsFailed,
    },
    cases: input.cases,
    total_judge_cost_usd:
      input.cases.some((c) => c.judge_total_cost_usd !== undefined)
        ? input.cases.reduce((sum, c) => sum + (c.judge_total_cost_usd ?? 0), 0)
        : undefined,
  };
}

export function renderTerminal(cases: EvalCaseResult[]): string {
  const lines: string[] = [];
  lines.push(`${BOLD}═══ Results ═══${RESET}`);
  lines.push("");

  for (const c of cases) {
    const mark = c.passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const verdict = c.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    const passRate = `${c.passing_runs}/${c.total_runs}`;
    const secs = (c.total_duration_ms / 1000).toFixed(1);
    const cost = `$${c.total_cost_usd.toFixed(2)}`;
    lines.push(`${mark} ${c.id.padEnd(32)} ${verdict}  ${passRate}   ${secs}s   ${cost}`);
    if (c.judge_total_cost_usd !== undefined) {
      const judgeRuns = c.runs.filter((r) => r.judge !== undefined);
      if (judgeRuns.length > 0) {
        const dims = Object.keys(judgeRuns[0].judge!.scores) as JudgeDim[];
        const avgScores = dims.map((dim) => {
          const sum = judgeRuns.reduce((s, r) => s + (r.judge!.scores[dim] ?? 0), 0);
          const avg = sum / judgeRuns.length;
          return `${dim}=${avg.toFixed(1)}`;
        }).join(" ");
        lines.push(`  ${DIM}judge:${RESET} ${avgScores} ${DIM}($${c.judge_total_cost_usd.toFixed(2)})${RESET}`);
      }
    }
    if (!c.passed) {
      const failingRunIdx = c.runs.filter((r) => !r.passed).map((r) => `#${r.run_index}`);
      const uniqueFailures = new Map<string, string>();
      for (const r of c.runs) {
        for (const f of r.failures) {
          const key = `${f.type}: ${f.expected}`;
          uniqueFailures.set(key, f.detail);
        }
      }
      for (const [key, detail] of uniqueFailures) {
        lines.push(`  ${DIM}· ${key}${RESET}  ${detail}`);
      }
      if (failingRunIdx.length > 0) {
        lines.push(`  ${DIM}failed runs:${RESET} ${failingRunIdx.join(", ")}`);
      }
    }
  }

  const passed = cases.filter((c) => c.passed).length;
  const failed = cases.length - passed;
  const totalRunsPassed = cases.reduce((acc, c) => acc + c.passing_runs, 0);
  const totalRuns = cases.reduce((acc, c) => acc + c.total_runs, 0);
  const totalSecs = (cases.reduce((acc, c) => acc + c.total_duration_ms, 0) / 1000).toFixed(1);
  const totalCost = cases.reduce((acc, c) => acc + c.total_cost_usd, 0);

  lines.push("");
  lines.push(`${BOLD}═══ Summary ═══${RESET}`);
  lines.push(`Cases:   ${passed} passed, ${failed} failed`);
  lines.push(`Runs:    ${totalRunsPassed} passed, ${totalRuns - totalRunsPassed} failed (${totalRuns} total)`);
  lines.push(`Time:    ${totalSecs}s`);
  lines.push(`Cost:    ${CYAN}$${totalCost.toFixed(2)}${RESET}`);
  lines.push("");
  return lines.join("\n");
}

export async function writeJsonReport(path: string, report: EvalReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}
