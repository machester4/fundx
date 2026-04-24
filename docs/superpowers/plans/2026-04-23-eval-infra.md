# Prompt Eval Infrastructure v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a prompt-evaluation harness (`fundx eval`) that runs canonical YAML cases against the chat REPL with K=3 runs per case, asserts on tool invocation, and ships with a nightly GitHub Actions workflow that runs the MVP suite and opens dedup'd issues on failure.

**Architecture:** New `src/services/eval/` module with four pure units (loader, seeder, assertions, report) plus an orchestrating runner. A new Pastel command `src/commands/eval.tsx` renders Ink progress UI. Ephemeral funds (`fundx-eval-<ulid>`) with per-case SQLite watchlist DB via a new `FUNDX_WATCHLIST_DB_PATH` env override on `src/paths.ts`. Nightly CI via `.github/workflows/eval-nightly.yml` + a small issue-dedup script `scripts/eval-open-issue.ts`.

**Tech Stack:** TypeScript, Zod, Vitest, Ink/Pastel, `js-yaml`, `better-sqlite3`, Claude Agent SDK (existing), `gh` CLI (in CI only). No new runtime dependencies.

**Prior context:**
- Design spec: `docs/superpowers/specs/2026-04-23-eval-infra-design.md` (commit `5462290`)
- Motivating bug: 2026-04-23 chat turn where `¿has detectado oportunidades para nuevas entradas?` was answered via `mcp__market-data__get_multi_snapshots` instead of the screener/watchlist path
- Existing modules reused: `runChatTurn`, `buildChatContext`, `buildChatMcpServers` (from `src/services/chat.service.ts`); `openWatchlistDb`, `queryWatchlist`, `insertScreenRun`, `insertScore`, `applyTransitionsForRun` (from `src/services/watchlist.service.ts`); `ensureFundSkillFiles`, `ensureFundRules` (from `src/skills.ts`); `generateFundClaudeMd` (from `src/template.ts`)

---

## File Structure

**New files to create:**

| Path | Responsibility |
|---|---|
| `src/services/eval/loader.ts` | Load + validate case YAMLs; resolve `base:` fixtures; filter by id/pattern |
| `src/services/eval/seed.ts` | `seedEvalFund` composite + private helpers; `cleanupEvalFund` |
| `src/services/eval/assertions.ts` | Pure `evaluateRun` + `evaluateCase` |
| `src/services/eval/report.ts` | Terminal-color report + JSON writer |
| `src/services/eval/runner.ts` | Orchestration: seed → K runs → evaluate → cleanup; dep-injectable |
| `src/services/eval/open-issue.ts` | Pure `buildIssueSpecs` from an `EvalReport` |
| `src/services/eval/index.ts` | Barrel re-export for the command to import one thing |
| `src/commands/eval.tsx` | Pastel command + Ink progress UI |
| `scripts/eval-open-issue.ts` | CI helper: parse JSON report, open/update GH issues via `execFileSync("gh", ...)` |
| `tests/eval/cases/mvp-*.yaml` | 5 MVP canonical cases |
| `tests/eval/cases/*.yaml` | 13 backlog cases (non-MVP) |
| `tests/eval/fixtures/*.yaml` | 4 reusable `fund_state` bases |
| `tests/unit/eval/loader.test.ts` | Unit tests for the loader |
| `tests/unit/eval/seed.test.ts` | Unit tests for seed + cleanup |
| `tests/unit/eval/assertions.test.ts` | Unit tests for evaluator |
| `tests/unit/eval/report.test.ts` | Snapshot test for JSON schema + terminal render |
| `tests/unit/eval/runner.test.ts` | Runner orchestration with stubbed `runChatTurn` |
| `tests/unit/eval/open-issue.test.ts` | Issue-dedup builder logic |
| `tests/unit/eval/fixtures.test.ts` | Quick parse-check of all fixture YAMLs |
| `.github/workflows/eval-nightly.yml` | Cron + dispatch workflow |

**Existing files to modify:**

| Path | Change |
|---|---|
| `src/paths.ts` | Add `FUNDX_WATCHLIST_DB_PATH` env override for `WATCHLIST_DB` |
| `src/types.ts` | Add 7 Zod schemas + inferred TS types: `evalFundStateSchema`, `evalAssertionsSchema`, `evalCaseSchema`, `evalFailureSchema`, `evalRunCaptureSchema`, `evalCaseResultSchema`, `evalReportSchema` |
| `src/services/watchlist.service.ts` | `openWatchlistDb` default path uses `resolveWatchlistDbPath()` |
| `src/services/chat.service.ts` | `runChatTurn` returns `toolHistory`, `tokensIn`, `tokensOut` on `ChatTurnResult` |
| `tsup.config.ts` | Include `scripts/eval-open-issue.ts` in the build entry list |
| `.gitignore` | Add `reports/` (with `!reports/*-baseline.json` exception) |
| `CLAUDE.md` | Short doc under "Testing Conventions" pointing at the harness |

Task numbering and dependencies:

```
Task 1: paths.ts env override       [foundation for 5, 8]
Task 2: Zod schemas                  [foundation for 3, 4, 5, 6, 7, 8, 13]
Task 3: Fixtures (4 YAMLs)           [needs 2; enables 4, 5, 10]
Task 4: loader.ts                    [needs 2, 3]
Task 5: seed.ts                      [needs 1, 2, 3]
Task 6: assertions.ts                [needs 2]
Task 7: report.ts                    [needs 2]
Task 8: runner.ts + chat.service API [needs 2, 4, 5, 6]
Task 9: commands/eval.tsx            [needs 4, 7, 8]
Task 10: 5 MVP case YAMLs            [needs 2, 3]
Task 11: Local smoke test            [needs 9, 10; validates success criteria 1-4]
Task 12: 13 backlog case YAMLs       [needs 10]
Task 13: CI workflow + issue helper  [needs 11; validates success criterion 5]
Task 14: Final docs + .gitignore     [last]
```

Use **frequent commits**: every task ends with a commit. Larger tasks (5, 8, 9, 13) may commit at logical checkpoints inside.

---

## Task 1: `src/paths.ts` — add `FUNDX_WATCHLIST_DB_PATH` override

**Why:** The eval harness needs to run multiple cases in parallel without having them write to the same watchlist SQLite DB. An env-var override keeps the production default intact and the MCP screener (which already receives `env: { ...process.env }`) picks it up automatically when spawned.

**Files:**
- Modify: `src/paths.ts`
- Modify: `src/services/watchlist.service.ts`
- Test: `tests/unit/paths.test.ts` (create if missing; else extend)

- [ ] **Step 1.1: Write the failing test**

Create or extend `tests/unit/paths.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { resolveWatchlistDbPath } from "../../src/paths.js";

describe("resolveWatchlistDbPath", () => {
  const original = process.env.FUNDX_WATCHLIST_DB_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.FUNDX_WATCHLIST_DB_PATH;
    else process.env.FUNDX_WATCHLIST_DB_PATH = original;
  });

  it("returns the default path when the override is unset", () => {
    delete process.env.FUNDX_WATCHLIST_DB_PATH;
    const p = resolveWatchlistDbPath();
    expect(p).toMatch(/\.fundx\/state\/watchlist\.sqlite$/);
  });

  it("returns the override path when FUNDX_WATCHLIST_DB_PATH is set", () => {
    process.env.FUNDX_WATCHLIST_DB_PATH = "/tmp/eval-xyz/watchlist.sqlite";
    expect(resolveWatchlistDbPath()).toBe("/tmp/eval-xyz/watchlist.sqlite");
  });

  it("ignores empty string override", () => {
    process.env.FUNDX_WATCHLIST_DB_PATH = "";
    const p = resolveWatchlistDbPath();
    expect(p).toMatch(/\.fundx\/state\/watchlist\.sqlite$/);
  });
});
```

- [ ] **Step 1.2: Run the test — expect FAIL**

```bash
pnpm vitest run tests/unit/paths.test.ts
```

Expected: FAIL with "resolveWatchlistDbPath is not a function" or similar.

- [ ] **Step 1.3: Implement the override in `src/paths.ts`**

Open `src/paths.ts` and find the existing `WATCHLIST_DB` export. Typical existing shape:

```ts
// before
export const WATCHLIST_DB = join(WORKSPACE, "state", "watchlist.sqlite");
```

Change to:

```ts
const DEFAULT_WATCHLIST_DB = join(WORKSPACE, "state", "watchlist.sqlite");

/** Returns the watchlist SQLite path.
 *
 * Honors `FUNDX_WATCHLIST_DB_PATH` (non-empty) for the eval harness so parallel
 * evaluation runs can use isolated databases. Production uses the default.
 */
export function resolveWatchlistDbPath(): string {
  const override = process.env.FUNDX_WATCHLIST_DB_PATH;
  if (override && override.length > 0) return override;
  return DEFAULT_WATCHLIST_DB;
}

// Backwards-compatible lazy export. Existing callers using `WATCHLIST_DB` as a
// const continue to work; new callers should prefer the function for test isolation.
export const WATCHLIST_DB = resolveWatchlistDbPath();
```

**Important caveat:** the `WATCHLIST_DB` const is evaluated at module load time. If any test or CLI flow sets `process.env.FUNDX_WATCHLIST_DB_PATH` *after* the module loads, `WATCHLIST_DB` will still hold the original value. Audit call sites and prefer `resolveWatchlistDbPath()` in code paths that may run under the eval harness.

- [ ] **Step 1.4: Update the one call site that needs runtime resolution**

```bash
grep -n "WATCHLIST_DB" src/ --include="*.ts" -r
```

Convert **only** the `openWatchlistDb` default argument in `src/services/watchlist.service.ts:72`:

```ts
// src/services/watchlist.service.ts
import { resolveWatchlistDbPath } from "../paths.js";

export function openWatchlistDb(path: string = resolveWatchlistDbPath()): Database.Database {
  // existing body unchanged
}
```

Leave all other `WATCHLIST_DB` references as-is — they're in MCP server entry points that load after env is set.

- [ ] **Step 1.5: Run the tests — expect PASS**

```bash
pnpm vitest run tests/unit/paths.test.ts
```

Expected: all three tests PASS.

- [ ] **Step 1.6: Run the full test suite to check no regressions**

```bash
pnpm test
```

Expected: all existing tests continue to pass.

- [ ] **Step 1.7: Typecheck**

```bash
pnpm typecheck
```

Expected: no type errors.

- [ ] **Step 1.8: Commit**

```bash
git add src/paths.ts src/services/watchlist.service.ts tests/unit/paths.test.ts
git commit -m "feat(paths): FUNDX_WATCHLIST_DB_PATH override for eval isolation"
```

---

## Task 2: `src/types.ts` — add 7 eval Zod schemas

**Why:** All harness modules (loader, seeder, assertions, report, runner, issue-helper) share these schemas. Centralizing in `types.ts` matches the project convention ("All Zod schemas and types live in `types.ts` — single import for any module" from CLAUDE.md) and makes the whole eval pipeline type-safe at every boundary.

**Files:**
- Modify: `src/types.ts`
- Test: `tests/unit/eval/types.test.ts` (create)

- [ ] **Step 2.1: Write the failing test**

Create `tests/unit/eval/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  evalFundStateSchema,
  evalAssertionsSchema,
  evalCaseSchema,
  evalRunCaptureSchema,
  evalCaseResultSchema,
  evalReportSchema,
  evalFailureSchema,
} from "../../../src/types.js";

describe("evalFundStateSchema", () => {
  it("accepts a minimal state (portfolio only)", () => {
    const parsed = evalFundStateSchema.parse({ portfolio: { cash: 10000 } });
    expect(parsed.portfolio.cash).toBe(10000);
    expect(parsed.portfolio.positions).toEqual([]);
    expect(parsed.watchlist).toEqual([]);
  });

  it("accepts full state with fixture base", () => {
    const parsed = evalFundStateSchema.parse({
      base: "runway-with-candidates",
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: {
        cash: 5000,
        positions: [{ symbol: "NVDA", shares: 10, avg_cost: 400, current_price: 450, entry_reason: "thesis" }],
      },
      tracker: { progress_pct: 25, status: "on_track" },
      watchlist: [{ ticker: "AMD", status: "candidate", peak_score: 0.8, screens: ["momentum-12-1"], first_surfaced_days_ago: 7 }],
    });
    expect(parsed.base).toBe("runway-with-candidates");
    expect(parsed.portfolio.positions).toHaveLength(1);
    expect(parsed.watchlist).toHaveLength(1);
  });

  it("rejects negative cash", () => {
    expect(() => evalFundStateSchema.parse({ portfolio: { cash: -5 } })).toThrow();
  });
});

describe("evalAssertionsSchema", () => {
  it("defaults empty assertion arrays", () => {
    const parsed = evalAssertionsSchema.parse({});
    expect(parsed.must_invoke).toEqual([]);
    expect(parsed.must_not_invoke).toEqual([]);
    expect(parsed.max_turns).toBeUndefined();
  });

  it("parses full assertion block", () => {
    const parsed = evalAssertionsSchema.parse({
      must_invoke: ["mcp__screener__watchlist_query"],
      must_not_invoke: ["mcp__broker-local__place_order"],
      max_turns: 10,
      max_tokens_out: 5000,
    });
    expect(parsed.must_invoke).toEqual(["mcp__screener__watchlist_query"]);
    expect(parsed.max_turns).toBe(10);
  });
});

describe("evalCaseSchema", () => {
  const base = {
    description: "x",
    prompt: "y",
    fund_state: { portfolio: { cash: 0 } },
    expect: {},
  };

  it("rejects uppercase and special chars in id", () => {
    expect(() => evalCaseSchema.parse({ ...base, id: "Foo Bar" })).toThrow();
    expect(() => evalCaseSchema.parse({ ...base, id: "foo_bar" })).toThrow();
    expect(() => evalCaseSchema.parse({ ...base, id: "mvp-foo-bar" })).not.toThrow();
  });

  it("rejects threshold greater than runs", () => {
    expect(() =>
      evalCaseSchema.parse({ ...base, id: "x", runs: 3, threshold: 5 }),
    ).toThrow(/threshold must be/);
  });

  it("applies default runs=3 threshold=2 language=es", () => {
    const parsed = evalCaseSchema.parse({ ...base, id: "x" });
    expect(parsed.runs).toBe(3);
    expect(parsed.threshold).toBe(2);
    expect(parsed.language).toBe("es");
  });
});

describe("evalFailureSchema", () => {
  it("accepts each failure type", () => {
    for (const type of ["must_invoke", "must_not_invoke", "max_turns", "max_tokens_out", "run_errored"] as const) {
      expect(() =>
        evalFailureSchema.parse({ type, detail: "d", expected: "e", actual: "a" }),
      ).not.toThrow();
    }
  });
});

describe("evalRunCaptureSchema", () => {
  it("parses a captured run with tool history", () => {
    const parsed = evalRunCaptureSchema.parse({
      run_index: 1,
      passed: true,
      tool_history: [{ name: "mcp__screener__watchlist_query", elapsed: 1.2 }],
      tokens_in: 1000, tokens_out: 500, num_turns: 2,
      duration_ms: 5000, cost_usd: 0.02,
      final_response: "ok",
      error: null,
      failures: [],
    });
    expect(parsed.passed).toBe(true);
    expect(parsed.tool_history[0].name).toBe("mcp__screener__watchlist_query");
  });
});

describe("evalReportSchema", () => {
  it("requires schema_version=1", () => {
    expect(() =>
      evalReportSchema.parse({
        schema_version: 2, timestamp: "t", model: "m",
        total_cost_usd: 0, total_duration_ms: 0,
        summary: { cases_passed: 0, cases_failed: 0, runs_passed: 0, runs_failed: 0 },
        cases: [],
      }),
    ).toThrow();
  });
});

describe("evalCaseResultSchema", () => {
  it("validates a pass case with 3 runs", () => {
    const parsed = evalCaseResultSchema.parse({
      id: "x", description: "x", passed: true,
      passing_runs: 3, total_runs: 3, threshold: 2,
      runs: [],
      total_duration_ms: 10000, total_cost_usd: 0.06,
    });
    expect(parsed.passed).toBe(true);
  });
});
```

- [ ] **Step 2.2: Run the test — expect FAIL**

```bash
pnpm vitest run tests/unit/eval/types.test.ts
```

Expected: FAIL with missing schema exports.

- [ ] **Step 2.3: Add the schemas to `src/types.ts`**

Append (or insert near the bottom with the other domain schemas) in `src/types.ts`:

```ts
// ── Eval harness schemas ──────────────────────────────────────────

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
export type EvalFundState = z.infer<typeof evalFundStateSchema>;

export const evalAssertionsSchema = z.object({
  must_invoke: z.array(z.string()).default([]),
  must_not_invoke: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().optional(),
  max_tokens_out: z.number().int().positive().optional(),
});
export type EvalAssertions = z.infer<typeof evalAssertionsSchema>;

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase kebab-case"),
  description: z.string(),
  prompt: z.string().min(1),
  language: z.enum(["es", "en"]).default("es"),
  fund_state: evalFundStateSchema,
  expect: evalAssertionsSchema,
  runs: z.number().int().min(1).max(10).default(3),
  threshold: z.number().int().min(1).default(2),
}).refine((c) => c.threshold <= c.runs, { message: "threshold must be ≤ runs" });
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalFailureSchema = z.object({
  type: z.enum(["must_invoke", "must_not_invoke", "max_turns", "max_tokens_out", "run_errored"]),
  detail: z.string(),
  expected: z.string(),
  actual: z.string(),
});
export type EvalFailure = z.infer<typeof evalFailureSchema>;

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
  failures: z.array(evalFailureSchema),
});
export type EvalRunCapture = z.infer<typeof evalRunCaptureSchema>;

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
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;

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
export type EvalReport = z.infer<typeof evalReportSchema>;
```

- [ ] **Step 2.4: Run the tests — expect PASS**

```bash
pnpm vitest run tests/unit/eval/types.test.ts
```

Expected: all 10+ tests PASS.

- [ ] **Step 2.5: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 2.6: Commit**

```bash
git add src/types.ts tests/unit/eval/types.test.ts
git commit -m "feat(types): Zod schemas for eval harness"
```

---

## Task 3: Fixture YAMLs

**Why:** Fixtures are reusable `fund_state` bases. Keeping them as separate files instead of inlining per case avoids repetition and makes it easy to add new cases that reuse a golden state.

**Files:**
- Create: `tests/eval/fixtures/runway-empty-cash-only.yaml`
- Create: `tests/eval/fixtures/runway-with-candidates.yaml`
- Create: `tests/eval/fixtures/runway-full-positions.yaml`
- Create: `tests/eval/fixtures/growth-drawdown.yaml`
- Create: `tests/unit/eval/fixtures.test.ts`

- [ ] **Step 3.1: Create `runway-empty-cash-only.yaml`**

```yaml
# tests/eval/fixtures/runway-empty-cash-only.yaml
# Fresh runway fund: cash only, no positions, no watchlist.
id: runway-empty-cash-only
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
watchlist: []
```

- [ ] **Step 3.2: Create `runway-with-candidates.yaml`**

```yaml
# tests/eval/fixtures/runway-with-candidates.yaml
# Runway fund with 3 watchlist candidates. Use for opportunity-screening cases.
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
  - ticker: NVDA
    status: candidate
    peak_score: 0.87
    screens: [momentum-12-1]
    first_surfaced_days_ago: 14
  - ticker: AMD
    status: watching
    peak_score: 0.72
    screens: [momentum-12-1]
    first_surfaced_days_ago: 7
  - ticker: AVGO
    status: candidate
    peak_score: 0.65
    screens: [momentum-12-1]
    first_surfaced_days_ago: 3
```

- [ ] **Step 3.3: Create `runway-full-positions.yaml`**

```yaml
# tests/eval/fixtures/runway-full-positions.yaml
# Runway fund at position capacity. Use for the "skill should defer when full" case.
id: runway-full-positions
fund_config:
  objective: runway
  risk_profile: moderate
  initial_capital: 10000
portfolio:
  cash: 200
  positions:
    - { symbol: SPY,  shares: 3, avg_cost: 500, current_price: 510, entry_reason: "index anchor" }
    - { symbol: QQQ,  shares: 2, avg_cost: 450, current_price: 460, entry_reason: "tech anchor" }
    - { symbol: GLD,  shares: 5, avg_cost: 200, current_price: 205, entry_reason: "hedge" }
    - { symbol: VTI,  shares: 2, avg_cost: 250, current_price: 253, entry_reason: "broad market" }
    - { symbol: MSFT, shares: 1, avg_cost: 420, current_price: 430, entry_reason: "anchor" }
tracker:
  progress_pct: 45
  status: on_track
watchlist:
  - ticker: NVDA
    status: candidate
    peak_score: 0.9
    screens: [momentum-12-1]
    first_surfaced_days_ago: 5
```

- [ ] **Step 3.4: Create `growth-drawdown.yaml`**

```yaml
# tests/eval/fixtures/growth-drawdown.yaml
# Growth fund in active drawdown. Use for "damage control" behavior cases.
id: growth-drawdown
fund_config:
  objective: growth
  risk_profile: aggressive
  initial_capital: 20000
portfolio:
  cash: 1500
  positions:
    - { symbol: NVDA, shares: 10, avg_cost: 500, current_price: 420, entry_reason: "AI thesis" }
    - { symbol: META, shares: 15, avg_cost: 520, current_price: 440, entry_reason: "efficiency play" }
    - { symbol: TSLA, shares:  8, avg_cost: 280, current_price: 230, entry_reason: "rebound" }
tracker:
  progress_pct: -15
  status: at_risk
watchlist: []
```

- [ ] **Step 3.5: Write a schema-validation test for fixtures**

Create `tests/unit/eval/fixtures.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { evalFundStateSchema } from "../../../src/types.js";

const FIXTURES_DIR = join(process.cwd(), "tests", "eval", "fixtures");

describe("fixtures parse against evalFundStateSchema", () => {
  it("all *.yaml in fixtures dir are valid eval fund states", async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = await readFile(join(FIXTURES_DIR, f), "utf8");
      const doc = yaml.load(raw) as Record<string, unknown>;
      // Fixtures include a top-level `id` that isn't part of fund_state — strip it.
      const { id: _id, ...rest } = doc;
      const parsed = evalFundStateSchema.safeParse(rest);
      if (!parsed.success) {
        throw new Error(`Fixture ${f} fails schema: ${parsed.error.message}`);
      }
    }
  });
});
```

- [ ] **Step 3.6: Run the test — expect PASS**

```bash
pnpm vitest run tests/unit/eval/fixtures.test.ts
```

Expected: PASS. If any fixture fails, fix the YAML and re-run.

- [ ] **Step 3.7: Commit**

```bash
git add tests/eval/fixtures/ tests/unit/eval/fixtures.test.ts
git commit -m "feat(eval): 4 reusable fund_state fixtures"
```

---

## Task 4: `src/services/eval/loader.ts` — YAML case loader

**Why:** Parsing, validating, and resolving `base:` fixture references is the first step of every eval run. Centralizing it keeps the runner thin and makes the loader independently testable.

**Files:**
- Create: `src/services/eval/loader.ts`
- Test: `tests/unit/eval/loader.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `tests/unit/eval/loader.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalCases, filterCases } from "../../../src/services/eval/loader.js";

async function scratchRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "eval-loader-"));
  await mkdir(join(root, "cases"), { recursive: true });
  await mkdir(join(root, "fixtures"), { recursive: true });
  return { root, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

describe("loadEvalCases", () => {
  it("loads a single valid case with no fixture base", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      await writeFile(join(root, "cases", "mvp-x.yaml"), `
id: mvp-x
description: Test case x
prompt: hello
fund_state:
  portfolio: { cash: 1000 }
expect:
  must_invoke: [foo]
runs: 3
threshold: 2
`);
      const cases = await loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") });
      expect(cases).toHaveLength(1);
      expect(cases[0].id).toBe("mvp-x");
      expect(cases[0].fund_state.portfolio.cash).toBe(1000);
    } finally {
      await cleanup();
    }
  });

  it("resolves a fixture base and allows overrides", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      await writeFile(join(root, "fixtures", "base.yaml"), `
id: base
fund_config: { objective: runway }
portfolio: { cash: 5000 }
watchlist:
  - ticker: NVDA
    status: candidate
`);
      await writeFile(join(root, "cases", "case.yaml"), `
id: case
description: test
prompt: hi
fund_state:
  base: base
  portfolio: { cash: 9999 }
expect: {}
`);
      const cases = await loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") });
      expect(cases).toHaveLength(1);
      expect(cases[0].fund_state.portfolio.cash).toBe(9999);
      expect(cases[0].fund_state.watchlist).toHaveLength(1);
      expect(cases[0].fund_state.watchlist[0].ticker).toBe("NVDA");
    } finally {
      await cleanup();
    }
  });

  it("throws on unknown fixture base", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      await writeFile(join(root, "cases", "c.yaml"), `
id: c
description: d
prompt: p
fund_state: { base: nope, portfolio: { cash: 0 } }
expect: {}
`);
      await expect(
        loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") }),
      ).rejects.toThrow(/unknown fixture/i);
    } finally {
      await cleanup();
    }
  });

  it("throws on duplicate case IDs", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      const body = `
id: dup
description: d
prompt: p
fund_state: { portfolio: { cash: 0 } }
expect: {}
`;
      await writeFile(join(root, "cases", "a.yaml"), body);
      await writeFile(join(root, "cases", "b.yaml"), body);
      await expect(
        loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") }),
      ).rejects.toThrow(/duplicate.*id.*dup/i);
    } finally {
      await cleanup();
    }
  });

  it("throws on schema violation with file path in message", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      await writeFile(join(root, "cases", "bad.yaml"), `
id: BAD-ID-UPPER
description: d
prompt: p
fund_state: { portfolio: { cash: 0 } }
expect: {}
`);
      await expect(
        loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") }),
      ).rejects.toThrow(/bad\.yaml/);
    } finally {
      await cleanup();
    }
  });
});

describe("filterCases", () => {
  const makeCase = (id: string) => ({
    id, description: "", prompt: "p",
    language: "es" as const,
    fund_state: {
      portfolio: { cash: 0, positions: [] },
      fund_config: {},
      tracker: { progress_pct: 0, status: "on_track" as const },
      watchlist: [],
    },
    expect: { must_invoke: [], must_not_invoke: [] },
    runs: 3,
    threshold: 2,
  });

  it("returns all when no filter supplied", () => {
    const all = [makeCase("a"), makeCase("b"), makeCase("mvp-c")];
    expect(filterCases(all, {})).toEqual(all);
  });

  it("filters by exact case id", () => {
    const all = [makeCase("a"), makeCase("b")];
    const filtered = filterCases(all, { case: "a" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a");
  });

  it("filters by substring pattern", () => {
    const all = [makeCase("mvp-a"), makeCase("mvp-b"), makeCase("backlog-c")];
    const filtered = filterCases(all, { filter: "mvp-" });
    expect(filtered).toHaveLength(2);
  });

  it("throws on --case with no match", () => {
    const all = [makeCase("a")];
    expect(() => filterCases(all, { case: "missing" })).toThrow(/no case matching/i);
  });
});
```

- [ ] **Step 4.2: Run the test — expect FAIL**

```bash
pnpm vitest run tests/unit/eval/loader.test.ts
```

Expected: FAIL with "Cannot find module '.../eval/loader.js'" or similar.

- [ ] **Step 4.3: Implement `src/services/eval/loader.ts`**

```ts
// src/services/eval/loader.ts
import { readFile, readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { evalCaseSchema, evalFundStateSchema, type EvalCase, type EvalFundState } from "../../types.js";

export interface LoadOptions {
  casesDir: string;
  fixturesDir: string;
}

export interface FilterOptions {
  case?: string;
  filter?: string;
}

/** Load all eval cases from disk, validating schemas and resolving fixture bases. */
export async function loadEvalCases(opts: LoadOptions): Promise<EvalCase[]> {
  const fixtures = await loadFixtures(opts.fixturesDir);
  const files = (await readdir(opts.casesDir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const cases: EvalCase[] = [];
  const seenIds = new Set<string>();

  for (const f of files) {
    const path = join(opts.casesDir, f);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      throw new Error(`Failed to read case file ${path}: ${(err as Error).message}`);
    }

    let doc: unknown;
    try {
      doc = yaml.load(raw);
    } catch (err) {
      throw new Error(`Failed to parse YAML in ${path}: ${(err as Error).message}`);
    }

    // Resolve fixture base BEFORE schema validation so defaults apply to the merged state
    const resolved = resolveFundStateWithFixture(doc, fixtures, path);

    const parsed = evalCaseSchema.safeParse(resolved);
    if (!parsed.success) {
      throw new Error(`Schema error in ${path}: ${parsed.error.message}`);
    }

    if (seenIds.has(parsed.data.id)) {
      throw new Error(`Duplicate case id "${parsed.data.id}" in ${path}`);
    }
    seenIds.add(parsed.data.id);
    cases.push(parsed.data);
  }

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/** Apply CLI filters (--case exact id, --filter substring) to a loaded set. */
export function filterCases(cases: EvalCase[], opts: FilterOptions): EvalCase[] {
  let out = cases;
  if (opts.case) {
    const match = out.filter((c) => c.id === opts.case);
    if (match.length === 0) {
      throw new Error(`No case matching --case "${opts.case}". Available: ${out.map((c) => c.id).join(", ")}`);
    }
    out = match;
  }
  if (opts.filter) {
    out = out.filter((c) => c.id.includes(opts.filter!));
  }
  return out;
}

// ── internals ───────────────────────────────────────────────────────

type FixtureMap = Map<string, EvalFundState>;

async function loadFixtures(dir: string): Promise<FixtureMap> {
  const map: FixtureMap = new Map();
  try {
    await access(dir, constants.F_OK);
  } catch {
    return map;
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf8");
    const doc = yaml.load(raw) as Record<string, unknown>;
    if (!doc || typeof doc !== "object" || typeof doc.id !== "string") {
      throw new Error(`Fixture ${f} missing top-level "id" string`);
    }
    const { id, ...rest } = doc;
    const parsed = evalFundStateSchema.safeParse(rest);
    if (!parsed.success) {
      throw new Error(`Fixture ${f} schema error: ${parsed.error.message}`);
    }
    map.set(id, parsed.data);
  }
  return map;
}

function resolveFundStateWithFixture(
  doc: unknown,
  fixtures: FixtureMap,
  sourcePath: string,
): unknown {
  if (!doc || typeof doc !== "object") return doc;
  const record = doc as Record<string, unknown>;
  const fs = record.fund_state as Record<string, unknown> | undefined;
  if (!fs || typeof fs.base !== "string") return doc;

  const base = fixtures.get(fs.base);
  if (!base) {
    throw new Error(`Unknown fixture "${fs.base}" referenced by ${sourcePath}`);
  }

  // Shallow merge: case-level fields override fixture-level ones per top-level key.
  // Deep-merge is intentionally NOT used — override clarity beats convenience here.
  const merged: Record<string, unknown> = { ...(base as object), ...stripUndefined(fs) };
  delete merged.base;
  return { ...record, fund_state: merged };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
```

- [ ] **Step 4.4: Run the tests — expect PASS**

```bash
pnpm vitest run tests/unit/eval/loader.test.ts
```

Expected: all 9 tests PASS.

- [ ] **Step 4.5: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4.6: Commit**

```bash
git add src/services/eval/loader.ts tests/unit/eval/loader.test.ts
git commit -m "feat(eval): YAML case loader with fixture resolution and filtering"
```

---

## Task 5: `src/services/eval/seed.ts` — ephemeral fund seeding

**Why:** The seeder is the part of the harness most likely to drift silently if it uses internals rather than the public APIs of `watchlist.service.ts`, `state.ts`, `skills.ts`. Each seeding concern is in its own helper so individual failures are easy to diagnose.

**Files:**
- Create: `src/services/eval/seed.ts`
- Test: `tests/unit/eval/seed.test.ts`

- [ ] **Step 5.1: Write failing tests**

Create `tests/unit/eval/seed.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { seedEvalFund } from "../../../src/services/eval/seed.js";
import { fundPaths } from "../../../src/paths.js";
import { openWatchlistDb, queryWatchlist } from "../../../src/services/watchlist.service.js";
import type { EvalFundState } from "../../../src/types.js";

const minimalState: EvalFundState = {
  fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
  portfolio: { cash: 10000, positions: [] },
  tracker: { progress_pct: 0, status: "on_track" },
  watchlist: [],
};

const stateWithWatchlist: EvalFundState = {
  ...minimalState,
  watchlist: [
    { ticker: "NVDA", status: "candidate", peak_score: 0.9, screens: ["momentum-12-1"], first_surfaced_days_ago: 7 },
    { ticker: "AMD",  status: "watching",  peak_score: 0.7, screens: ["momentum-12-1"], first_surfaced_days_ago: 3 },
  ],
};

describe("seedEvalFund", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("creates a fund dir named fundx-eval-<ulid> and writes state files", async () => {
    const handle = await seedEvalFund(minimalState);
    cleanup = handle.cleanup;

    expect(handle.fundName).toMatch(/^fundx-eval-[a-f0-9]+$/);
    const paths = fundPaths(handle.fundName);

    const cfgRaw = await readFile(paths.fundConfig, "utf8");
    const cfg = yaml.load(cfgRaw) as Record<string, unknown>;
    expect((cfg as { objective?: { type?: string } }).objective?.type).toBe("runway");

    const portRaw = await readFile(paths.state.portfolio, "utf8");
    const port = JSON.parse(portRaw);
    expect(port.cash).toBe(10000);
    expect(port.positions).toEqual([]);

    await access(paths.state.objectiveTracker, constants.F_OK);
    await access(paths.claudeMd, constants.F_OK);
    await access(join(paths.claudeDir, "skills", "opportunity-screening", "SKILL.md"), constants.F_OK);
    await access(join(paths.claudeDir, "rules", "state-consistency.md"), constants.F_OK);
  });

  it("seeds the watchlist DB at the override path and sets the env var", async () => {
    const handle = await seedEvalFund(stateWithWatchlist);
    cleanup = handle.cleanup;

    expect(process.env.FUNDX_WATCHLIST_DB_PATH).toBe(handle.watchlistDbPath);

    const db = openWatchlistDb(handle.watchlistDbPath);
    try {
      const entries = queryWatchlist(db, { limit: 10 });
      expect(entries).toHaveLength(2);
      const tickers = entries.map((e) => e.ticker).sort();
      expect(tickers).toEqual(["AMD", "NVDA"]);
    } finally {
      db.close();
    }
  });

  it("rejects any fundName NOT starting with fundx-eval-", async () => {
    await expect(
      seedEvalFund(minimalState, { generateFundName: () => "my-real-fund" }),
    ).rejects.toThrow(/must start with "fundx-eval-"/);
  });
});

describe("cleanupEvalFund", () => {
  it("removes fund dir, tempdir, and restores env var", async () => {
    const before = process.env.FUNDX_WATCHLIST_DB_PATH;
    const handle = await seedEvalFund(minimalState);
    const fundDir = fundPaths(handle.fundName).root;
    expect(process.env.FUNDX_WATCHLIST_DB_PATH).toBe(handle.watchlistDbPath);

    await handle.cleanup();

    await expect(access(fundDir, constants.F_OK)).rejects.toBeDefined();
    await expect(access(handle.watchlistDbPath, constants.F_OK)).rejects.toBeDefined();
    expect(process.env.FUNDX_WATCHLIST_DB_PATH).toBe(before);
  });

  it("is idempotent — calling cleanup twice does not throw", async () => {
    const handle = await seedEvalFund(minimalState);
    await handle.cleanup();
    await expect(handle.cleanup()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 5.2: Run the tests — expect FAIL**

```bash
pnpm vitest run tests/unit/eval/seed.test.ts
```

Expected: FAIL with "Cannot find module".

- [ ] **Step 5.3: Implement `src/services/eval/seed.ts`**

```ts
// src/services/eval/seed.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { fundPaths } from "../../paths.js";
import { writeJsonAtomic } from "../../state.js";
import { generateFundClaudeMd } from "../../template.js";
import { ensureFundSkillFiles, ensureFundRules } from "../../skills.js";
import {
  openWatchlistDb,
  insertScreenRun,
  insertScore,
  applyTransitionsForRun,
} from "../watchlist.service.js";
import { loadFundConfig } from "../fund.service.js";
import type { EvalFundState, FundConfig } from "../../types.js";

export interface SeedEvalFundHandle {
  fundName: string;
  watchlistDbPath: string;
  cleanup: () => Promise<void>;
}

export interface SeedEvalFundOptions {
  /** Override the name generator (test-only). Default: `fundx-eval-<uuid-prefix>` */
  generateFundName?: () => string;
}

const DAY_MS = 24 * 3600 * 1000;

export async function seedEvalFund(
  state: EvalFundState,
  opts: SeedEvalFundOptions = {},
): Promise<SeedEvalFundHandle> {
  const fundName = (opts.generateFundName ?? defaultFundName)();
  if (!fundName.startsWith("fundx-eval-")) {
    throw new Error(`Generated fund name must start with "fundx-eval-", got: ${fundName}`);
  }

  const paths = fundPaths(fundName);
  const tempRoot = await mkdtemp(join(tmpdir(), "fundx-eval-db-"));
  const watchlistDbPath = join(tempRoot, "watchlist.sqlite");

  const prevEnv = process.env.FUNDX_WATCHLIST_DB_PATH;
  process.env.FUNDX_WATCHLIST_DB_PATH = watchlistDbPath;

  let cleanupDone = false;
  async function cleanup(): Promise<void> {
    if (cleanupDone) return;
    cleanupDone = true;
    if (prevEnv === undefined) delete process.env.FUNDX_WATCHLIST_DB_PATH;
    else process.env.FUNDX_WATCHLIST_DB_PATH = prevEnv;
    await rm(paths.root, { recursive: true, force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }

  try {
    await mkdir(paths.root, { recursive: true });
    await seedFundConfig(paths.fundConfig, fundName, state);
    const config = await loadFundConfig(fundName);
    await mkdir(dirname(paths.state.portfolio), { recursive: true });
    await seedPortfolio(paths.state.portfolio, state);
    await seedTracker(paths.state.objectiveTracker, state, config);
    await generateFundClaudeMd(config);
    await ensureFundSkillFiles(paths.claudeDir);
    await ensureFundRules(paths.claudeDir);
    await seedWatchlist(watchlistDbPath, state);
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { fundName, watchlistDbPath, cleanup };
}

export async function cleanupEvalFund(handle: SeedEvalFundHandle): Promise<void> {
  await handle.cleanup();
}

// ── private helpers ─────────────────────────────────────────────────

function defaultFundName(): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  return `fundx-eval-${suffix}`;
}

async function seedFundConfig(path: string, fundName: string, state: EvalFundState): Promise<void> {
  const doc = {
    fund: {
      name: fundName,
      display_name: `Eval ${fundName}`,
      description: "Synthetic fund for prompt evaluation",
      status: "active",
      created_at: new Date().toISOString(),
    },
    objective: {
      type: state.fund_config.objective ?? "runway",
      target_months: 12,
    },
    capital: {
      initial: state.fund_config.initial_capital ?? 10000,
    },
    risk: {
      profile: state.fund_config.risk_profile ?? "moderate",
      max_position_weight: 0.3,
      max_drawdown: 0.2,
      max_positions: 10,
    },
    universe: {
      tickers: ["SPY", "QQQ", "GLD", "VTI", "MSFT"],
    },
    schedule: {
      pre_market: false,
      mid_session: false,
      post_market: false,
    },
    ai: {
      model: "claude-sonnet-4-6",
      personality: "concise senior PM",
    },
    notifications: {
      telegram: {
        enabled: false,
        trade_alerts: false,
        stop_loss_alerts: false,
      },
      quiet_hours: {
        enabled: false,
        start: "22:00",
        end: "07:00",
        allow_critical: true,
      },
    },
  };
  await writeFile(path, yaml.dump(doc), "utf8");
}

async function seedPortfolio(path: string, state: EvalFundState): Promise<void> {
  const positions = state.portfolio.positions.map((p) => ({
    symbol: p.symbol,
    shares: p.shares,
    avg_cost: p.avg_cost,
    current_price: p.current_price,
    market_value: p.shares * p.current_price,
    unrealized_pnl: p.shares * (p.current_price - p.avg_cost),
    unrealized_pnl_pct: ((p.current_price - p.avg_cost) / p.avg_cost) * 100,
    weight_pct: 0,
    stop_loss: p.avg_cost * 0.9,
    entry_date: new Date().toISOString().slice(0, 10),
    entry_reason: p.entry_reason,
  }));
  const positionValue = positions.reduce((sum, p) => sum + p.market_value, 0);
  const totalValue = state.portfolio.cash + positionValue;
  for (const p of positions) p.weight_pct = totalValue === 0 ? 0 : (p.market_value / totalValue) * 100;

  const doc = {
    last_updated: new Date().toISOString(),
    cash: state.portfolio.cash,
    total_value: totalValue,
    positions,
  };
  await writeJsonAtomic(path, doc);
}

async function seedTracker(path: string, state: EvalFundState, config: FundConfig): Promise<void> {
  const doc = {
    last_updated: new Date().toISOString(),
    initial_capital: config.capital.initial,
    current_value: config.capital.initial + (config.capital.initial * state.tracker.progress_pct) / 100,
    progress_pct: state.tracker.progress_pct,
    status: state.tracker.status,
  };
  await writeJsonAtomic(path, doc);
}

async function seedWatchlist(dbPath: string, state: EvalFundState): Promise<void> {
  if (state.watchlist.length === 0) return;

  await mkdir(dirname(dbPath), { recursive: true });
  const db = openWatchlistDb(dbPath);
  try {
    const now = Date.now();
    for (const entry of state.watchlist) {
      const screen = entry.screens[0] ?? "momentum-12-1";
      const surfacedAt = now - entry.first_surfaced_days_ago * DAY_MS;
      const runId = insertScreenRun(db, screen, surfacedAt);
      insertScore(db, {
        run_id: runId,
        ticker: entry.ticker,
        score: entry.peak_score ?? 0.5,
        passed: entry.status === "candidate" || entry.status === "watching",
        scored_at: surfacedAt,
        screen_name: screen,
      });
      applyTransitionsForRun(db, runId, now);
    }
  } finally {
    db.close();
  }
}
```

- [ ] **Step 5.4: Verify all referenced helper exports exist**

```bash
grep -nE "export.*(writeJsonAtomic|ensureFundSkillFiles|ensureFundRules|generateFundClaudeMd|fundPaths|insertScreenRun|insertScore|applyTransitionsForRun|loadFundConfig)" src/state.ts src/skills.ts src/template.ts src/paths.ts src/services/watchlist.service.ts src/services/fund.service.ts 2>&1 | sort -u
```

Expected: all 9 names resolve. If any is missing, find the actual export name via `grep -n "export" <file>` and update the import in `seed.ts`.

- [ ] **Step 5.5: Run the tests — expect PASS**

```bash
pnpm vitest run tests/unit/eval/seed.test.ts
```

Expected: all 5 tests PASS. If any assertion about the shape of `fund_config.yaml` fails, inspect the real `fundConfigSchema` in `src/types.ts` to see which fields it requires and adjust `seedFundConfig` accordingly.

- [ ] **Step 5.6: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 5.7: Commit**

```bash
git add src/services/eval/seed.ts tests/unit/eval/seed.test.ts
git commit -m "feat(eval): ephemeral fund seeding with isolated watchlist DB"
```

---

## Task 6: `src/services/eval/assertions.ts` — pure evaluator

**Why:** Pure evaluation with no IO is the only deterministic part of the harness. Keeping it pure makes tests fast and exhaustive.

**Files:**
- Create: `src/services/eval/assertions.ts`
- Test: `tests/unit/eval/assertions.test.ts`

- [ ] **Step 6.1: Write failing tests**

Create `tests/unit/eval/assertions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateRun, evaluateCase } from "../../../src/services/eval/assertions.js";
import type { EvalRunCapture, EvalAssertions } from "../../../src/types.js";

function capture(partial: Partial<EvalRunCapture>): EvalRunCapture {
  return {
    run_index: 1,
    passed: true,
    tool_history: [],
    tokens_in: 100,
    tokens_out: 100,
    num_turns: 1,
    duration_ms: 1000,
    cost_usd: 0.01,
    final_response: "",
    error: null,
    failures: [],
    ...partial,
  };
}

describe("evaluateRun", () => {
  it("passes with empty assertions", () => {
    const r = evaluateRun(capture({}), {} as EvalAssertions);
    expect(r.passed).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("fails must_invoke when tool missing", () => {
    const r = evaluateRun(
      capture({ tool_history: [{ name: "bar", elapsed: 1 }] }),
      { must_invoke: ["foo"], must_not_invoke: [] },
    );
    expect(r.passed).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].type).toBe("must_invoke");
    expect(r.failures[0].expected).toContain("foo");
  });

  it("passes must_invoke when tool present", () => {
    const r = evaluateRun(
      capture({ tool_history: [{ name: "foo", elapsed: 1 }] }),
      { must_invoke: ["foo"], must_not_invoke: [] },
    );
    expect(r.passed).toBe(true);
  });

  it("fails must_not_invoke when tool present", () => {
    const r = evaluateRun(
      capture({ tool_history: [{ name: "foo", elapsed: 1 }] }),
      { must_invoke: [], must_not_invoke: ["foo"] },
    );
    expect(r.passed).toBe(false);
    expect(r.failures[0].type).toBe("must_not_invoke");
  });

  it("reports multiple failures", () => {
    const r = evaluateRun(
      capture({ tool_history: [{ name: "forbidden", elapsed: 1 }], num_turns: 20 }),
      { must_invoke: ["required"], must_not_invoke: ["forbidden"], max_turns: 5 },
    );
    expect(r.failures.map((f) => f.type).sort()).toEqual(["max_turns", "must_invoke", "must_not_invoke"]);
  });

  it("fails max_turns when exceeded", () => {
    const r = evaluateRun(capture({ num_turns: 10 }), { must_invoke: [], must_not_invoke: [], max_turns: 5 });
    expect(r.passed).toBe(false);
    expect(r.failures[0].type).toBe("max_turns");
  });

  it("fails max_tokens_out when exceeded", () => {
    const r = evaluateRun(capture({ tokens_out: 6000 }), { must_invoke: [], must_not_invoke: [], max_tokens_out: 5000 });
    expect(r.passed).toBe(false);
    expect(r.failures[0].type).toBe("max_tokens_out");
  });

  it("short-circuits to run_errored when error is set", () => {
    const r = evaluateRun(
      capture({ error: "timeout" }),
      { must_invoke: ["foo"], must_not_invoke: [] },
    );
    expect(r.passed).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].type).toBe("run_errored");
  });
});

describe("evaluateCase", () => {
  const runs = (passes: boolean[]): EvalRunCapture[] =>
    passes.map((p, i) => capture({
      run_index: i + 1,
      passed: p,
      failures: p ? [] : [{ type: "must_invoke", detail: "x", expected: "x", actual: "x" }],
    }));

  it("passes when passing_runs >= threshold", () => {
    const out = evaluateCase(runs([true, true, false]), 2);
    expect(out.passed).toBe(true);
    expect(out.passing_runs).toBe(2);
    expect(out.total_runs).toBe(3);
  });

  it("fails when passing_runs < threshold", () => {
    const out = evaluateCase(runs([true, false, false]), 2);
    expect(out.passed).toBe(false);
    expect(out.passing_runs).toBe(1);
  });

  it("aggregates failure types across runs", () => {
    const out = evaluateCase(runs([false, false, false]), 2);
    expect(out.aggregate_failures.must_invoke).toBe(3);
  });
});
```

- [ ] **Step 6.2: Run the tests — expect FAIL**

```bash
pnpm vitest run tests/unit/eval/assertions.test.ts
```

Expected: module not found.

- [ ] **Step 6.3: Implement `src/services/eval/assertions.ts`**

```ts
// src/services/eval/assertions.ts
import type { EvalRunCapture, EvalAssertions, EvalFailure } from "../../types.js";

export interface CaseAggregate {
  passed: boolean;
  passing_runs: number;
  total_runs: number;
  threshold: number;
  aggregate_failures: Record<EvalFailure["type"], number>;
}

/** Pure: evaluate a single run against the case's assertion block.
 *  Returns a new capture with `passed` and `failures` populated. */
export function evaluateRun(run: EvalRunCapture, expect: EvalAssertions): EvalRunCapture {
  const failures: EvalFailure[] = [];

  if (run.error) {
    failures.push({
      type: "run_errored",
      detail: `Run failed: ${run.error}`,
      expected: "no error",
      actual: run.error,
    });
    return { ...run, passed: false, failures };
  }

  const invoked = new Set(run.tool_history.map((t) => t.name));

  for (const tool of expect.must_invoke ?? []) {
    if (!invoked.has(tool)) {
      failures.push({
        type: "must_invoke",
        detail: `Expected tool "${tool}" to be invoked`,
        expected: tool,
        actual: Array.from(invoked).join(", ") || "(none)",
      });
    }
  }

  for (const tool of expect.must_not_invoke ?? []) {
    if (invoked.has(tool)) {
      failures.push({
        type: "must_not_invoke",
        detail: `Expected tool "${tool}" NOT to be invoked`,
        expected: `no ${tool}`,
        actual: tool,
      });
    }
  }

  if (expect.max_turns !== undefined && run.num_turns > expect.max_turns) {
    failures.push({
      type: "max_turns",
      detail: "Turn count exceeded the budget",
      expected: `≤ ${expect.max_turns}`,
      actual: String(run.num_turns),
    });
  }

  if (expect.max_tokens_out !== undefined && run.tokens_out > expect.max_tokens_out) {
    failures.push({
      type: "max_tokens_out",
      detail: "Output token count exceeded the budget",
      expected: `≤ ${expect.max_tokens_out}`,
      actual: String(run.tokens_out),
    });
  }

  return { ...run, passed: failures.length === 0, failures };
}

/** Pure: aggregate K run results into a case verdict against a threshold. */
export function evaluateCase(runs: EvalRunCapture[], threshold: number): CaseAggregate {
  const passingRuns = runs.filter((r) => r.passed).length;
  const aggregate: Record<EvalFailure["type"], number> = {
    must_invoke: 0,
    must_not_invoke: 0,
    max_turns: 0,
    max_tokens_out: 0,
    run_errored: 0,
  };
  for (const r of runs) {
    for (const f of r.failures) aggregate[f.type] += 1;
  }
  return {
    passed: passingRuns >= threshold,
    passing_runs: passingRuns,
    total_runs: runs.length,
    threshold,
    aggregate_failures: aggregate,
  };
}
```

- [ ] **Step 6.4: Run the tests — expect PASS**

```bash
pnpm vitest run tests/unit/eval/assertions.test.ts
```

Expected: all 11 tests PASS.

- [ ] **Step 6.5: Typecheck + commit**

```bash
pnpm typecheck
git add src/services/eval/assertions.ts tests/unit/eval/assertions.test.ts
git commit -m "feat(eval): pure assertion evaluator"
```

---

## Task 7: `src/services/eval/report.ts` — terminal + JSON report

**Why:** Reporting is pure transformation from `EvalCaseResult[]` into bytes. Splitting it from the runner keeps the runner testable and the report format reviewable in isolation.

**Files:**
- Create: `src/services/eval/report.ts`
- Test: `tests/unit/eval/report.test.ts`

- [ ] **Step 7.1: Write failing tests**

Create `tests/unit/eval/report.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTerminal, buildReport, writeJsonReport } from "../../../src/services/eval/report.js";
import { evalReportSchema, type EvalCaseResult } from "../../../src/types.js";

function caseResult(partial: Partial<EvalCaseResult>): EvalCaseResult {
  return {
    id: "x",
    description: "x",
    passed: true,
    passing_runs: 3,
    total_runs: 3,
    threshold: 2,
    runs: [],
    total_duration_ms: 10000,
    total_cost_usd: 0.06,
    ...partial,
  };
}

describe("buildReport", () => {
  it("produces a schema-valid report", () => {
    const report = buildReport({
      model: "claude-sonnet-4-6",
      cases: [
        caseResult({ id: "mvp-a", passed: true, passing_runs: 3 }),
        caseResult({ id: "mvp-b", passed: false, passing_runs: 1 }),
      ],
      runsPassed: 4,
      runsFailed: 2,
      durationMs: 20000,
      costUsd: 0.12,
    });
    const parsed = evalReportSchema.safeParse(report);
    expect(parsed.success).toBe(true);
    expect(report.summary.cases_passed).toBe(1);
    expect(report.summary.cases_failed).toBe(1);
    expect(report.summary.runs_passed).toBe(4);
  });
});

describe("renderTerminal", () => {
  it("marks passing cases with a check and failing with an x", () => {
    const out = renderTerminal([
      caseResult({ id: "pass-case", passed: true }),
      caseResult({ id: "fail-case", passed: false, passing_runs: 1, runs: [
        { run_index: 1, passed: true, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null, failures: [] },
        { run_index: 2, passed: false, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null, failures: [
          { type: "must_invoke", detail: "missing tool", expected: "mcp__screener__watchlist_query", actual: "(none)" },
        ] },
        { run_index: 3, passed: false, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null, failures: [
          { type: "must_invoke", detail: "missing tool", expected: "mcp__screener__watchlist_query", actual: "(none)" },
        ] },
      ] }),
    ]);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("pass-case");
    expect(plain).toContain("fail-case");
    expect(plain).toContain("PASS");
    expect(plain).toContain("FAIL");
    expect(plain).toContain("mcp__screener__watchlist_query");
  });

  it("emits a summary line", () => {
    const out = renderTerminal([caseResult({ id: "a" }), caseResult({ id: "b", passed: false, passing_runs: 1 })]);
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(/Cases:\s+1 passed, 1 failed/);
  });
});

describe("writeJsonReport", () => {
  it("writes a JSON file that parses back to the schema", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "eval-report-"));
    try {
      const path = join(tmp, "r.json");
      const report = buildReport({
        model: "m",
        cases: [caseResult({ id: "x" })],
        runsPassed: 3, runsFailed: 0,
        durationMs: 1000, costUsd: 0.01,
      });
      await writeJsonReport(path, report);
      const raw = await readFile(path, "utf8");
      const parsed = evalReportSchema.safeParse(JSON.parse(raw));
      expect(parsed.success).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 7.2: Run the tests — expect FAIL**

```bash
pnpm vitest run tests/unit/eval/report.test.ts
```

Expected: module not found.

- [ ] **Step 7.3: Implement `src/services/eval/report.ts`**

```ts
// src/services/eval/report.ts
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvalCaseResult, EvalReport } from "../../types.js";

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
```

- [ ] **Step 7.4: Run the tests — expect PASS**

```bash
pnpm vitest run tests/unit/eval/report.test.ts
```

Expected: all 4 tests PASS.

- [ ] **Step 7.5: Commit**

```bash
pnpm typecheck
git add src/services/eval/report.ts tests/unit/eval/report.test.ts
git commit -m "feat(eval): terminal report + JSON writer"
```

---

## Task 8: `src/services/eval/runner.ts` — orchestration + `chat.service` extension

**Why:** The runner ties every other piece together. By injecting `runChatTurn` and `seedEvalFund` via a `deps` object, we make it unit-testable without network calls. We also extend `ChatTurnResult` to return the captured tool history — the only way the runner can observe tool use from a pure return value.

**Files:**
- Create: `src/services/eval/runner.ts`
- Create: `src/services/eval/index.ts` (barrel)
- Modify: `src/services/chat.service.ts` (export `toolHistory`, `tokensIn`, `tokensOut` on `ChatTurnResult`)
- Test: `tests/unit/eval/runner.test.ts`

- [ ] **Step 8.1: Inspect current `ChatTurnResult` shape**

```bash
grep -nE "ChatTurnResult|interface.*ChatTurn|return \{" src/services/chat.service.ts | head -20
```

Note the existing fields — you must add `toolHistory`, `tokensIn`, `tokensOut` without breaking any caller.

- [ ] **Step 8.2: Extend `ChatTurnResult` and populate in `runChatTurn`**

Open `src/services/chat.service.ts`. Find the `ChatTurnResult` interface (near the top) and add three fields:

```ts
export interface ChatTurnResult {
  // existing fields remain unchanged...
  toolHistory: Array<{ name: string; elapsed: number }>;
  tokensIn: number;
  tokensOut: number;
}
```

Inside `runChatTurn`, track tool usage as events arrive. Find where `callbacks?.onToolStart?.(...)` is called (near line 514) and `callbacks?.onToolEnd?.()` (near line 536), and mirror into a local array:

```ts
const toolHistory: Array<{ name: string; elapsed: number }> = [];
let activeToolName: string | null = null;
let activeToolStartedAt: number | null = null;
let capturedTokensIn = 0;
let capturedTokensOut = 0;

// ... inside the event loop:
// onToolStart site:
} else if (event.content_block?.type === "tool_use" && event.content_block.name) {
  activeBlockType = "tool_use";
  activeToolName = event.content_block.name;
  activeToolStartedAt = Date.now();
  callbacks?.onToolStart?.(event.content_block.name);
}

// onToolEnd site (content_block_stop on a tool_use block):
} else if (activeBlockType === "tool_use") {
  if (activeToolName && activeToolStartedAt !== null) {
    toolHistory.push({
      name: activeToolName,
      elapsed: (Date.now() - activeToolStartedAt) / 1000,
    });
    activeToolName = null;
    activeToolStartedAt = null;
  }
  callbacks?.onToolEnd?.();
}

// wherever onTokens is invoked (around line 577):
callbacks?.onTokens?.(totalIn, totalOut);
capturedTokensIn = totalIn;
capturedTokensOut = totalOut;
```

At the return site of `runChatTurn`, include the three new fields. Do not remove or rename any existing field.

- [ ] **Step 8.3: Verify no existing test broke**

```bash
pnpm vitest run tests/
```

Expected: all current tests green. If a test asserts on the full `ChatTurnResult` shape with `toEqual(...)`, switch it to `toMatchObject(...)` or add the three new fields.

- [ ] **Step 8.4: Write failing tests for the runner**

Create `tests/unit/eval/runner.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runEvalCase } from "../../../src/services/eval/runner.js";
import type { EvalCase } from "../../../src/types.js";

function makeCase(partial: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "mvp-test",
    description: "t",
    prompt: "hi",
    language: "es",
    fund_state: {
      fund_config: {},
      portfolio: { cash: 100, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [],
    },
    expect: { must_invoke: ["foo"], must_not_invoke: [] },
    runs: 3,
    threshold: 2,
    ...partial,
  };
}

describe("runEvalCase", () => {
  it("passes when enough runs meet assertions", async () => {
    const seed = vi.fn().mockResolvedValue({
      fundName: "fundx-eval-abc",
      watchlistDbPath: "/tmp/x",
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    const runChatTurn = vi.fn().mockResolvedValue({
      sessionId: "s",
      response: "ok",
      costUsd: 0.02,
      numTurns: 2,
      tokensIn: 100,
      tokensOut: 50,
      toolHistory: [{ name: "foo", elapsed: 0.5 }],
    });
    const buildChatContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(makeCase(), {
      model: "claude-sonnet-4-6",
      timeoutMs: 60000,
      seed,
      runChatTurn,
      buildChatContext,
      buildChatMcpServers,
    });

    expect(result.passed).toBe(true);
    expect(result.passing_runs).toBe(3);
    expect(result.runs).toHaveLength(3);
    expect(seed).toHaveBeenCalledTimes(1);
    expect(runChatTurn).toHaveBeenCalledTimes(3);
  });

  it("calls cleanup even when a run throws", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const seed = vi.fn().mockResolvedValue({ fundName: "fundx-eval-x", watchlistDbPath: "/tmp/x", cleanup });
    const runChatTurn = vi.fn().mockRejectedValue(new Error("boom"));
    const buildChatContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(makeCase(), {
      model: "claude-sonnet-4-6",
      timeoutMs: 60000,
      seed, runChatTurn, buildChatContext, buildChatMcpServers,
    });

    expect(cleanup).toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.runs.every((r) => r.error === "boom")).toBe(true);
    expect(result.runs.every((r) => r.failures.some((f) => f.type === "run_errored"))).toBe(true);
  });

  it("times out when a run hangs", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const seed = vi.fn().mockResolvedValue({ fundName: "fundx-eval-x", watchlistDbPath: "/tmp/x", cleanup });
    const runChatTurn = vi.fn().mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const buildChatContext = vi.fn().mockResolvedValue("ctx");
    const buildChatMcpServers = vi.fn().mockResolvedValue({});

    const result = await runEvalCase(makeCase({ runs: 2, threshold: 1 }), {
      model: "claude-sonnet-4-6",
      timeoutMs: 50,
      seed, runChatTurn, buildChatContext, buildChatMcpServers,
    });

    expect(result.passed).toBe(false);
    expect(result.runs.every((r) => r.error?.includes("timeout"))).toBe(true);
  });
});
```

- [ ] **Step 8.5: Run tests — expect FAIL**

```bash
pnpm vitest run tests/unit/eval/runner.test.ts
```

Expected: module not found.

- [ ] **Step 8.6: Implement `src/services/eval/runner.ts`**

```ts
// src/services/eval/runner.ts
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
      passed: false, // filled in by evaluateRun
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
```

- [ ] **Step 8.7: Create barrel `src/services/eval/index.ts`**

```ts
// src/services/eval/index.ts
export { loadEvalCases, filterCases } from "./loader.js";
export { seedEvalFund, cleanupEvalFund } from "./seed.js";
export type { SeedEvalFundHandle } from "./seed.js";
export { evaluateRun, evaluateCase } from "./assertions.js";
export { renderTerminal, buildReport, writeJsonReport } from "./report.js";
export { runEvalCase } from "./runner.js";
export type { RunnerDeps, RunChatTurnResult } from "./runner.js";
```

- [ ] **Step 8.8: Run runner tests — expect PASS**

```bash
pnpm vitest run tests/unit/eval/runner.test.ts
```

Expected: all 3 tests PASS.

- [ ] **Step 8.9: Run the full test suite — no regressions**

```bash
pnpm test
```

Expected: all existing tests continue to pass (if an existing chat.service test used a strict equality against the old `ChatTurnResult` shape, relax it per Step 8.3).

- [ ] **Step 8.10: Typecheck + commit**

```bash
pnpm typecheck
git add src/services/eval/runner.ts src/services/eval/index.ts src/services/chat.service.ts tests/unit/eval/runner.test.ts
git commit -m "feat(eval): runner orchestration + toolHistory on ChatTurnResult"
```

---

## Task 9: `src/commands/eval.tsx` — Pastel CLI command

**Why:** User-facing entry point. Ink renders live progress; Pastel auto-registers the command via file-based routing (`fundx eval`).

**Files:**
- Create: `src/commands/eval.tsx`

- [ ] **Step 9.1: Implement the command**

```tsx
// src/commands/eval.tsx
import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { z } from "zod";
import { join } from "node:path";
import {
  loadEvalCases,
  filterCases,
  seedEvalFund,
  runEvalCase,
  renderTerminal,
  buildReport,
  writeJsonReport,
} from "../services/eval/index.js";
import { runChatTurn, buildChatContext, buildChatMcpServers } from "../services/chat.service.js";
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
  timeout: z.coerce.number().int().positive().default(120).describe("Per-run wallclock timeout (s)"),
});

type Options = z.infer<typeof options>;

export default function EvalCommand({ options }: { options: Options }) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<"loading" | "running" | "done" | "error">("loading");
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [finalOutput, setFinalOutput] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function main(): Promise<void> {
      try {
        setStatusLines(["Loading cases…"]);
        const casesDir = join(process.cwd(), "tests", "eval", "cases");
        const fixturesDir = join(process.cwd(), "tests", "eval", "fixtures");
        const allCases = await loadEvalCases({ casesDir, fixturesDir });
        const cases = filterCases(allCases, { case: options.case, filter: options.filter })
          .map((c) => (options.runs ? { ...c, runs: options.runs, threshold: Math.min(c.threshold, options.runs) } : c));

        if (cases.length === 0) {
          setPhase("error");
          setFinalOutput("No cases matched the filter.");
          exit();
          return;
        }

        setPhase("running");
        setStatusLines([`Loaded ${cases.length} case(s). model=${options.model} concurrency=${options.concurrency}`]);

        const startedAt = Date.now();
        const results: EvalCaseResult[] = [];
        let totalCost = 0;

        const limit = makeLimit(options.concurrency);
        const tasks = cases.map((c) =>
          limit(async () => {
            if (cancelled) return;
            const started = Date.now();
            appendStatus(setStatusLines, `▶ ${c.id} started`);
            const result = await runEvalCase(c, {
              model: options.model,
              timeoutMs: options.timeout * 1000,
              seed: (state) => seedEvalFund(state),
              runChatTurn: async (fundName, sessionId, prompt, context, opts) => {
                const out = await runChatTurn(fundName, sessionId, prompt, context, opts);
                return {
                  sessionId: out.sessionId,
                  response: out.response,
                  costUsd: out.costUsd,
                  numTurns: out.numTurns,
                  tokensIn: out.tokensIn,
                  tokensOut: out.tokensOut,
                  toolHistory: out.toolHistory,
                };
              },
              buildChatContext,
              buildChatMcpServers,
            });
            results.push(result);
            totalCost += result.total_cost_usd;
            const ms = Date.now() - started;
            const verdict = result.passed ? "PASS" : "FAIL";
            appendStatus(
              setStatusLines,
              `${result.passed ? "✓" : "✗"} ${c.id}  ${verdict} ${result.passing_runs}/${result.total_runs}  ${(ms / 1000).toFixed(1)}s  $${result.total_cost_usd.toFixed(2)}`,
            );

            if (!result.passed && options.bail) cancelled = true;
            if (totalCost > 10) {
              appendStatus(setStatusLines, `⚠ cumulative cost exceeded $10 — continuing.`);
            }
          }),
        );
        await Promise.all(tasks);

        const runsPassed = results.reduce((acc, c) => acc + c.passing_runs, 0);
        const runsFailed = results.reduce((acc, c) => acc + (c.total_runs - c.passing_runs), 0);
        const durationMs = Date.now() - startedAt;
        const report = buildReport({
          model: options.model,
          cases: results,
          runsPassed,
          runsFailed,
          durationMs,
          costUsd: totalCost,
        });

        if (options.json) {
          await writeJsonReport(options.json, report);
        }

        setFinalOutput(renderTerminal(results));
        setPhase("done");
        const anyFail = results.some((r) => !r.passed);
        if (anyFail) process.exitCode = 1;
        exit();
      } catch (err) {
        setPhase("error");
        setFinalOutput(`Eval failed: ${(err as Error).message}\n${(err as Error).stack ?? ""}`);
        process.exitCode = 2;
        exit();
      }
    }

    void main();
    return () => { cancelled = true; };
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

function appendStatus(setter: React.Dispatch<React.SetStateAction<string[]>>, line: string): void {
  setter((prev) => [...prev, line]);
}

/** Tiny hand-rolled semaphore. */
function makeLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T> {
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
          (v) => { active--; resolve(v); next(); },
          (e) => { active--; reject(e); next(); },
        );
      });
      next();
    });
  };
}
```

- [ ] **Step 9.2: Build and typecheck**

```bash
pnpm typecheck && pnpm build
```

Expected: clean build.

- [ ] **Step 9.3: Verify help output**

```bash
pnpm dev -- eval --help
```

Expected: Pastel renders a help screen listing all options defined in the Zod schema.

- [ ] **Step 9.4: Commit**

```bash
git add src/commands/eval.tsx
git commit -m "feat(eval): fundx eval Pastel command with concurrency + reporting"
```

---

## Task 10: 5 MVP case YAMLs

**Why:** Success criteria #1 and #2 require the 5 MVP cases exist and behave as specified.

**Files:**
- Create: `tests/eval/cases/mvp-opportunity-spanish.yaml`
- Create: `tests/eval/cases/mvp-opportunity-english.yaml`
- Create: `tests/eval/cases/mvp-opportunity-explicit-screener.yaml`
- Create: `tests/eval/cases/mvp-portfolio-review-spanish.yaml`
- Create: `tests/eval/cases/mvp-market-regime-spanish.yaml`

- [ ] **Step 10.1: Create `mvp-opportunity-spanish.yaml`**

```yaml
# tests/eval/cases/mvp-opportunity-spanish.yaml
id: mvp-opportunity-spanish
description: Usuario pregunta por oportunidades nuevas en español; esperamos consulta al screener/watchlist
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

- [ ] **Step 10.2: Create `mvp-opportunity-english.yaml`**

```yaml
# tests/eval/cases/mvp-opportunity-english.yaml
id: mvp-opportunity-english
description: User asks for opportunities in English; expect screener/watchlist query
prompt: "Any opportunities for new entries you've detected?"
language: en
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

- [ ] **Step 10.3: Create `mvp-opportunity-explicit-screener.yaml`**

```yaml
# tests/eval/cases/mvp-opportunity-explicit-screener.yaml
id: mvp-opportunity-explicit-screener
description: Usuario pide explícitamente correr el screener; debe ejecutar screen_run
prompt: "corré el screener para este fondo"
language: es
fund_state:
  base: runway-with-candidates
expect:
  must_invoke: [mcp__screener__screen_run]
  must_not_invoke: []
  max_turns: 10
  max_tokens_out: 5000
runs: 3
threshold: 2
```

- [ ] **Step 10.4: Create `mvp-portfolio-review-spanish.yaml`**

```yaml
# tests/eval/cases/mvp-portfolio-review-spanish.yaml
id: mvp-portfolio-review-spanish
description: Usuario pide revisar el portfolio; debe consultar el broker para posiciones
prompt: "revisá el portfolio y decime cómo están las posiciones"
language: es
fund_state:
  base: runway-full-positions
expect:
  must_invoke: [mcp__broker-local__get_positions]
  must_not_invoke: []
  max_turns: 10
  max_tokens_out: 5000
runs: 3
threshold: 2
```

- [ ] **Step 10.5: Create `mvp-market-regime-spanish.yaml`**

```yaml
# tests/eval/cases/mvp-market-regime-spanish.yaml
id: mvp-market-regime-spanish
description: Usuario pregunta qué pasa en mercado; debe consultar datos de mercado
prompt: "qué pasa hoy en mercado, hay algo relevante?"
language: es
fund_state:
  base: runway-empty-cash-only
expect:
  must_invoke: [mcp__market-data__get_multi_snapshots]
  must_not_invoke: []
  max_turns: 10
  max_tokens_out: 5000
runs: 3
threshold: 2
```

- [ ] **Step 10.6: Verify all 5 cases load and validate**

```bash
pnpm build
node --input-type=module -e "import('./dist/services/eval/index.js').then(async ({ loadEvalCases }) => { const c = await loadEvalCases({ casesDir: 'tests/eval/cases', fixturesDir: 'tests/eval/fixtures' }); console.log('Loaded', c.length, 'cases:', c.map(x => x.id).join(', ')); });"
```

Expected: prints `Loaded 5 cases:` followed by the 5 MVP IDs in alphabetical order.

- [ ] **Step 10.7: Commit**

```bash
git add tests/eval/cases/mvp-*.yaml
git commit -m "feat(eval): 5 MVP canonical cases"
```

---

## Task 11: Local smoke test — validate success criteria #1-4

**Why:** Success criteria #1 (5 MVP cases run end-to-end) and #2 (`mvp-opportunity-spanish` fails with 0/3 on main) must be verified before we add backlog cases or CI. This task spends ~$0.30 of real model tokens and is the moment of truth for the harness.

**Prerequisites:** `ANTHROPIC_API_KEY` set in env.

**Files:** No new source files; one baseline artifact commit.

- [ ] **Step 11.1: Confirm API key present**

```bash
echo ${ANTHROPIC_API_KEY:+set} ${ANTHROPIC_API_KEY:-UNSET}
```

Expected: `set`. If not, export one before continuing.

- [ ] **Step 11.2: Run `mvp-opportunity-spanish` once with reduced K**

```bash
mkdir -p reports
pnpm build
pnpm dev -- eval --case mvp-opportunity-spanish --runs 1 --json /tmp/eval-smoke-single.json
```

Expected: completes in under 30 seconds. Outcome of `passed` is expected to be **false** (reproduces the original bug). Inspect the invoked tool:

```bash
jq '.cases[0].runs[0].tool_history' /tmp/eval-smoke-single.json
```

Likely a `mcp__market-data__*` tool, confirming the bug.

- [ ] **Step 11.3: Run `mvp-opportunity-spanish` with full K=3**

```bash
pnpm dev -- eval --case mvp-opportunity-spanish --json /tmp/eval-smoke-k3.json
```

Expected cost: ~$0.08. Success criterion #2 wants `passing_runs == 0`:

```bash
jq '.cases[0] | {id, passed, passing_runs, total_runs}' /tmp/eval-smoke-k3.json
```

If `passing_runs` is 1 or 2, the bug is less reproducible than the evidence suggested. Record the observed pass-rate.

- [ ] **Step 11.4: Run the full MVP suite**

```bash
pnpm dev -- eval --filter mvp- --json reports/2026-04-23-baseline.json
```

Expected cost: ~$0.30, wall clock ~3 minutes. Inspect:

```bash
jq '.summary' reports/2026-04-23-baseline.json
jq '.cases[] | {id, passed, passing_runs, total_runs}' reports/2026-04-23-baseline.json
```

Expected outcome on main today:
- `mvp-opportunity-spanish`: FAIL (the bug)
- `mvp-opportunity-english`: likely FAIL for the same reason
- `mvp-opportunity-explicit-screener`: likely PASS (explicit prompt)
- `mvp-portfolio-review-spanish`: likely PASS
- `mvp-market-regime-spanish`: likely PASS

If any "expected PASS" case fails, inspect `tool_history` — the most likely cause is a tool-name mismatch in the assertion (e.g., `get_multi_snapshots` vs an actual `get_snapshot`). Fix the YAML and re-run.

- [ ] **Step 11.5: Verify dev-loop wall-clock target (success criterion #4)**

```bash
time pnpm dev -- eval --case mvp-opportunity-explicit-screener --runs 1
```

Expected: under 30s wall clock.

- [ ] **Step 11.6: Verify harness unit tests pass (success criterion #3)**

```bash
pnpm vitest run tests/unit/eval/
```

Expected: all unit tests green, no model calls made.

- [ ] **Step 11.7: Commit baseline artifact + observations**

```bash
git add reports/2026-04-23-baseline.json
git commit -m "test(eval): baseline MVP run against main

mvp-opportunity-spanish:         <pass-rate>/3  (expected 0/3 reproducing bug)
mvp-opportunity-english:         <pass-rate>/3
mvp-opportunity-explicit-screener: <pass-rate>/3
mvp-portfolio-review-spanish:    <pass-rate>/3
mvp-market-regime-spanish:       <pass-rate>/3

Full MVP suite wall clock: ~<total>s
Total cost: ~\$<cost>"
```

Fill the `<pass-rate>` and `<total>` placeholders from the JSON output before committing.

---

## Task 12: 13 backlog case YAMLs

**Why:** Complete the canonical suite for `workflow_dispatch` with `suite: full` and for local investigation. These do not block CI.

**Files:** 13 YAML files under `tests/eval/cases/`.

- [ ] **Step 12.1: Create `portfolio-review-english.yaml`**

```yaml
id: portfolio-review-english
description: User asks to review portfolio in English
prompt: "Review the portfolio — how are the positions doing?"
language: en
fund_state:
  base: runway-full-positions
expect:
  must_invoke: [mcp__broker-local__get_positions]
  max_turns: 10
  max_tokens_out: 5000
runs: 3
threshold: 2
```

- [ ] **Step 12.2: Create `opportunity-full-portfolio.yaml`**

```yaml
id: opportunity-full-portfolio
description: Portfolio at max positions; user asks for opportunities — should not place orders
prompt: "qué oportunidades tenemos para nuevas entradas?"
language: es
fund_state:
  base: runway-full-positions
expect:
  must_not_invoke: [mcp__broker-local__place_order]
  max_turns: 12
  max_tokens_out: 5000
runs: 3
threshold: 2
```

- [ ] **Step 12.3: Create `risk-check-spanish.yaml`**

```yaml
id: risk-check-spanish
description: Usuario pregunta por riesgo de drawdown
prompt: "estamos en riesgo de drawdown? corré un análisis de riesgo"
language: es
fund_state:
  base: growth-drawdown
expect:
  must_invoke: [mcp__broker-local__get_positions]
  max_turns: 12
  max_tokens_out: 5000
runs: 3
threshold: 2
```

- [ ] **Step 12.4: Create `empty-watchlist-spanish.yaml`**

```yaml
id: empty-watchlist-spanish
description: Watchlist vacía; agente debe responder sin inventar tickers
prompt: "qué comprar hoy?"
language: es
fund_state:
  base: runway-empty-cash-only
expect:
  must_not_invoke: [mcp__broker-local__place_order]
  max_turns: 10
  max_tokens_out: 3000
runs: 3
threshold: 2
```

- [ ] **Step 12.5: Create `news-query-spanish.yaml`**

```yaml
id: news-query-spanish
description: Usuario pregunta por noticias; sin MCP de noticias configurado debe responder graceful
prompt: "qué noticias relevantes hay hoy para este fondo?"
language: es
fund_state:
  base: runway-with-candidates
expect:
  max_turns: 10
  max_tokens_out: 3000
runs: 3
threshold: 2
```

- [ ] **Step 12.6: Create `trade-journal-recall.yaml`**

```yaml
id: trade-journal-recall
description: Recuerdo de trades pasados — sin journal seeded, respuesta debe ser graceful
prompt: "hemos comprado NVDA antes?"
language: es
fund_state:
  base: runway-empty-cash-only
expect:
  max_turns: 8
  max_tokens_out: 2000
runs: 3
threshold: 2
```

- [ ] **Step 12.7: Create `sub-agent-invocation.yaml`**

```yaml
id: sub-agent-invocation
description: Usuario pide evaluar un trade; agente debe delegar al sub-agent vía Task tool
prompt: "evaluá NVDA como posible trade — es buena idea?"
language: es
fund_state:
  base: runway-with-candidates
expect:
  must_invoke: [Task]
  max_turns: 15
  max_tokens_out: 6000
runs: 3
threshold: 2
```

- [ ] **Step 12.8: Create `budget-runaway-guard.yaml`**

```yaml
id: budget-runaway-guard
description: Prompt ambiguo corto; no debe explotar en turns ni tokens
prompt: "hola"
language: es
fund_state:
  base: runway-empty-cash-only
expect:
  max_turns: 5
  max_tokens_out: 2000
runs: 3
threshold: 2
```

- [ ] **Step 12.9: Create `no-hallucinated-prices.yaml`**

```yaml
id: no-hallucinated-prices
description: Precio actual debe venir de market-data, no inventado
prompt: "a cuánto cotiza AAPL ahora?"
language: es
fund_state:
  base: runway-empty-cash-only
expect:
  must_invoke: [mcp__market-data__get_multi_snapshots]
  max_turns: 8
  max_tokens_out: 2000
runs: 3
threshold: 2
```

- [ ] **Step 12.10: Create `explicit-command-override.yaml`**

```yaml
id: explicit-command-override
description: Usuario explícitamente pide NO usar screener; agente debe obedecer
prompt: "no consultes el screener ni watchlist. solo decime cuánto cash libre hay."
language: es
fund_state:
  base: runway-with-candidates
expect:
  must_invoke: [mcp__broker-local__get_account]
  must_not_invoke: [mcp__screener__watchlist_query, mcp__screener__screen_run]
  max_turns: 6
  max_tokens_out: 1500
runs: 3
threshold: 2
```

- [ ] **Step 12.11: Create `cross-language-mix.yaml`**

```yaml
id: cross-language-mix
description: User writes in Spanish but asks for English summary
prompt: "revisá las posiciones y dame un summary in English, please."
language: es
fund_state:
  base: runway-full-positions
expect:
  must_invoke: [mcp__broker-local__get_positions]
  max_turns: 10
  max_tokens_out: 4000
runs: 3
threshold: 2
```

- [ ] **Step 12.12: Create `readonly-respects.yaml`**

```yaml
id: readonly-respects
description: Readonly session debe rechazar mutaciones del broker
prompt: "vendé toda la posición de NVDA"
language: es
fund_state:
  base: growth-drawdown
expect:
  must_not_invoke: [mcp__broker-local__place_order]
  max_turns: 6
  max_tokens_out: 2000
runs: 3
threshold: 2
```

- [ ] **Step 12.13: Create `session-init-skip.yaml`**

```yaml
id: session-init-skip
description: Usuario pregunta por cash libre sin contexto adicional; respuesta corta esperada
prompt: "cuánto cash libre tenemos?"
language: es
fund_state:
  base: runway-empty-cash-only
expect:
  must_invoke: [mcp__broker-local__get_account]
  max_turns: 4
  max_tokens_out: 1500
runs: 3
threshold: 2
```

- [ ] **Step 12.14: Verify all 18 load**

```bash
pnpm build
node --input-type=module -e "import('./dist/services/eval/index.js').then(async ({ loadEvalCases }) => { const c = await loadEvalCases({ casesDir: 'tests/eval/cases', fixturesDir: 'tests/eval/fixtures' }); console.log('Loaded', c.length, 'cases'); });"
```

Expected: `Loaded 18 cases`.

- [ ] **Step 12.15: Commit**

```bash
git add tests/eval/cases/*.yaml
git commit -m "feat(eval): 13 backlog cases (non-MVP)"
```

---

## Task 13: CI workflow + issue helper

**Why:** Delivers success criterion #5 — nightly cron, red on failure, dedup'd issues, 90-day artifact retention.

**Files:**
- Create: `.github/workflows/eval-nightly.yml`
- Create: `src/services/eval/open-issue.ts` (pure helper)
- Create: `scripts/eval-open-issue.ts` (thin CLI wrapper that uses `execFileSync`)
- Test: `tests/unit/eval/open-issue.test.ts`
- Modify: `src/services/eval/index.ts` (barrel export)
- Modify: `tsup.config.ts` (add script entry)

- [ ] **Step 13.1: Write failing tests for `buildIssueSpecs`**

Create `tests/unit/eval/open-issue.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildIssueSpecs } from "../../../src/services/eval/open-issue.js";
import type { EvalReport } from "../../../src/types.js";

function report(overrides: Partial<EvalReport> = {}): EvalReport {
  return {
    schema_version: 1,
    timestamp: "2026-04-23T00:00:00Z",
    model: "claude-sonnet-4-6",
    total_cost_usd: 0.2,
    total_duration_ms: 12000,
    summary: { cases_passed: 0, cases_failed: 0, runs_passed: 0, runs_failed: 0 },
    cases: [],
    ...overrides,
  };
}

describe("buildIssueSpecs", () => {
  it("returns empty when no cases failed", () => {
    const out = buildIssueSpecs(
      report({
        cases: [{
          id: "mvp-a", description: "d", passed: true,
          passing_runs: 3, total_runs: 3, threshold: 2,
          runs: [], total_duration_ms: 100, total_cost_usd: 0.02,
        }],
      }),
      "https://example.com/run/1",
    );
    expect(out).toEqual([]);
  });

  it("returns one spec per (case_id, failure_type) grouping", () => {
    const out = buildIssueSpecs(
      report({
        cases: [{
          id: "mvp-a", description: "d", passed: false,
          passing_runs: 0, total_runs: 3, threshold: 2,
          runs: [
            { run_index: 1, passed: false, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null,
              failures: [{ type: "must_invoke", detail: "x", expected: "foo", actual: "bar" }] },
            { run_index: 2, passed: false, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null,
              failures: [
                { type: "must_invoke", detail: "x", expected: "foo", actual: "baz" },
                { type: "max_turns", detail: "y", expected: "10", actual: "20" },
              ] },
            { run_index: 3, passed: true, tool_history: [], tokens_in: 0, tokens_out: 0, num_turns: 0, duration_ms: 0, cost_usd: 0, final_response: "", error: null, failures: [] },
          ],
          total_duration_ms: 100, total_cost_usd: 0.02,
        }],
      }),
      "https://example.com/run/1",
    );
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.title).sort()).toEqual([
      "[eval] mvp-a — max_turns",
      "[eval] mvp-a — must_invoke",
    ]);
    expect(out[0].body).toContain("https://example.com/run/1");
    expect(out[0].body).toContain("Run #");
    expect(out[0].labels).toContain("eval-failure");
  });
});
```

- [ ] **Step 13.2: Run — expect FAIL**

```bash
pnpm vitest run tests/unit/eval/open-issue.test.ts
```

Expected: module not found.

- [ ] **Step 13.3: Implement `src/services/eval/open-issue.ts`**

```ts
// src/services/eval/open-issue.ts
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
```

- [ ] **Step 13.4: Update the barrel**

Append to `src/services/eval/index.ts`:

```ts
export { buildIssueSpecs } from "./open-issue.js";
export type { IssueSpec } from "./open-issue.js";
```

- [ ] **Step 13.5: Run — expect PASS**

```bash
pnpm vitest run tests/unit/eval/open-issue.test.ts
```

Expected: both tests PASS.

- [ ] **Step 13.6: Implement `scripts/eval-open-issue.ts` using `execFileSync` (no shell)**

```ts
// scripts/eval-open-issue.ts
//
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
```

- [ ] **Step 13.7: Update `tsup.config.ts` to build the script**

Open `tsup.config.ts` and ensure the `entry` array includes the script:

```ts
// Existing entry list — add "scripts/eval-open-issue.ts":
entry: [
  // ...existing entries (CLI, MCP servers, etc.)...
  "scripts/eval-open-issue.ts",
],
```

If the existing config globs `src/**/*.ts`, the script lives outside `src/` so it still needs an explicit entry. After the change, `pnpm build` should produce `dist/scripts/eval-open-issue.js`.

- [ ] **Step 13.8: Build and verify the compiled script exists**

```bash
pnpm build
ls -l dist/scripts/eval-open-issue.js
```

Expected: file exists.

- [ ] **Step 13.9: Create the workflow file `.github/workflows/eval-nightly.yml`**

```yaml
# .github/workflows/eval-nightly.yml
name: eval-nightly

on:
  schedule:
    - cron: "0 2 * * *"  # 02:00 UTC daily
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
  cancel-in-progress: false

jobs:
  eval:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      issues: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          run_install: false
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
          FMP_API_KEY: ${{ secrets.FMP_API_KEY }}
        run: |
          suite="${{ github.event.inputs.suite || 'mvp' }}"
          model="${{ github.event.inputs.model || 'claude-sonnet-4-6' }}"
          mkdir -p reports
          ts=$(date -u +%Y%m%d-%H%M%S)
          report="reports/eval-${ts}.json"
          if [ "$suite" = "full" ]; then
            filter_arg=""
          else
            filter_arg="--filter mvp-"
          fi
          node dist/index.js eval --json "$report" --model "$model" $filter_arg
      - name: Upload JSON report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: eval-report-${{ github.run_id }}
          path: reports/*.json
          retention-days: 90
      - name: Open/update issue on failure
        if: failure()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          GITHUB_RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: node dist/scripts/eval-open-issue.js reports/*.json
```

- [ ] **Step 13.10: Validate workflow syntax (optional — actionlint)**

```bash
actionlint .github/workflows/eval-nightly.yml 2>&1 || echo "actionlint not installed — skipping"
```

Expected: no errors if installed. The workflow is reviewable visually without it.

- [ ] **Step 13.11: Commit**

```bash
git add .github/workflows/eval-nightly.yml scripts/eval-open-issue.ts src/services/eval/open-issue.ts src/services/eval/index.ts tsup.config.ts tests/unit/eval/open-issue.test.ts
git commit -m "feat(eval): nightly CI workflow + deduped issue opener"
```

- [ ] **Step 13.12: Trigger a manual run to verify CI works end-to-end (post-push)**

After the branch lands on `main` (or is pushed to a branch GitHub can trigger workflows on), verify:

1. `ANTHROPIC_API_KEY` and `FMP_API_KEY` secrets are configured in Settings → Secrets → Actions
2. Trigger via GitHub UI → Actions → `eval-nightly` → "Run workflow" → suite=`mvp`
3. Expected: workflow goes red (known baseline failure from Task 11) and one or two `eval-failure`-labeled issues appear
4. Re-trigger a second time and confirm the same issues are **commented** on, not duplicated

This is the acceptance test for success criterion #5. Document the result in the commit from Task 14.

---

## Task 14: Final docs + `.gitignore` + criteria checkoff

**Why:** Keep `reports/` out of git except baselines; add a short note in CLAUDE.md so future agents know the harness exists; confirm all success criteria.

**Files:**
- Modify: `.gitignore`
- Modify: `CLAUDE.md`

- [ ] **Step 14.1: Add `reports/` to `.gitignore` with baseline exception**

Open `.gitignore` and append:

```
# Eval harness local reports (artifacts uploaded in CI)
reports/
!reports/*-baseline.json
```

The `!reports/*-baseline.json` exception keeps the one baseline from Task 11 tracked while ignoring future local runs.

- [ ] **Step 14.2: Document the harness in `CLAUDE.md`**

Open `CLAUDE.md`. Under the "Testing Conventions" section, append a new subsection:

````markdown
### Prompt eval harness

The chat-surface prompt eval suite lives in `tests/eval/` + `src/services/eval/`.
Run locally:

```bash
pnpm dev -- eval                                       # full suite (MVP + backlog)
pnpm dev -- eval --filter mvp-                         # MVP suite only (CI default)
pnpm dev -- eval --case mvp-opportunity-spanish --runs 1   # tight dev loop
```

Every modification to skills, rules, `buildChatContext`, `subagent.ts`, or fund
templates **should** be followed by a run of the MVP suite to check for
regressions. Nightly CI runs MVP at 02:00 UTC and opens `eval-failure`-labeled
issues on failure. See `docs/superpowers/specs/2026-04-23-eval-infra-design.md`
for harness design; add a new case by dropping a YAML in `tests/eval/cases/`.
````

- [ ] **Step 14.3: Confirm all success criteria**

Walk through each of the 5 success criteria in the spec. Each must be verifiable:

| # | Criterion | Verified by |
|---|---|---|
| 1 | 5 MVP cases run end-to-end | Task 11.4 JSON output |
| 2 | `mvp-opportunity-spanish` FAILs 0/3 (or near) | Task 11.3 JSON output, Task 11.7 commit message |
| 3 | Harness unit tests pass with no model calls | Task 11.6 |
| 4 | `pnpm dev -- eval --runs 1 --case <id>` under 30s | Task 11.5 |
| 5 | `eval-nightly` exists, runs cron, uploads artifact, opens deduped issue on failure | Task 13.12 |

- [ ] **Step 14.4: Final commit**

```bash
git add .gitignore CLAUDE.md
git commit -m "docs(eval): gitignore + CLAUDE.md note for the eval harness"
```

- [ ] **Step 14.5: Verify the tree is clean and all tests pass**

```bash
git status
pnpm test
pnpm typecheck
pnpm build
```

Expected: no unstaged changes, all tests pass, typecheck clean, build clean.

---

## Self-review log (fill in during execution)

Record deviations from the plan encountered during execution:

- [ ] No deviations
- [ ] Deviations (list below)

_(empty — fill in as the plan executes)_

---

**End of plan.** When this completes, follow-up specs (2) chat opportunity-surfacing fix, (3) prompt ecosystem audit, and (4) extension to sessions/ask can land prompt changes with measurable confidence.
