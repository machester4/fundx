# Prompt Eval Infrastructure — Design Spec

**Date:** 2026-04-23
**Status:** Draft → pending user review
**Scope:** v1 of a prompt-evaluation harness for the FundX chat surface. This is sub-project (1) of a larger four-part initiative to audit and calibrate the FundX prompt ecosystem.

## Motivation

On 2026-04-23 the user observed that a fund-context chat prompt — *"¿has detectado oportunidades para nuevas entradas?"* — was answered by Claude via `mcp__market-data__get_multi_snapshots` instead of the watchlist/screener path that the `opportunity-screening` skill specifies.

Post-mortem found three concurrent causes (see conversation transcript for detail):

1. `buildChatContext` (`src/services/chat.service.ts`) does not surface the watchlist, so the agent has no visual cue that a screener DB with candidates exists.
2. Skills loaded via `settingSources: ["project"]` are discretionary — Claude 4.6 does not guarantee skill invocation from the `When to Use` section alone.
3. The prompt *"has detectado oportunidades"* is semantically ambiguous between "show me market snapshots" and "run the screener".

The user requested a broader goal: **audit the prompt ecosystem and align it with Claude 4.6 prompting best practices**, so this class of silent-skill-skip bug stops happening. That goal decomposes into four sub-projects:

1. **Eval infrastructure** — a harness to measure whether a given change improves or regresses tool-use behavior *(this spec)*
2. Fix the visible symptom — inject watchlist into `buildChatContext`, add a behavioral rule *(follow-up spec)*
3. Audit `FUND_RULES` + 7 skills against Anthropic prompting guidance and `CLAUDE.md`'s own "Prompting Conventions" section *(follow-up spec)*
4. Extend the fix and audit to autonomous sessions and the `ask` command *(follow-up spec)*

Sub-projects (2)(3)(4) are blind without (1): any prompt change is a leap of faith if we cannot measure its effect on tool invocation. **This spec therefore delivers (1) only.**

## Non-goals for v1

- Evaluating autonomous sessions (Orient→Analyze→Decide→Validate cycles)
- Evaluating the `ask` command (cross-fund)
- Evaluating workspace chat (null-fund fund-creation flow)
- LLM-as-judge assertions
- Gateway (Telegram) behavior
- Side-by-side model comparison
- Regression detection across historical runs (nightly artifact retention covers ≤90 days; long-term trend analysis is follow-up)
- Direct detection of skill invocation — we infer skill usage from the tool-call pattern it produces

All of the above are candidate follow-up specs.

## Success criteria

1. The 5 "MVP" cases listed in the Canonical Cases section run end-to-end via `pnpm dev -- eval`.
2. The case `mvp-opportunity-spanish` fails with 0/3 passing runs against `main` as it stands today — i.e. the harness correctly reproduces the observed bug.
3. All unit tests of the harness itself pass with no tokens spent (loader, seeder, assertion evaluator, report).
4. A single-case dev loop (`pnpm dev -- eval --runs 1 --case <id>`) completes in under 30 seconds wall clock against Sonnet 4.6.
5. The `eval-nightly` GitHub Actions workflow exists, runs the MVP suite on its cron schedule, uploads a JSON artifact, and on failure opens (or updates) a deduped `eval-failure` issue.

When all five are true, follow-up specs (2), (3), (4) can land prompt changes with measurable confidence.

## Architectural decisions (locked during brainstorming)

| Decision | Choice | Reason |
|---|---|---|
| Scope | Chat REPL with a loaded fund only; extend to `ask` in v1.1; autonomous sessions get their own spec | Chat is where the observed bug lives; sessions are an order of magnitude more complex and merit separate treatment |
| Pass/fail criterion | K=3 runs per case, threshold ≥ 2 passing runs | Balances stochastic noise (K=1 is flaky) against cost (K=5+ is expensive); binary assertions dominate this problem class so `LLM-as-judge` is unnecessary |
| Test case format | YAML per case, Zod-validated on load | Cases are data, not logic; YAML minimizes contribution friction |
| Runner | Standalone script + Pastel CLI command (`fundx eval`) — not vitest | Controlled output, dedicated UX, keeps expensive LLM runs out of `pnpm test` |
| Fund state isolation | Ephemeral fund per case (`fundx-eval-<ulid>`) with `cleanup()` + per-case tempdir for the watchlist SQLite DB, selected via a new `FUNDX_WATCHLIST_DB_PATH` env override | Zero cross-run contamination; realistic state paths; safe parallel execution |
| Readonly | All eval runs pass `readonly: true` | Belt-and-braces against accidental state mutation even though the fund is ephemeral |
| Model | Sonnet 4.6 by default, overridable via `--model` | Matches what the user will actually run in chat |
| Cost ceiling | `maxBudgetUsd: 0.50` per run, suite warning at $10 cumulative | Prevents runaway loops from burning unbounded tokens |
| Concurrency primitive | Hand-rolled semaphore (5-line helper) — no new dep | `p-limit` is overkill for this case |
| CI cadence | Nightly at 02:00 UTC + manual `workflow_dispatch` | Daily catches regressions fast without per-PR token spend; manual trigger for pre-merge checks |
| CI model | Sonnet 4.6 | Haiku signal is too weak to represent what the user actually runs in chat |
| CI suite scope | MVP cases only (5), not the full 18 | Keeps nightly at ~$10/mo; full suite runs on-demand via `workflow_dispatch` or locally |
| CI failure signaling | Red workflow status + auto-opened GitHub issue | Red status is the default repo view; issue gives traceability and dedup for recurring failures |
| CI report retention | GitHub Actions artifacts (default 90-day TTL) | Covers incident investigation; avoids polluting git history with a dedicated branch |

## Architecture

### Modules

| File | Responsibility |
|---|---|
| `src/types.ts` *(extended)* | New Zod schemas: `evalFundStateSchema`, `evalAssertionsSchema`, `evalCaseSchema`, `evalRunCaptureSchema`, `evalCaseResultSchema`, `evalReportSchema` |
| `src/services/eval/loader.ts` | `loadEvalCases(glob): Promise<EvalCase[]>` — resolves fixtures, validates schema, detects duplicate IDs, applies `--filter` / `--case` |
| `src/services/eval/seed.ts` | `seedEvalFund(state): Promise<{ fundName, watchlistDbPath, cleanup }>` and the helpers it composes (config, portfolio, tracker, watchlist, claude.md, skills+rules) |
| `src/services/eval/runner.ts` | `runEvalCase(case, opts): Promise<EvalCaseResult>` — orchestrates seed → K runs of `runChatTurn` with instrumented callbacks → evaluation → cleanup |
| `src/services/eval/assertions.ts` | `evaluateRun(run, expect)` + `evaluateCase(runs, threshold)` — pure functions, fully unit-tested |
| `src/services/eval/report.ts` | Terminal-color report + `writeJsonReport(results, path)` |
| `src/commands/eval.tsx` | Pastel command with Ink progress UI + TTY/non-TTY fallback |
| `src/paths.ts` *(extended)* | `WATCHLIST_DB` respects `FUNDX_WATCHLIST_DB_PATH` env var override (default unchanged) |
| `tests/eval/cases/*.yaml` | Canonical case files (5 MVP + 13 backlog) |
| `tests/eval/fixtures/*.yaml` | Reusable `fund_state` bases referenced by `base:` in cases |
| `tests/unit/eval/*.test.ts` | Unit tests for loader, seeder, assertions, report — no model calls |
| `.github/workflows/eval-nightly.yml` | Nightly CI workflow (cron + `workflow_dispatch`), runs MVP suite, uploads JSON artifact, opens issue on failure |
| `scripts/eval-open-issue.ts` | Small helper called by the CI workflow to dedupe/open GitHub issues based on eval failures (uses `gh` CLI) |

### Dependencies

No new runtime dependencies. Reuses:
- `js-yaml` (already in deps) for YAML parsing
- `zod` for validation
- `better-sqlite3` for watchlist DB seeding
- `node:crypto.randomUUID()` for ephemeral fund names
- Existing `runChatTurn`, `buildChatMcpServers`, `buildChatContext` from `src/services/chat.service.ts`
- Existing `openWatchlistDb`, `queryWatchlist`, `insertScreenRun`, `insertScore`, `applyTransitionsForRun` from `src/services/watchlist.service.ts`
- Existing `ensureFundSkillFiles`, `ensureFundRules` from `src/skills.ts`
- Existing `generateFundClaudeMd` from `src/template.ts`

## Zod schemas (new, in `src/types.ts`)

```ts
export const evalFundStateSchema = z.object({
  base: z.string().optional(),
  fund_config: z.object({
    objective: z.enum(["runway", "growth", "accumulation", "income", "custom"]).optional(),
    risk_profile: z.enum(["conservative", "moderate", "aggressive"]).optional(),
    initial_capital: z.number().positive().optional(),
  }).default({}),
  portfolio: z.object({
    cash: z.number().nonnegative(),
    positions: z.array(z.object({
      symbol: z.string(),
      shares: z.number().positive(),
      avg_cost: z.number().positive(),
      current_price: z.number().positive(),
      entry_reason: z.string().default("seeded for eval"),
    })).default([]),
  }),
  tracker: z.object({
    progress_pct: z.number().default(0),
    status: z.enum(["on_track", "at_risk", "behind"]).default("on_track"),
  }).default({}),
  watchlist: z.array(z.object({
    ticker: z.string(),
    status: z.enum(["candidate", "watching", "fading", "rejected"]),
    peak_score: z.number().nullable().default(null),
    screens: z.array(z.string()).default(["momentum-12-1"]),
    first_surfaced_days_ago: z.number().int().nonnegative().default(7),
  })).default([]),
});

export const evalAssertionsSchema = z.object({
  must_invoke: z.array(z.string()).default([]),
  must_not_invoke: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().optional(),
  max_tokens_out: z.number().int().positive().optional(),
});

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string(),
  prompt: z.string().min(1),
  language: z.enum(["es", "en"]).default("es"),
  fund_state: evalFundStateSchema,
  expect: evalAssertionsSchema,
  runs: z.number().int().min(1).max(10).default(3),
  threshold: z.number().int().min(1).default(2),
}).refine(c => c.threshold <= c.runs, { message: "threshold must be ≤ runs" });

export const evalRunCaptureSchema = z.object({
  run_index: z.number().int().positive(),
  passed: z.boolean(),
  tool_history: z.array(z.object({
    name: z.string(),
    elapsed: z.number(),
  })),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  num_turns: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  final_response: z.string(),
  error: z.string().nullable(),
  failures: z.array(z.object({
    type: z.enum(["must_invoke", "must_not_invoke", "max_turns", "max_tokens_out", "run_errored"]),
    detail: z.string(),
    expected: z.string(),
    actual: z.string(),
  })),
});

export const evalCaseResultSchema = z.object({
  id: z.string(),
  description: z.string(),
  passed: z.boolean(),
  passing_runs: z.number().int().nonnegative(),
  total_runs: z.number().int().positive(),
  threshold: z.number().int().positive(),
  runs: z.array(evalRunCaptureSchema),
  total_duration_ms: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
});

export const evalReportSchema = z.object({
  schema_version: z.literal(1),
  timestamp: z.string(),
  model: z.string(),
  total_cost_usd: z.number().nonnegative(),
  total_duration_ms: z.number().int().nonnegative(),
  summary: z.object({
    cases_passed: z.number().int().nonnegative(),
    cases_failed: z.number().int().nonnegative(),
    runs_passed: z.number().int().nonnegative(),
    runs_failed: z.number().int().nonnegative(),
  }),
  cases: z.array(evalCaseResultSchema),
});
```

## Data flow (single eval run)

```
┌─ fundx eval ─────────────────────────────────────────────────────────┐
│                                                                       │
│ 1. Parse flags                                                        │
│ 2. loader.ts: glob → parse YAML → validate Zod → resolve fixtures     │
│    → apply --filter / --case → emit EvalCase[]                        │
│                                                                       │
│ 3. Plan summary: N cases, sum(K) total runs                           │
│                                                                       │
│ 4. Execute with concurrency=2 (default):                              │
│    for each case (p-limit):                                           │
│       a. seed.ts: seedEvalFund(case.fund_state)                       │
│          ├── mkdir ~/.fundx/funds/fundx-eval-<ulid>/                  │
│          ├── write fund_config.yaml, portfolio.json, tracker.json     │
│          ├── generate CLAUDE.md (template.ts)                         │
│          ├── ensureFundSkillFiles + ensureFundRules (skills.ts)       │
│          ├── mkdir tempdir/ + create watchlist.sqlite                 │
│          ├── seed watchlist rows via insertScreenRun + insertScore    │
│          │   + applyTransitionsForRun (real watchlist.service code)   │
│          └── set env.FUNDX_WATCHLIST_DB_PATH = tempdir/watchlist.sqlite│
│                                                                       │
│       b. runner.ts: for i in 1..case.runs:                            │
│          ├── build local RunCapture accumulator                       │
│          ├── await runChatTurn(fundName, undefined, case.prompt,      │
│          │     buildChatContext(fundName), {                          │
│          │       model, readonly: true, mcpServers,                   │
│          │       maxBudgetUsd: 0.50                                   │
│          │     }, { onToolStart, onToolEnd, onTokens,                 │
│          │         onTaskStart, onTaskEnd })                          │
│          │   wrapped in Promise.race with per-run timeout             │
│          └── push capture to case.runs[]                              │
│                                                                       │
│       c. assertions.ts: evaluateRun per run + evaluateCase aggregate  │
│                                                                       │
│       d. seed.ts: cleanup()                                           │
│          ├── close DB handles                                         │
│          ├── rm -rf fund dir                                          │
│          ├── rm -rf tempdir                                           │
│          └── restore or unset env.FUNDX_WATCHLIST_DB_PATH             │
│                                                                       │
│       e. emit EvalCaseResult (progress UI updates live)               │
│                                                                       │
│ 5. report.ts: renderTerminal(results) + writeJsonReport if --json     │
│ 6. exit(0 if all pass, 1 if any fail, 2 if setup error)               │
└───────────────────────────────────────────────────────────────────────┘
```

### Key invariants

- `seedEvalFund` **must** validate that the generated `fundName` starts with `fundx-eval-` before writing anything to `~/.fundx/funds/`. This prevents any bug in the harness from corrupting a real user fund.
- `cleanup()` is registered with `process.on('exit')` as a safety net so an uncaught error in the runner still releases the fund dir, tempdir, and env var.
- The `screener` MCP server receives `env: { ...process.env }` in `buildMcpServers` — so setting `FUNDX_WATCHLIST_DB_PATH` in the parent before spawn is sufficient; no MCP code changes required beyond `paths.ts` respecting the env var.
- Assertion evaluation is pure. `evaluateRun(capture, expect)` and `evaluateCase(runs, threshold)` have no side effects, no filesystem, no network. They are the only part of the harness with 100% deterministic tests.
- Sub-agent invocations enter via the SDK's built-in `Task` tool, which surfaces as a normal `content_block.type === "tool_use"` with `name === "Task"` and therefore appears in `tool_history`. Tools invoked *inside* the sub-agent do **not** surface in the parent's `tool_history` (they arrive as separate `SDKTaskProgressMessage` events). Assertions can therefore assert on `Task` being invoked but cannot assert on the sub-agent's internal tool use in v1.

## CLI surface

```
Usage: fundx eval [options]

Options:
  --case <id>           Run a single case by id
  --filter <pattern>    Substring match on case id
  --json <path>         Write full JSON report to path
  --concurrency <N>     Parallel cases (default: 2)
  --runs <K>            Override per-case K (default: YAML value)
  --model <name>        Model for runs (default: claude-sonnet-4-6)
  --bail                Stop at first failing case
  --timeout <seconds>   Per-run wallclock timeout (default: 120)
```

Typical invocations:

```bash
pnpm dev -- eval                                   # full suite (MVP + backlog)
pnpm dev -- eval --filter mvp-                     # MVP suite only (what CI runs)
pnpm dev -- eval --case mvp-opportunity-spanish    # one case
pnpm dev -- eval --filter opportunity              # matching pattern
pnpm dev -- eval --runs 1 --bail                   # tight dev loop
pnpm dev -- eval --json reports/2026-04-23.json
```

### Progress UI (TTY)

```
Loading 18 cases from tests/eval/cases/...
Running with model=claude-sonnet-4-6, concurrency=2, K=3

  ⠋ mvp-opportunity-spanish      run 2/3   12s    3 tools so far
  ⠙ portfolio-review-english     run 1/3    6s    1 tool so far
  ✓ risk-limit-hard              PASS 3/3  11s    $0.05

(14 pending, 2 running, 2 done)
```

In non-TTY environments (CI, piped output) the progress UI degrades to structured log lines — one per event, no spinners:

```
[eval] start case=mvp-opportunity-spanish run=1
[eval] end   case=mvp-opportunity-spanish run=1 passed=true duration_ms=11234 tools=2
[eval] done  case=mvp-opportunity-spanish result=PASS runs=3/3 cost=$0.08
```

### Terminal report

```
═══ Results ═══

✓ mvp-opportunity-spanish        PASS  3/3   12.4s   $0.08
✗ mvp-opportunity-english        FAIL  1/3   11.1s   $0.07
    must_invoke mcp__screener__watchlist_query: 1/3 runs
    failed runs: #2, #3
    last tool in run #2: mcp__market-data__get_multi_snapshots
    last tool in run #3: (no tool calls)
...

═══ Summary ═══
Cases:   16 passed, 2 failed, 0 errored
Runs:    48 passed, 6 failed, 0 errored (54 total)
Time:    4m 22s
Cost:    $1.18
Model:   claude-sonnet-4-6

Exit: 1 (failures present)
```

## Test case format

### Fixture file (`tests/eval/fixtures/runway-with-candidates.yaml`)

```yaml
id: runway-with-candidates
fund_config:
  objective: runway
  risk_profile: moderate
  initial_capital: 10000
portfolio:
  cash: 10000
  positions: []
tracker:
  progress_pct: 0
  status: on_track
watchlist:
  - { ticker: NVDA, status: candidate, peak_score: 0.87, first_surfaced_days_ago: 14 }
  - { ticker: AMD,  status: watching,  peak_score: 0.72, first_surfaced_days_ago: 7  }
  - { ticker: AVGO, status: candidate, peak_score: 0.65, first_surfaced_days_ago: 3  }
```

### Case file (`tests/eval/cases/mvp-opportunity-spanish.yaml`)

```yaml
id: mvp-opportunity-spanish
description: Usuario pregunta por oportunidades en español; esperamos consulta al screener
prompt: "¿has detectado oportunidades para nuevas entradas?"
language: es
fund_state:
  base: runway-with-candidates
expect:
  must_invoke: [mcp__screener__watchlist_query]
  must_not_invoke: []
  max_turns: 10
  max_tokens_out: 5000
runs: 3
threshold: 2
```

**MVP prefix convention:** MVP-tier cases prefix their IDs (and YAML filenames) with `mvp-`. The nightly CI workflow filters on this prefix. Backlog cases use bare IDs and are excluded from the nightly by default; they run in `full` suite mode via `workflow_dispatch` or locally.

### Canonical cases (v1)

**MVP (implement first, exit criterion #1):**

| ID | Prompt | Key assertion |
|---|---|---|
| `mvp-opportunity-spanish` | "¿has detectado oportunidades para nuevas entradas?" | `must_invoke: [mcp__screener__watchlist_query]` |
| `mvp-opportunity-english` | "any opportunities for new entries you've detected?" | same |
| `mvp-opportunity-explicit-screener` | "corré el screener" | `must_invoke: [mcp__screener__screen_run]` |
| `mvp-portfolio-review-spanish` | "revisá el portfolio" | `must_invoke: [mcp__broker-local__get_positions]` |
| `mvp-market-regime-spanish` | "qué pasa hoy en mercado" | `must_invoke: [mcp__market-data__*]` |

**Backlog (complete the suite after MVP proves the harness):**

| ID | Prompt | Key assertion |
|---|---|---|
| `portfolio-review-english` | "review the portfolio" | `must_invoke: broker-local` |
| `opportunity-full-portfolio` | oportunidades w/ max_positions reached | `must_not_invoke: screen_run` (skill should defer) |
| `risk-check-spanish` | "estamos en riesgo de drawdown?" | `must_invoke: risk-related` |
| `empty-watchlist-spanish` | oportunidades w/ empty watchlist | graceful response, no phantom tickers |
| `news-query-spanish` | "qué noticias hay importantes" | `must_invoke: news tools` *(when available)* |
| `trade-journal-recall` | "hemos comprado NVDA antes?" | `must_invoke: journal search` |
| `sub-agent-invocation` | "evaluá NVDA como trade" | `must_invoke: [Task]` |
| `budget-runaway-guard` | short ambiguous prompt | `max_turns: 5, max_tokens_out: 2000` |
| `no-hallucinated-prices` | "a cuánto cotiza AAPL" | `must_invoke: market-data` |
| `explicit-command-override` | "no consultes el screener, solo decime cash" | `must_not_invoke: screener` |
| `cross-language-mix` | ES user asking for EN summary | response respects request |
| `readonly-respects` | "vendé NVDA" in readonly | `must_not_invoke: broker mutations` |
| `session-init-skip` | turn with existing `sessionId` | should not re-run Orient |

## Testing the harness itself

All harness-internal tests live in `tests/unit/eval/` and run in `pnpm test` without any model calls.

| Test file | What it verifies |
|---|---|
| `loader.test.ts` | Parses valid YAML; rejects invalid schema; detects duplicate IDs; merges `base:` fixtures correctly; filters by `--case` / `--filter` |
| `seed.test.ts` | `seedEvalFund` writes the expected files; `cleanup()` removes fund dir + tempdir + restores env; `seedEvalFund({ fundName: "my-real-fund" })` throws; watchlist rows readable back via `queryWatchlist` |
| `assertions.test.ts` | `evaluateRun` with synthetic captures (must_invoke hit, must_invoke miss, must_not_invoke triggered, max_turns exceeded, run errored); `evaluateCase` aggregation with K=3 and thresholds 1/2/3 |
| `report.test.ts` | Snapshot test of JSON output given a fixed input; verifies `evalReportSchema` passes on emitted output |

The runner itself (`runner.test.ts`) is **not** unit-tested against a real model — that's what the YAML suite does. A runner unit test would use a fake `runChatTurn` stub that emits scripted `onToolEnd` events, verifying the accumulator logic and timeout handling.

## Costs and performance

Sonnet 4.6 list pricing as of 2026-04:

| Scenario | Tokens (est.) | Cost |
|---|---|---|
| Single run (3k in + 1.5k out) | ~4.5k | ~$0.02 |
| Single case (K=3) | ~13.5k | ~$0.06 |
| MVP suite (5 cases × K=3) | ~70k | ~$0.30 |
| Full suite (18 cases × K=3) | ~240k | ~$1.10 |
| Nightly CI (MVP only) × 30 days | ~$0.30/night × 30 | ~$9/mo |
| Full suite on-demand via `workflow_dispatch` | | ~$1.10/run |
| Dev iteration (`--runs 1 --case X`) | ~4.5k | ~$0.02 |

Guardrails:

- `maxBudgetUsd: 0.50` passed to `runChatTurn` per run — the SDK aborts the stream if exceeded
- `maxTurns: 15` per run in the runner (chat default is 30; eval prompts don't justify more)
- Cumulative cost warning: if `sum(costUsd)` crosses $10 during a suite execution the runner prints a warning and prompts for confirmation unless `--no-confirm` is passed
- Per-run wallclock timeout: default 120s, configurable via `--timeout`

Cases that would otherwise call FMP via `resolveFundUniverse` avoid it by using fixtures with tiny explicit tickers (5-10 ticker `universe.tickers` lists). Cases that don't need screener activity leave `watchlist: []`.

## CI automation

### Workflow: `.github/workflows/eval-nightly.yml`

```yaml
name: eval-nightly

on:
  schedule:
    - cron: "0 2 * * *"     # 02:00 UTC daily
  workflow_dispatch:
    inputs:
      suite:
        description: "Which suite to run"
        type: choice
        options: [mvp, full]
        default: mvp
      model:
        description: "Model to use"
        type: string
        default: claude-sonnet-4-6

concurrency:
  group: eval-nightly
  cancel-in-progress: false   # never cancel a paid run mid-flight

jobs:
  eval:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      issues: write            # required to open issues on failure
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Run eval suite
        id: eval
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          FMP_API_KEY:       ${{ secrets.FMP_API_KEY }}
        run: |
          suite="${{ github.event.inputs.suite || 'mvp' }}"
          model="${{ github.event.inputs.model || 'claude-sonnet-4-6' }}"
          mkdir -p reports
          if [ "$suite" = "full" ]; then
            filter_arg=""
          else
            filter_arg="--filter mvp-"
          fi
          node dist/index.js eval \
            --json reports/eval-$(date -u +%Y%m%d).json \
            --model "$model" \
            $filter_arg
      - name: Upload JSON report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-report-${{ github.run_id }}
          path: reports/*.json
          retention-days: 90
      - name: Open issue on failure
        if: failure()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: node dist/scripts/eval-open-issue.js reports/*.json
```

### Issue dedup strategy (`scripts/eval-open-issue.ts`)

Reads the JSON report, groups failures by `(case_id, failure_type)`, and for each unique group:

1. Queries existing open issues with label `eval-failure` + title pattern `[eval] <case_id> — <failure_type>`.
2. If an issue exists: posts a comment with the new failure details + run URL, updates the title with latest failure count if needed.
3. If no issue exists: opens a new one with label `eval-failure`, title `[eval] <case_id> — <failure_type>`, body containing the run URL, failing prompt, expected vs actual tools, and the 3 run traces.

Dedup via title-match keeps the issue tracker quiet when the same case flakes repeatedly. One issue per distinct bug pattern, not one issue per run.

### Case ID naming convention for CI filtering

MVP cases prefix their IDs with `mvp-` (e.g. `mvp-opportunity-spanish`) so the nightly workflow can filter via `--filter mvp-` without needing a separate allowlist. Backlog cases use their bare IDs. This keeps the filter stateless — add a new MVP case by prefixing its YAML file, and CI picks it up automatically.

### Required repository secrets

| Secret | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Model inference for eval runs |
| `FMP_API_KEY` | FMP market data (required even for fixtures if `resolveFundUniverse` runs; most MVP cases avoid it via explicit ticker lists) |

`GITHUB_TOKEN` is provided automatically by Actions for issue creation — no manual setup.

### Manual trigger

From the GitHub UI → Actions → `eval-nightly` → "Run workflow". Inputs:
- `suite: mvp | full` (default `mvp`)
- `model: <model-id>` (default `claude-sonnet-4-6`)

Useful before merging a PR that touches any of: `src/skills.ts`, `src/services/chat.service.ts`, `src/template.ts`, `src/subagent.ts`, or any `SKILL.md` / rule file. A small CONTRIBUTING section in the spec's follow-up will add a reminder in PR templates.

## Follow-up specs (documented here, not in scope of v1)

These are the remaining sub-projects of the overall initiative. Each gets its own `YYYY-MM-DD-<topic>-design.md`:

1. **Chat opportunity-surfacing fix** — inject `buildChatContext` with a compact `### Watchlist (top N candidates)` section read via `queryWatchlist`; add a `FUND_RULES` entry titled `opportunity-surfacing.md` instructing the agent to query the screener before answering opportunity-flavored questions. Validated by `mvp-opportunity-spanish` and `mvp-opportunity-english` flipping from FAIL to PASS.
2. **Prompt ecosystem audit** — re-read all 10 `FUND_RULES` and 7 `BUILTIN_SKILLS` against `CLAUDE.md`'s Prompting Conventions and Anthropic's Claude 4.6 guidance. Consolidate overlap, remove over-prompting (MUST/ALWAYS/NEVER outside genuine hard constraints), tighten skill descriptions for better trigger selection. Validated by the eval suite not regressing and new targeted cases for each skill.
3. **Extension to `ask` and autonomous sessions** — v1.1 of the eval harness covers `ask` (small refactor). Autonomous sessions get their own spec because simulating a full Orient→Analyze→Decide cycle is materially different: Task tool tracking, sub-agent capture, state-file assertions.

## Open questions

None at the time of writing — all design decisions were resolved during the brainstorm on 2026-04-23.

## Out-of-scope reminder

The v1 harness **only** evaluates chat REPL turns against a freshly-seeded fund. It does not:

- Evaluate autonomous session cycles (separate spec)
- Evaluate `ask` (v1.1 extension)
- Evaluate workspace chat / fund creation
- Use an LLM-as-judge for any assertion
- Exercise the Telegram gateway
- Detect skill invocation directly (inferred from tool-use patterns only)
- Compare models side-by-side
- Detect regressions against historical runs beyond the 90-day artifact window

When the Success Criteria are met (including the CI workflow running a green nightly on `main`), this spec is done and follow-up specs can proceed.
