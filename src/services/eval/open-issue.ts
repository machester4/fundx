import type { EvalReport, EvalCaseResult, EvalFailure } from "../../types.js";

export interface IssueSpec {
  title: string;
  body: string;
  labels: string[];
}

export function buildIssueSpecs(report: EvalReport, runUrl: string): IssueSpec[] {
  const specs: IssueSpec[] = [];
  for (const c of report.cases) {
    if (c.passed) continue;
    const byType = groupFailures(c);
    for (const [type, details] of byType) {
      specs.push({
        title: `[eval] ${c.id} — ${type}`,
        body: renderBody(c, type, details, runUrl, report),
        labels: ["eval-failure"],
      });
    }
  }
  return specs;
}

function groupFailures(c: EvalCaseResult): Map<EvalFailure["type"], EvalFailure[]> {
  const map = new Map<EvalFailure["type"], EvalFailure[]>();
  for (const r of c.runs) {
    for (const f of r.failures) {
      const list = map.get(f.type) ?? [];
      list.push(f);
      map.set(f.type, list);
    }
  }
  return map;
}

function renderBody(
  c: EvalCaseResult,
  type: string,
  failures: EvalFailure[],
  runUrl: string,
  report: EvalReport,
): string {
  const lines: string[] = [];
  lines.push(`**Case:** \`${c.id}\``);
  lines.push(`**Description:** ${c.description}`);
  lines.push(`**Pass rate:** ${c.passing_runs}/${c.total_runs} (threshold ${c.threshold})`);
  lines.push(`**Model:** ${report.model}`);
  lines.push(`**Timestamp:** ${report.timestamp}`);
  lines.push(`**Run:** ${runUrl}`);
  lines.push("");
  lines.push(`## Failures (${type})`);
  for (const f of failures) {
    lines.push(`- Expected: \`${f.expected}\` — Actual: \`${f.actual}\``);
    if (f.detail) lines.push(`  - ${f.detail}`);
  }
  lines.push("");
  lines.push("## Run traces");
  for (const r of c.runs) {
    lines.push(`### Run #${r.run_index} — ${r.passed ? "PASS" : "FAIL"}`);
    lines.push(`- tools: ${r.tool_history.map((t) => t.name).join(", ") || "(none)"}`);
    lines.push(`- turns: ${r.num_turns}, tokens: ${r.tokens_in}→${r.tokens_out}, cost: $${r.cost_usd.toFixed(3)}`);
    if (r.error) lines.push(`- error: ${r.error}`);
  }
  return lines.join("\n");
}
