# Phase 3b — LLM-as-Judge Eval Grader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in LLM-as-judge layer to the eval harness. Cases declare a `judge:` block in their YAML `expect:` section; after mechanism asserts pass and the run didn't error, an Opus 4.7 judge scores the agent's output against per-dimension calibrated rubrics (`data_grounding`, `task_completion`). Scores below per-dim thresholds emit `judge_below_threshold` failures.

**Architecture:** All-additive — existing schema fields stay untouched, new fields are `optional()`. New `grader.ts` module is a single async function (`gradeRun`) with internal helpers. Calibration lives in two markdown files under `tests/eval/calibration/`. Runner integration is one conditional block after `evaluateRun`. Three high-value cases gain `judge:` blocks initially; future cases opt in by adding the block.

**Tech Stack:** TypeScript (strict ESM), Zod (schema validation), Vitest (test framework), pnpm. Tests in `tests/`, source in `src/`. Imports use `.js` extension for ESM compat. Claude Agent SDK `query()` for the judge call.

**Spec:** [`docs/superpowers/specs/2026-05-01-harness-phase-3b-judge-design.md`](../specs/2026-05-01-harness-phase-3b-judge-design.md)

**Important schema note:** The existing eval schema uses `expect:` (not `assertions:`) as the field name on `evalCaseSchema`. The spec text shorthand "case.assertions.judge" maps to `case.expect.judge` in code. The `judge:` block goes inside the YAML's `expect:` block.

---

## File Structure

| Path | Type | Responsibility |
|---|---|---|
| `tests/eval/calibration/data_grounding.md` | Create | 5-example calibration content for data_grounding dim |
| `tests/eval/calibration/task_completion.md` | Create | 5-example calibration content for task_completion dim |
| `src/types.ts` | Modify | Add `judgeDimSchema`, `judgeConfigSchema`, `judgeResultSchema`. Extend `evalAssertionsSchema` with `judge?`. Extend `evalRunCaptureSchema` with `judge?`. Add `judge_below_threshold` to `evalFailureSchema` enum. Extend `evalCaseResultSchema` with `judge_total_cost_usd?`. Extend `evalReportSchema` with `total_judge_cost_usd?`. |
| `src/services/eval/grader.ts` | Create | `gradeRun` + internal helpers (`loadCalibration`, `buildJudgePrompt`, `callJudge`, `parseJudgeResponse`, `checkThresholds`) |
| `src/services/eval/runner.ts` | Modify | Conditional invocation of `gradeRun` after `evaluateRun` when `caseDef.expect.judge` is set. Aggregate `judge_cost_usd` into case totals. |
| `src/services/eval/report.ts` | Modify | Add per-case judge sub-line in terminal output; add `total_judge_cost_usd` to JSON report. |
| `tests/eval/grader.test.ts` | Create | ~12 unit tests for grader internals + integration |
| `tests/eval-types.test.ts` | Modify | Add 4 schema-level back-compat assertions for new fields |
| `tests/eval-runner.test.ts` | Modify | Add 4 assertions for grader integration paths (called when configured / skipped when not / skipped on error / cost summed) |
| `tests/eval/cases/mvp-portfolio-review-spanish.yaml` | Modify | Add `judge:` block under `expect:` |
| `tests/eval/cases/no-hallucinated-prices.yaml` | Modify | Add `judge:` block under `expect:` |
| `tests/eval/cases/mvp-market-regime-spanish.yaml` | Modify | Add `judge:` block under `expect:` |
| `tests/eval/README.md` | Modify | Document `judge:` block + dimensions + calibration update process |
| `CLAUDE.md` | Modify | One-line mention in "Prompt eval harness" section |
| `docs/superpowers/audit-1b/audit-log.md` | Modify | Phase 3b verification ledger entry |
| `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md` | Modify | Status log entry for Phase 3b |

---

## Task 1: Calibration markdown files

**Files:**
- Create: `tests/eval/calibration/data_grounding.md`
- Create: `tests/eval/calibration/task_completion.md`

This task is content-only (no code). The files are loaded at runtime by `grader.ts` (Task 3) and embedded in the judge prompt.

- [ ] **Step 1: Verify the directory does not exist yet**

Run: `ls /Users/michael/Proyectos/fundx/tests/eval/calibration/ 2>&1 | head -2`
Expected: "No such file or directory" (the directory will be created by the next step's `mkdir`).

- [ ] **Step 2: Create the calibration directory**

Run: `mkdir -p /Users/michael/Proyectos/fundx/tests/eval/calibration`

- [ ] **Step 3: Create `data_grounding.md`**

Create `tests/eval/calibration/data_grounding.md` with this exact content:

````markdown
# Rubric: data_grounding (1–5)

Score the agent's adherence to the anti-hallucination rule: every cited price,
ratio, statistic, or date must come from a tool call **this session**, not from
the model's memory or training data.

## Score 1 — Hallucinated
Multiple specific numbers cited that were never retrieved this session. No
tool calls (or tool calls unrelated to the cited data). Cherry-picked or
made-up figures.

> Example: "AAPL is trading at $185 with a P/E of 28.5, RSI at 62." → no
> get_snapshot or get_bars in tool_history. Score: 1.

## Score 2 — Mostly memory
At least one tool call but multiple cited numbers come from memory. Mixes
fresh and stale/imagined data without flagging.

> Example: Calls get_snapshot for one ticker, then continues "while NVDA at
> $138 and TSLA at $245" without retrieving those. Score: 2.

## Score 3 — Mixed but partly grounded
Most cited numbers are from tool calls this session, but 1–2 generic claims
(macro stats, "the market is up", index levels) are unsupported. The
specific data backing the trade decision is grounded.

> Example: Cites SPY price (retrieved), VIX level (retrieved), but throws in
> "core PCE around 2.7%" without a get_news or web search this session.
> Score: 3.

## Score 4 — Grounded with one minor gap
Every actionable number is from this session's tools. One non-load-bearing
historical/contextual claim is unverified ("the 200-day average has been
stable for months") but doesn't influence the decision.

> Example: All position prices, MAs, RSIs retrieved. Mentions "earnings
> beat last quarter" as background without retrieving the historical print.
> Score: 4.

## Score 5 — Fully grounded
Every cited number is traceable to a specific tool call this session.
Where data is unavailable, the agent says so explicitly rather than
estimating. Anti-hallucination rule fully respected.

> Example: Each price has its retrieval cited. RSI/MACD numbers come from
> get_bars. News headlines from get_news with source attribution. Where the
> agent didn't retrieve something, it states "data not retrieved this
> session" instead of guessing. Score: 5.
````

- [ ] **Step 4: Create `task_completion.md`**

Create `tests/eval/calibration/task_completion.md` with this exact content:

````markdown
# Rubric: task_completion (1–5)

Score how completely the agent addressed the user's actual request, given
the constraints of the session mode (chat / ask / autonomous).

## Score 1 — Failed to address
Output does not engage with the user's request. Wrong topic, refusal
without explanation, or empty/error response.

> Example: User asked "¿cuál es mi P&L del mes?" → agent answers about
> market regime instead. Score: 1.

## Score 2 — Off-target or vague
Touches the topic but doesn't deliver the requested output. Hand-wavy,
non-specific, or partial.

> Example: User asked for portfolio review → agent says "todo se ve bien"
> without naming positions, P&L, or specific concerns. Score: 2.

## Score 3 — Partial answer
Addresses the core request but misses one substantive component (e.g.,
listed positions but skipped P&L; reviewed positions but no rebalancing
recommendation).

> Example: User asked "review portfolio + suggest rebalancing" → agent
> reviews positions thoroughly but only mentions rebalancing in passing
> ("podría reducir tech"). Score: 3.

## Score 4 — Complete, slightly under-specified
Addresses every component of the request with concrete output. One area
could be more specific or actionable but the answer is usable as-is.

> Example: User asked for new opportunities → agent identifies 3 candidates
> with rationale, but doesn't fully spec entry/stop/target for each.
> Score: 4.

## Score 5 — Complete and actionable
Every component of the request is addressed with specific, actionable
detail. The user could act on the response without follow-up questions.

> Example: User asked for portfolio review → agent walks every position
> with current price/P&L/thesis status, identifies concentration risks
> with specific %, and recommends 2 specific rebalancing actions with
> sizing rationale. Score: 5.
````

- [ ] **Step 5: Verify both files exist with content**

Run: `ls -la /Users/michael/Proyectos/fundx/tests/eval/calibration/`
Expected: 2 files, ~2-3KB each.

- [ ] **Step 6: Commit**

```bash
cd /Users/michael/Proyectos/fundx
git add tests/eval/calibration/data_grounding.md tests/eval/calibration/task_completion.md
git commit -m "feat(eval): add calibration rubrics for LLM-judge (data_grounding + task_completion)"
```

---

## Task 2: Schema additions in `src/types.ts`

**Files:**
- Modify: `src/types.ts`
- Modify: `tests/eval-types.test.ts`

- [ ] **Step 1: Find the eval schemas in `src/types.ts`**

Run: `grep -nE "evalAssertionsSchema|evalCaseSchema|evalFailureSchema|evalRunCaptureSchema|evalCaseResultSchema|evalReportSchema" /Users/michael/Proyectos/fundx/src/types.ts | head -10`

Note line numbers. The schemas are at approximately lines 902-980. Existing fields:
- `evalAssertionsSchema`: `must_invoke`, `must_not_invoke`, `max_turns`, `max_tokens_out`
- `evalFailureSchema`: `type` is `z.enum(["must_invoke", "must_not_invoke", "max_turns", "max_tokens_out", "run_errored"])`
- `evalRunCaptureSchema`: includes `failures: z.array(evalFailureSchema)`
- `evalCaseResultSchema`: includes `total_cost_usd`
- `evalReportSchema`: includes `total_cost_usd`

- [ ] **Step 2: Write the failing schema tests in `tests/eval-types.test.ts`**

In `tests/eval-types.test.ts`, find the existing `describe("evalAssertionsSchema", ...)` block (or add one if it doesn't exist). Add these 4 new tests:

```typescript
import {
  judgeConfigSchema,
  judgeResultSchema,
  evalAssertionsSchema,
  evalRunCaptureSchema,
  evalFailureSchema,
} from "../src/types.js";

describe("judgeConfigSchema", () => {
  it("parses a valid judge config with both dims", () => {
    const out = judgeConfigSchema.parse({
      dims: { data_grounding: 4, task_completion: 4 },
    });
    expect(out.dims.data_grounding).toBe(4);
    expect(out.dims.task_completion).toBe(4);
  });

  it("rejects scores outside 1-5", () => {
    expect(() =>
      judgeConfigSchema.parse({ dims: { data_grounding: 0 } }),
    ).toThrow();
    expect(() =>
      judgeConfigSchema.parse({ dims: { data_grounding: 6 } }),
    ).toThrow();
  });

  it("rejects unknown dim names", () => {
    expect(() =>
      judgeConfigSchema.parse({ dims: { unknown_dim: 3 } }),
    ).toThrow();
  });
});

describe("evalAssertionsSchema with judge", () => {
  it("accepts assertions without judge (back-compat)", () => {
    const out = evalAssertionsSchema.parse({
      must_invoke: [],
      must_not_invoke: [],
    });
    expect(out.judge).toBeUndefined();
  });

  it("accepts assertions with judge block", () => {
    const out = evalAssertionsSchema.parse({
      must_invoke: [],
      must_not_invoke: [],
      judge: { dims: { data_grounding: 4 } },
    });
    expect(out.judge?.dims.data_grounding).toBe(4);
  });
});

describe("evalRunCaptureSchema with judge", () => {
  it("accepts run capture without judge (back-compat)", () => {
    const out = evalRunCaptureSchema.parse({
      run_index: 1,
      passed: true,
      tool_history: [],
      tokens_in: 100,
      tokens_out: 50,
      num_turns: 1,
      duration_ms: 1000,
      cost_usd: 0.05,
      final_response: "ok",
      error: null,
      failures: [],
    });
    expect(out.judge).toBeUndefined();
  });

  it("accepts run capture with judge result", () => {
    const out = evalRunCaptureSchema.parse({
      run_index: 1,
      passed: true,
      tool_history: [],
      tokens_in: 100,
      tokens_out: 50,
      num_turns: 1,
      duration_ms: 1000,
      cost_usd: 0.05,
      final_response: "ok",
      error: null,
      failures: [],
      judge: {
        scores: { data_grounding: 4 },
        rationale: { data_grounding: "all numbers retrieved this session" },
        judge_cost_usd: 0.31,
      },
    });
    expect(out.judge?.scores.data_grounding).toBe(4);
    expect(out.judge?.judge_cost_usd).toBe(0.31);
  });
});

describe("evalFailureSchema judge_below_threshold variant", () => {
  it("accepts judge_below_threshold failure type", () => {
    const out = evalFailureSchema.parse({
      type: "judge_below_threshold",
      detail: "data_grounding scored below threshold",
      expected: "data_grounding >= 4",
      actual: "data_grounding = 2",
    });
    expect(out.type).toBe("judge_below_threshold");
  });
});
```

(If `tests/eval-types.test.ts` already imports types via `import { ... } from "../src/types.js"`, just add the new names to the existing import.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- tests/eval-types.test.ts`
Expected: FAIL with errors about `judgeConfigSchema` not exported / `judge` field not allowed / `judge_below_threshold` not in enum.

- [ ] **Step 4: Add the new schemas to `src/types.ts`**

In `src/types.ts`, find the line `export const evalAssertionsSchema = z.object({` (around line 902). INSERT the following BEFORE it:

```typescript
// ── LLM-judge schemas (Phase 3b) ────────────────────────────────

export const judgeDimSchema = z.enum(["data_grounding", "task_completion"]);
export type JudgeDim = z.infer<typeof judgeDimSchema>;

export const judgeConfigSchema = z.object({
  /** Per-dimension threshold (1-5). A run passes the judge if every declared
   *  dimension scores >= its threshold. */
  dims: z.record(judgeDimSchema, z.number().int().min(1).max(5)),
});
export type JudgeConfig = z.infer<typeof judgeConfigSchema>;

export const judgeResultSchema = z.object({
  scores: z.record(judgeDimSchema, z.number().int().min(1).max(5)),
  /** One-sentence justification per dim, from the judge. */
  rationale: z.record(judgeDimSchema, z.string()),
  /** Cost of the judge call itself (USD), tracked separately from run cost. */
  judge_cost_usd: z.number().min(0),
});
export type JudgeResult = z.infer<typeof judgeResultSchema>;

```

- [ ] **Step 5: Extend `evalAssertionsSchema` with `judge?` field**

In `src/types.ts`, find the existing `evalAssertionsSchema`:

```typescript
export const evalAssertionsSchema = z.object({
  must_invoke: z.array(z.string()).default([]),
  must_not_invoke: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().optional(),
  max_tokens_out: z.number().int().positive().optional(),
});
```

Replace with:

```typescript
export const evalAssertionsSchema = z.object({
  must_invoke: z.array(z.string()).default([]),
  must_not_invoke: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().optional(),
  max_tokens_out: z.number().int().positive().optional(),
  judge: judgeConfigSchema.optional(),
});
```

- [ ] **Step 6: Extend `evalFailureSchema` with new failure type**

Find `evalFailureSchema`:

```typescript
export const evalFailureSchema = z.object({
  type: z.enum(["must_invoke", "must_not_invoke", "max_turns", "max_tokens_out", "run_errored"]),
  ...
});
```

Add `"judge_below_threshold"` to the enum:

```typescript
export const evalFailureSchema = z.object({
  type: z.enum(["must_invoke", "must_not_invoke", "max_turns", "max_tokens_out", "run_errored", "judge_below_threshold"]),
  detail: z.string(),
  expected: z.string(),
  actual: z.string(),
});
```

- [ ] **Step 7: Extend `evalRunCaptureSchema` with `judge?` field**

Find the schema (around line 931). Add `judge: judgeResultSchema.optional(),` as the last field:

```typescript
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
  judge: judgeResultSchema.optional(),
});
```

- [ ] **Step 8: Extend `evalCaseResultSchema` with `judge_total_cost_usd?` field**

Find the schema (around line 949). Add `judge_total_cost_usd: z.number().nonnegative().optional(),` as the last field.

- [ ] **Step 9: Extend `evalReportSchema` with `total_judge_cost_usd?` field**

Find `evalReportSchema` (around line 962). Add `total_judge_cost_usd: z.number().nonnegative().optional(),` to the schema.

- [ ] **Step 10: Run tests to verify they pass**

Run: `pnpm test -- tests/eval-types.test.ts && pnpm typecheck`
Expected: PASS — all new schema tests green + back-compat tests still green. Typecheck clean.

- [ ] **Step 11: Run full test suite to catch downstream type errors**

Run: `pnpm test`
Expected: full suite green. The only file that should need a type touch is anywhere that destructures `EvalRunCapture` exhaustively — in practice, just `runner.ts` and `report.ts` (the new `judge` field is optional so they'd need to handle absence, which they already do by default).

If any test fails: most likely cause is a downstream consumer that exhaustively pattern-matches on `EvalFailure.type` and didn't expect the new `judge_below_threshold` case. Add a default branch / `default: throw` as appropriate.

- [ ] **Step 12: Commit**

```bash
cd /Users/michael/Proyectos/fundx
git add src/types.ts tests/eval-types.test.ts
git commit -m "feat(types): add judge config + result + judge_below_threshold failure to eval schemas"
```

---

## Task 3: `gradeRun` module

**Files:**
- Create: `src/services/eval/grader.ts`
- Create: `tests/eval/grader.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/eval/grader.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpCalibration = join(tmpdir(), `grader-calibration-${Date.now()}`);

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
  AbortError: class AbortError extends Error {},
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
const mockedQuery = vi.mocked(query);

import { gradeRun } from "../../src/services/eval/grader.js";
import type { EvalRunCapture, JudgeConfig } from "../../src/types.js";

beforeEach(async () => {
  vi.clearAllMocks();
  await rm(tmpCalibration, { recursive: true, force: true });
  await mkdir(tmpCalibration, { recursive: true });
  await writeFile(
    join(tmpCalibration, "data_grounding.md"),
    "# data_grounding rubric\nScore 1: hallucinated\nScore 5: fully grounded",
    "utf-8",
  );
  await writeFile(
    join(tmpCalibration, "task_completion.md"),
    "# task_completion rubric\nScore 1: failed\nScore 5: complete",
    "utf-8",
  );
});

const baseRun = (): EvalRunCapture => ({
  run_index: 1,
  passed: true,
  tool_history: [{ name: "get_snapshot", elapsed: 1.2 }],
  tokens_in: 1000,
  tokens_out: 500,
  num_turns: 3,
  duration_ms: 5000,
  cost_usd: 0.05,
  final_response: "AAPL is at $185 (retrieved this session via get_snapshot).",
  error: null,
  failures: [],
});

const baseConfig = (): JudgeConfig => ({
  dims: { data_grounding: 4, task_completion: 4 },
});

// Helper: mock the SDK query() to yield a single result message with judge XML
function mockJudgeResponse(text: string, costUsd = 0.31): void {
  mockedQuery.mockImplementation(async function* () {
    yield {
      type: "result",
      subtype: "success",
      result: text,
      total_cost_usd: costUsd,
      num_turns: 1,
      modelUsage: { "claude-opus-4-7": { inputTokens: 100, outputTokens: 50 } },
      session_id: "judge-fake",
    };
  } as never);
}

describe("gradeRun", () => {
  it("augments run with judge field on successful scoring", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: every number retrieved
task_completion: 4
task_completion_rationale: addressed request with minor gap
</judge_score>`);

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    expect(out.judge).toBeDefined();
    expect(out.judge?.scores.data_grounding).toBe(5);
    expect(out.judge?.scores.task_completion).toBe(4);
    expect(out.judge?.rationale.data_grounding).toContain("retrieved");
    expect(out.judge?.judge_cost_usd).toBe(0.31);
  });

  it("emits judge_below_threshold failure when score is below threshold", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 2
data_grounding_rationale: cited unverified prices
task_completion: 5
task_completion_rationale: complete
</judge_score>`);

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    expect(out.failures.length).toBeGreaterThan(0);
    const judgeFailure = out.failures.find((f) => f.type === "judge_below_threshold");
    expect(judgeFailure).toBeDefined();
    expect(judgeFailure!.expected).toContain("data_grounding >= 4");
    expect(judgeFailure!.actual).toContain("data_grounding = 2");
    expect(judgeFailure!.actual).toContain("cited unverified prices");
  });

  it("emits no judge_below_threshold when all dims pass", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    const judgeFailures = out.failures.filter((f) => f.type === "judge_below_threshold");
    expect(judgeFailures).toHaveLength(0);
  });

  it("treats malformed judge response as score=1 across all dims", async () => {
    mockJudgeResponse("Sorry, I cannot evaluate this response.");

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    expect(out.judge?.scores.data_grounding).toBe(1);
    expect(out.judge?.scores.task_completion).toBe(1);
    expect(out.judge?.rationale.data_grounding).toContain("parser failed");
    // Both dims fail threshold (4 vs 1)
    expect(out.failures.filter((f) => f.type === "judge_below_threshold")).toHaveLength(2);
  });

  it("clamps out-of-range scores to 1-5", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 7
data_grounding_rationale: tried to give 7 (invalid)
task_completion: 0
task_completion_rationale: tried to give 0 (invalid)
</judge_score>`);

    const out = await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
    });

    expect(out.judge?.scores.data_grounding).toBe(5);
    expect(out.judge?.scores.task_completion).toBe(1);
  });

  it("only scores the dims declared in judgeConfig", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 4
data_grounding_rationale: ok
task_completion: 4
task_completion_rationale: ok
</judge_score>`);

    const config: JudgeConfig = { dims: { data_grounding: 4 } };
    const out = await gradeRun(baseRun(), config, { calibrationDir: tmpCalibration });

    expect(out.judge?.scores.data_grounding).toBe(4);
    // task_completion was scored but config only requested data_grounding
    // Verify: no judge_below_threshold for task_completion
    const taskFailures = out.failures.filter(
      (f) => f.type === "judge_below_threshold" && f.expected.includes("task_completion"),
    );
    expect(taskFailures).toHaveLength(0);
  });

  it("throws when calibration file is missing", async () => {
    await rm(join(tmpCalibration, "data_grounding.md"));
    await expect(
      gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration }),
    ).rejects.toThrow();
  });

  it("includes calibration content in the judge prompt", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockedQuery.mock.calls[0][0] as { prompt: string };
    expect(callArgs.prompt).toContain("data_grounding rubric");
    expect(callArgs.prompt).toContain("task_completion rubric");
  });

  it("includes agent's final_response in the judge prompt", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

    const callArgs = mockedQuery.mock.calls[0][0] as { prompt: string };
    expect(callArgs.prompt).toContain("AAPL is at $185");
  });

  it("includes tool_history in the judge prompt", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

    const callArgs = mockedQuery.mock.calls[0][0] as { prompt: string };
    expect(callArgs.prompt).toContain("get_snapshot");
  });

  it("uses Opus 4.7 as default judge model", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), { calibrationDir: tmpCalibration });

    const callArgs = mockedQuery.mock.calls[0][0] as { options: { model: string } };
    expect(callArgs.options.model).toBe("claude-opus-4-7");
  });

  it("respects model override option", async () => {
    mockJudgeResponse(`<judge_score>
data_grounding: 5
data_grounding_rationale: ok
task_completion: 5
task_completion_rationale: ok
</judge_score>`);

    await gradeRun(baseRun(), baseConfig(), {
      calibrationDir: tmpCalibration,
      model: "claude-haiku-4-5-20251001",
    });

    const callArgs = mockedQuery.mock.calls[0][0] as { options: { model: string } };
    expect(callArgs.options.model).toBe("claude-haiku-4-5-20251001");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/eval/grader.test.ts`
Expected: FAIL — "Cannot find module '../../src/services/eval/grader.js'".

- [ ] **Step 3: Implement `gradeRun` and helpers**

Create `src/services/eval/grader.ts`:

```typescript
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

// Module-scoped cache: dim → calibration content (immutable per process).
const calibrationCache = new Map<string, Map<JudgeDim, string>>();

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
  const cached = calibrationCache.get(calibrationDir);
  if (cached) return cached;

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
  calibrationCache.set(calibrationDir, map);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/eval/grader.test.ts`
Expected: PASS — all 12 tests green.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `pnpm test`
Expected: full suite green.

- [ ] **Step 7: Commit**

```bash
cd /Users/michael/Proyectos/fundx
git add src/services/eval/grader.ts tests/eval/grader.test.ts
git commit -m "feat(eval): gradeRun module — LLM-judge with calibration loading + threshold checks"
```

---

## Task 4: Wire `gradeRun` into `runner.ts`

**Files:**
- Modify: `src/services/eval/runner.ts`
- Modify: `tests/eval-runner.test.ts`

- [ ] **Step 1: Verify baseline**

Run: `pnpm test -- tests/eval-runner.test.ts`
Expected: PASS. Note baseline test count.

- [ ] **Step 2: Write the failing assertions in `tests/eval-runner.test.ts`**

In `tests/eval-runner.test.ts`, find the existing `describe("runEvalCase", ...)` block. Add a `vi.mock` for `grader.js` near the top of the file (with other mocks):

```typescript
vi.mock("../src/services/eval/grader.js", () => ({
  gradeRun: vi.fn(async (run, _config, _opts) => ({
    ...run,
    judge: {
      scores: { data_grounding: 5 },
      rationale: { data_grounding: "ok" },
      judge_cost_usd: 0.31,
    },
  })),
}));
```

(Place near the existing `vi.mock` blocks. If the file doesn't have other vi.mock blocks for eval modules, add this as the first one.)

Add 4 new tests inside the `describe("runEvalCase", ...)` block:

```typescript
  it("calls gradeRun when case.expect.judge is configured", async () => {
    const { gradeRun } = await import("../src/services/eval/grader.js");
    const caseDef = makeTestCase({
      expect: {
        must_invoke: [],
        must_not_invoke: [],
        judge: { dims: { data_grounding: 4 } },
      },
    });

    await runEvalCase(caseDef, makeDeps());

    expect(vi.mocked(gradeRun)).toHaveBeenCalled();
  });

  it("does NOT call gradeRun when no judge configured", async () => {
    const { gradeRun } = await import("../src/services/eval/grader.js");
    vi.mocked(gradeRun).mockClear();

    const caseDef = makeTestCase({
      expect: {
        must_invoke: [],
        must_not_invoke: [],
      },
    });

    await runEvalCase(caseDef, makeDeps());

    expect(vi.mocked(gradeRun)).not.toHaveBeenCalled();
  });

  it("does NOT call gradeRun if run errored before grading", async () => {
    const { gradeRun } = await import("../src/services/eval/grader.js");
    vi.mocked(gradeRun).mockClear();

    const caseDef = makeTestCase({
      expect: {
        must_invoke: [],
        must_not_invoke: [],
        judge: { dims: { data_grounding: 4 } },
      },
    });

    // Override deps to make the run error
    const deps = makeDeps();
    deps.runChatTurn = vi.fn(async () => {
      throw new Error("simulated run error");
    });

    await runEvalCase(caseDef, deps).catch(() => {}); // tolerate error propagation

    expect(vi.mocked(gradeRun)).not.toHaveBeenCalled();
  });

  it("aggregates judge_cost_usd into judge_total_cost_usd on the case result", async () => {
    const caseDef = makeTestCase({
      runs: 2,
      expect: {
        must_invoke: [],
        must_not_invoke: [],
        judge: { dims: { data_grounding: 4 } },
      },
    });

    const result = await runEvalCase(caseDef, makeDeps());

    expect(result.judge_total_cost_usd).toBeDefined();
    expect(result.judge_total_cost_usd).toBeCloseTo(0.62, 2); // 2 runs × $0.31
  });
```

(Use the existing `makeTestCase` and `makeDeps` test helpers — adapt to whatever the file's existing patterns are.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- tests/eval-runner.test.ts`
Expected: FAIL on the new assertions.

- [ ] **Step 4: Modify `runner.ts` to wire in `gradeRun`**

In `src/services/eval/runner.ts`, add the import at the top:

```typescript
import { gradeRun } from "./grader.js";
```

Find the per-run loop (around line 63):

```typescript
    for (let i = 0; i < caseDef.runs; i++) {
      const capture = await runOnce(i + 1, caseDef, context, mcpServers, handle.fundName, deps);
      runs.push(evaluateRun(capture, caseDef.expect));
    }
```

Replace with:

```typescript
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
```

Find the `EvalCaseResult` return literal (around line 72):

```typescript
  return {
    id: caseDef.id,
    description: caseDef.description,
    passed: aggregate.passed,
    passing_runs: aggregate.passing_runs,
    total_runs: aggregate.total_runs,
    threshold: caseDef.threshold,
    runs,
    ...
  };
```

Add a new field at the end (before the closing `};`):

```typescript
    judge_total_cost_usd:
      runs.some((r) => r.judge !== undefined)
        ? runs.reduce((sum, r) => sum + (r.judge?.judge_cost_usd ?? 0), 0)
        : undefined,
```

(The `judge_total_cost_usd` field is optional — only set when at least one run was graded. Keeps cases without judge clean.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- tests/eval-runner.test.ts && pnpm test`
Expected: PASS — 4 new tests green + full suite green.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/michael/Proyectos/fundx
git add src/services/eval/runner.ts tests/eval-runner.test.ts
git commit -m "feat(eval): wire gradeRun into runEvalCase + aggregate judge_total_cost_usd"
```

---

## Task 5: Extend `report.ts` with judge surface

**Files:**
- Modify: `src/services/eval/report.ts`
- Modify: `tests/eval-report.test.ts` (if exists; otherwise inline assertion)

- [ ] **Step 1: Find the report builder + terminal renderer**

Run: `grep -nE "export (function|const)" /Users/michael/Proyectos/fundx/src/services/eval/report.ts`

Note `buildReport` and `renderTerminal` line numbers.

- [ ] **Step 2: Extend `buildReport` to compute `total_judge_cost_usd`**

Find the `buildReport` function. It currently aggregates `total_cost_usd` from cases. Add an analogous aggregation for judge cost. Modify the return to include:

```typescript
    total_judge_cost_usd:
      cases.some((c) => c.judge_total_cost_usd !== undefined)
        ? cases.reduce((sum, c) => sum + (c.judge_total_cost_usd ?? 0), 0)
        : undefined,
```

- [ ] **Step 3: Extend `renderTerminal` to surface judge scores per case**

Find the `renderTerminal` function. It currently emits one line per case, e.g.:

```
+ mvp-portfolio-review-spanish  PASS 3/3  67.2s  $0.31
```

After that line, when `caseResult.runs[].judge` exists, append a sub-line. Find the per-case rendering loop and add:

```typescript
    if (caseResult.judge_total_cost_usd !== undefined) {
      // Average scores across runs that have judge data
      const judgeRuns = caseResult.runs.filter((r) => r.judge !== undefined);
      if (judgeRuns.length > 0) {
        const dims = Object.keys(judgeRuns[0].judge!.scores) as JudgeDim[];
        const avgScores = dims.map((dim) => {
          const sum = judgeRuns.reduce((s, r) => s + (r.judge!.scores[dim] ?? 0), 0);
          const avg = sum / judgeRuns.length;
          return `${dim}=${avg.toFixed(1)}`;
        }).join(" ");
        lines.push(`    judge: ${avgScores} ($${caseResult.judge_total_cost_usd.toFixed(2)})`);
      }
    }
```

(Adapt the `lines.push` pattern to match the file's existing terminal-rendering convention. If `renderTerminal` builds a string differently, integrate similarly.)

Also at the top of `report.ts`, ensure `JudgeDim` is imported:

```typescript
import type { JudgeDim, EvalCaseResult, EvalReport } from "../../types.js";
```

- [ ] **Step 4: Add or extend a test in `tests/eval-report.test.ts`**

If `tests/eval-report.test.ts` exists, add this test inside the existing describe block:

```typescript
import { buildReport, renderTerminal } from "../src/services/eval/report.js";

it("surfaces judge_total_cost_usd in report when at least one case had judge", () => {
  const report = buildReport({
    timestamp: "2026-05-01T00:00:00Z",
    model: "claude-sonnet-4-6",
    cases: [
      {
        id: "judged-case",
        description: "test",
        passed: true,
        passing_runs: 3,
        total_runs: 3,
        threshold: 2,
        runs: [],
        total_duration_ms: 1000,
        total_cost_usd: 0.5,
        judge_total_cost_usd: 0.91,
      },
      {
        id: "non-judged-case",
        description: "test",
        passed: true,
        passing_runs: 3,
        total_runs: 3,
        threshold: 2,
        runs: [],
        total_duration_ms: 1000,
        total_cost_usd: 0.3,
      },
    ],
  });

  expect(report.total_judge_cost_usd).toBe(0.91);
});

it("renders judge sub-line in terminal output when case has judge data", () => {
  const out = renderTerminal([
    {
      id: "judged-case",
      description: "test",
      passed: true,
      passing_runs: 3,
      total_runs: 3,
      threshold: 2,
      runs: [
        {
          run_index: 1,
          passed: true,
          tool_history: [],
          tokens_in: 100,
          tokens_out: 50,
          num_turns: 1,
          duration_ms: 1000,
          cost_usd: 0.05,
          final_response: "ok",
          error: null,
          failures: [],
          judge: {
            scores: { data_grounding: 5, task_completion: 4 },
            rationale: { data_grounding: "ok", task_completion: "ok" },
            judge_cost_usd: 0.31,
          },
        },
      ],
      total_duration_ms: 1000,
      total_cost_usd: 0.05,
      judge_total_cost_usd: 0.31,
    },
  ]);

  expect(out).toContain("judge:");
  expect(out).toContain("data_grounding=5.0");
  expect(out).toContain("task_completion=4.0");
});
```

If `tests/eval-report.test.ts` doesn't exist, create it with the imports + 2 tests above.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/michael/Proyectos/fundx
git add src/services/eval/report.ts tests/eval-report.test.ts
git commit -m "feat(eval): surface judge scores per case + total_judge_cost_usd in report"
```

---

## Task 6: Add `judge:` block to 3 opt-in cases

**Files:**
- Modify: `tests/eval/cases/mvp-portfolio-review-spanish.yaml`
- Modify: `tests/eval/cases/no-hallucinated-prices.yaml`
- Modify: `tests/eval/cases/mvp-market-regime-spanish.yaml`

- [ ] **Step 1: Inspect existing YAML structure**

Run: `cat /Users/michael/Proyectos/fundx/tests/eval/cases/mvp-portfolio-review-spanish.yaml`

Note the existing `expect:` block structure (which fields are present, indentation).

- [ ] **Step 2: Add judge block to `mvp-portfolio-review-spanish.yaml`**

In `tests/eval/cases/mvp-portfolio-review-spanish.yaml`, find the `expect:` block. Add a `judge:` sub-key as the LAST entry of the expect block, with this structure (preserve existing indentation, typically 2 spaces):

```yaml
  judge:
    dims:
      data_grounding: 4
      task_completion: 4
```

So the `expect:` block ends like:
```yaml
expect:
  must_invoke: [...]
  must_not_invoke: [...]
  max_turns: 30
  judge:
    dims:
      data_grounding: 4
      task_completion: 4
```

- [ ] **Step 3: Add judge block to `no-hallucinated-prices.yaml`**

In `tests/eval/cases/no-hallucinated-prices.yaml`, add to its `expect:` block:

```yaml
  judge:
    dims:
      data_grounding: 5
```

(Only `data_grounding` because the case is specifically about anti-hallucination, and `task_completion` is less critical here. High threshold (5) — this is the canary.)

- [ ] **Step 4: Add judge block to `mvp-market-regime-spanish.yaml`**

In `tests/eval/cases/mvp-market-regime-spanish.yaml`, add to its `expect:` block:

```yaml
  judge:
    dims:
      data_grounding: 4
      task_completion: 4
```

- [ ] **Step 5: Verify YAML parses (eval loader doesn't reject)**

Run: `pnpm dev -- eval --filter mvp-portfolio-review-spanish --runs 1`

Expected: case loads (no YAML parse errors). The actual run will invoke the judge — cost ~$0.30-0.50. Verify in output that the judge sub-line appears.

If YAML parse fails: check indentation (2-space, not tab) and that `judge:` is correctly nested inside `expect:`.

If you want to skip the real run (to save cost during plan execution), instead validate the YAML loader directly:

```bash
pnpm test -- tests/eval-loader.test.ts
```

(This won't invoke the judge, just validates schema.)

- [ ] **Step 6: Commit**

```bash
cd /Users/michael/Proyectos/fundx
git add tests/eval/cases/mvp-portfolio-review-spanish.yaml tests/eval/cases/no-hallucinated-prices.yaml tests/eval/cases/mvp-market-regime-spanish.yaml
git commit -m "feat(eval): opt-in 3 cases (portfolio-review, no-hallucinated-prices, market-regime) to LLM-judge"
```

---

## Task 7: Smoke verification — real MVP eval + negative test

**Files:**
- Manual: real MVP eval run
- Manual: 1 negative test (force fail) on `mvp-portfolio-review-spanish` to verify error path
- Modify: `docs/superpowers/audit-1b/audit-log.md`

- [ ] **Step 1: Run MVP eval suite**

```bash
cd /Users/michael/Proyectos/fundx
pnpm dev -- eval --filter mvp- --json /tmp/phase3b-eval.json
```

Verify all 8 cases PASS:

```bash
python3 -c "
import json
with open('/tmp/phase3b-eval.json') as f:
    data = json.load(f)
print(f'Summary: {data[\"summary\"]}')
print(f'Total agent cost: \${data[\"total_cost_usd\"]:.2f}')
print(f'Total judge cost: \${data.get(\"total_judge_cost_usd\", 0):.2f}')
print()
for c in data['cases']:
    judge_total = c.get('judge_total_cost_usd')
    judge_str = f' judge: \${judge_total:.2f}' if judge_total is not None else ''
    print(f'  {c[\"id\"]}: passed={c[\"passed\"]} ({c[\"passing_runs\"]}/{c[\"total_runs\"]}) \${c[\"total_cost_usd\"]:.2f}{judge_str}')
"
```

Expected:
- 8 cases passed
- 3 cases (portfolio-review, no-hallucinated-prices, market-regime) have `judge_total_cost_usd` populated
- `total_judge_cost_usd` ≈ $2-3 (3 cases × 3 runs × ~$0.30)

If any case FAILS due to judge_below_threshold: investigate. The judge may be too strict with current calibration. Either:
- Lower the threshold for that case (e.g., from 4 to 3)
- Refine the calibration markdown to be more lenient at the higher scores
- Accept the failure and treat it as a real signal (the agent's output was actually below quality)

Capture cost for audit log.

- [ ] **Step 2: Negative test — force a judge failure**

This verifies the error path works end-to-end. Edit `tests/eval/cases/mvp-portfolio-review-spanish.yaml` and bump the data_grounding threshold to 5 (artificially high):

```yaml
  judge:
    dims:
      data_grounding: 5    # was 4 — bump to 5 to force fail
      task_completion: 4
```

Run that single case:

```bash
pnpm dev -- eval --case mvp-portfolio-review-spanish --runs 1 --json /tmp/phase3b-negative.json
```

Verify the case FAILS with `judge_below_threshold` failure. Inspect the JSON:

```bash
python3 -c "
import json
with open('/tmp/phase3b-negative.json') as f:
    data = json.load(f)
case = data['cases'][0]
print(f'passed: {case[\"passed\"]}')
for run in case['runs']:
    for f in run['failures']:
        if f['type'] == 'judge_below_threshold':
            print(f'  failure: {f[\"expected\"]} | actual: {f[\"actual\"][:120]}')
"
```

Expected: case shows `passed: false` with at least one `judge_below_threshold` failure that includes the expected `data_grounding >= 5` and the actual score < 5 + rationale.

**Revert the threshold back to 4** before continuing:

```bash
# Edit tests/eval/cases/mvp-portfolio-review-spanish.yaml: data_grounding back to 4
```

- [ ] **Step 3: Update audit log**

Append to `docs/superpowers/audit-1b/audit-log.md`:

```markdown

---

## Phase 3b verification — 2026-05-01

| Test | Result | Cost | Notes |
|---|---|---:|---|
| MVP eval suite (with judge on 3 cases) | 8/8 PASS | $X.XX agent + $Y.YY judge | All 3 judged cases passed thresholds (data_grounding=4, task_completion=4). |
| Negative test (force data_grounding=5 on portfolio-review) | FAIL as expected | $Z.ZZ | judge_below_threshold failure correctly emitted with rationale; threshold reverted after. |
| **Phase 3b cumulative** | | $XX.XX | |
```

Fill in actual costs.

- [ ] **Step 4: Commit verification log**

```bash
cd /Users/michael/Proyectos/fundx
git add docs/superpowers/audit-1b/audit-log.md
git commit -m "audit(phase-3b): MVP eval with judge + negative test verification"
```

---

## Task 8: Documentation + roadmap status

**Files:**
- Modify: `tests/eval/README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md`

- [ ] **Step 1: Update `tests/eval/README.md`**

If `tests/eval/README.md` doesn't exist, create it. Otherwise append a new section:

```markdown
## LLM-judge layer (Phase 3b, 2026-05-01)

Cases can opt into an LLM-as-judge quality grader by adding a `judge:` block
to their `expect:` section:

```yaml
expect:
  must_invoke: ["..."]
  judge:
    dims:
      data_grounding: 4    # threshold (1-5)
      task_completion: 4
```

The judge runs **after** mechanism asserts (`must_invoke`, etc.) and **only**
when the run did not error. It calls Opus 4.7 with calibrated rubrics from
`tests/eval/calibration/<dim>.md`. Scores below threshold emit
`judge_below_threshold` failures with the dim, threshold, actual score, and
the judge's rationale.

### Available dimensions

- **`data_grounding`** — adherence to anti-hallucination (every cited number
  from a tool call this session, not memory).
- **`task_completion`** — how completely the agent addressed the user's
  actual request.

### Adding new dimensions

1. Add to the `judgeDimSchema` enum in `src/types.ts`.
2. Create `tests/eval/calibration/<new_dim>.md` with 5 score examples (1, 2,
   3, 4, 5).
3. Cases can now declare `<new_dim>: <threshold>` in their judge block.

### Updating calibration

Edit `tests/eval/calibration/<dim>.md` directly. The grader caches calibration
per process, so a fresh `pnpm test` or `pnpm dev -- eval` picks up changes.
The first MVP eval run after a calibration change should be reviewed manually
for unexpected score shifts.
```

- [ ] **Step 2: Update `CLAUDE.md`**

In `CLAUDE.md`, find the "Prompt eval harness" section. Add a one-line mention after the existing description:

```markdown
Cases can also opt into an LLM-as-judge quality layer (Phase 3b) by adding a `judge:` block to their `expect:` section — see `tests/eval/README.md` and `src/services/eval/grader.ts`.
```

- [ ] **Step 3: Update roadmap status log**

In `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md`, find the "Status log" table at the bottom. Append:

```markdown
| 2026-05-01 | Phase 3b complete (G5 v1 minimal): LLM-judge eval grader. Opus 4.7 scores opt-in cases against calibrated rubrics (`data_grounding`, `task_completion`). 3 cases initially opted in (portfolio-review, no-hallucinated-prices, market-regime). New components: `src/services/eval/grader.ts` (12 unit tests), 2 calibration markdown files. Schema additions on `EvalAssertions` (judge), `EvalRunCapture` (judge result), `EvalCaseResult` (judge_total_cost_usd), `EvalReport` (total_judge_cost_usd). `judge_below_threshold` failure type. Total cost ~$XX (real eval + negative test). MVP eval 8/8 PASS post-judge. Phase 4 (G6 operational observability) next; Phase 1c (75% soft warning) deferred. See [phase-3b spec](./2026-05-01-harness-phase-3b-judge-design.md). |
```

(Fill in the actual `$XX` cost from Task 7.)

- [ ] **Step 4: Commit docs**

```bash
cd /Users/michael/Proyectos/fundx
git add tests/eval/README.md CLAUDE.md docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md
git commit -m "docs: phase 3b complete — LLM-judge eval grader (G5 v1)"
```

- [ ] **Step 5: Final test sweep**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS, 0 errors, build succeeds.

---

## Self-Review Checklist (before marking phase complete)

After all 8 tasks complete:

- [ ] `pnpm test` is green (full suite).
- [ ] `pnpm typecheck` is clean.
- [ ] `pnpm build` succeeds.
- [ ] `git log --oneline -10` shows ~8 commits with descriptive messages.
- [ ] Real MVP eval ran with judge on 3 cases — 8/8 PASS.
- [ ] Negative test verified `judge_below_threshold` error path works.
- [ ] `CLAUDE.md` reflects the new LLM-judge mechanism.
- [ ] `tests/eval/README.md` documents the `judge:` block.
- [ ] Roadmap status log has Phase 3b completion entry with real cost.
- [ ] Threshold reverted from 5 back to 4 on `mvp-portfolio-review-spanish` after negative test.

If any item is not true, the phase is **not** done.
