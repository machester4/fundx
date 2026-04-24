// CI helper. Reads JSON report(s), dedupes failures by (case_id, failure_type),
// and opens or comments on GitHub issues using the `gh` CLI via execFileSync
// (no shell — avoids command injection).
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { evalReportSchema } from "../src/types.js";
import { buildIssueSpecs, type IssueSpec } from "../src/services/eval/open-issue.js";

async function main(): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY;
  const runUrl = process.env.GITHUB_RUN_URL ?? "(unknown)";
  if (!repo) {
    console.error("GITHUB_REPOSITORY env var required");
    process.exit(2);
  }

  const reportPaths = process.argv.slice(2);
  if (reportPaths.length === 0) {
    console.error("Usage: eval-open-issue <report.json> [...]");
    process.exit(2);
  }

  for (const p of reportPaths) {
    const raw = await readFile(p, "utf8");
    const report = evalReportSchema.parse(JSON.parse(raw));
    const specs = buildIssueSpecs(report, runUrl);
    for (const spec of specs) syncIssue(spec, repo);
  }
}

function syncIssue(spec: IssueSpec, repo: string): void {
  const existing = findExistingIssue(spec.title, repo);
  if (existing !== null) {
    console.log(`[eval-open-issue] Commenting on #${existing}: ${spec.title}`);
    runGh(["issue", "comment", String(existing), "--body", spec.body, "--repo", repo]);
  } else {
    console.log(`[eval-open-issue] Opening: ${spec.title}`);
    const args = ["issue", "create", "--repo", repo, "--title", spec.title, "--body", spec.body];
    for (const l of spec.labels) { args.push("--label", l); }
    runGh(args);
  }
}

function findExistingIssue(title: string, repo: string): number | null {
  const out = runGh([
    "issue", "list", "--repo", repo,
    "--label", "eval-failure",
    "--state", "open",
    "--json", "number,title",
    "--limit", "100",
  ]);
  const rows = JSON.parse(out) as Array<{ number: number; title: string }>;
  const match = rows.find((r) => r.title === title);
  return match?.number ?? null;
}

function runGh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
