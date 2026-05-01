# Phase 3b — LLM-as-Judge Eval Grader (G5 v1)

**Date:** 2026-05-01
**Status:** Approved (design)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Closes gap:** G5 (v1 minimal scope) — eval grader is mechanism-based; quality regressions slip past
**Pattern enforced:** #12 (outcome-based evals with calibrated LLM-as-judge per Anthropic *Harness Design for Long-Running Apps*)

> **Scope split decision (2026-04-30):** Phase 3 from the roadmap covered both G4 (handoff) and G5 (eval grader). Split into Phase 3a (G4, complete) and Phase 3b (this spec — G5).

---

## Goal

Add an LLM-as-judge layer to the existing eval harness that scores agent output against a calibrated rubric. Cases opt in via a new `judge:` block in their YAML; the grader runs after mechanism asserts and emits `judge_below_threshold` failures when scores fall below per-dimension thresholds. Initial scope: 2 universal dimensions (`data_grounding`, `task_completion`), 3 opt-in cases, Opus 4.7 as judge model.

The mechanism asserts (`must_invoke`, `must_not_invoke`, `max_turns`, `max_tokens_out`) stay unchanged. The judge is **additive** — runs after mechanism asserts pass, scores quality dimensions that mechanism asserts cannot evaluate.

## Non-goals

- **Per-case custom rubrics.** v1 uses 2 fixed dimensions globally. Per-case overrides deferred to a future phase if needed.
- **`pass@k` vs `pass^k` separate reporting.** The current aggregate threshold (passing_runs >= threshold) already covers this need.
- **Self-evaluation.** Judge model is intentionally Opus 4.7, NOT the same Sonnet 4.6 instance running the eval, to avoid the documented self-grading bias.
- **Judge on every case.** Mechanism-only cases (the existing 8 MVP) stay mechanism-only. Judge is opt-in via YAML.
- **Real-time judge in production sessions.** This is for the eval harness only, not for `runFundSession`.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│  src/services/eval/runner.ts (orchestration)                        │
│                                                                      │
│  for each case:                                                     │
│    for each run (1..K):                                             │
│      run = await runChatTurn() / runAsk()                           │
│      run = evaluateRun(run, case.assertions)  ← existing, mechanism │
│      ★ if case.assertions.judge && !run.error:                      │
│          run = await gradeRun(run, case.assertions.judge)  ← NEW    │
│      collect run                                                    │
│    aggregate runs → CaseAggregate (judge_total_cost_usd added)      │
│                                                                      │
│  ┌──── grader.ts (new module) ────────────────────────────────┐    │
│  │  gradeRun(run, judgeConfig):                               │    │
│  │    1. Load global calibration for each dim (cached)        │    │
│  │    2. Build judge prompt (rubric + examples + agent output)│    │
│  │    3. Call query() with model=opus + maxTurns=1 + cap=$5   │    │
│  │    4. Parse <judge_score> XML response                     │    │
│  │    5. Append judge_below_threshold failures if below       │    │
│  │    6. Return augmented run with judge.scores               │    │
│  └─────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────┘
```

---

## Component 1 — Schema additions (`src/types.ts`)

### Judge config (case opt-in)

```typescript
export const judgeDimSchema = z.enum(["data_grounding", "task_completion"]);
export type JudgeDim = z.infer<typeof judgeDimSchema>;

export const judgeConfigSchema = z.object({
  /** Per-dimension threshold (1-5). A run passes the judge if every declared
   *  dimension scores >= its threshold. */
  dims: z.record(judgeDimSchema, z.number().int().min(1).max(5)),
});
export type JudgeConfig = z.infer<typeof judgeConfigSchema>;
```

Add `judge?: JudgeConfig` to existing `evalAssertionsSchema`.

### Judge result (per run)

```typescript
export const judgeResultSchema = z.object({
  scores: z.record(judgeDimSchema, z.number().int().min(1).max(5)),
  /** One-sentence justification per dim, from the judge. */
  rationale: z.record(judgeDimSchema, z.string()),
  /** Cost of the judge call itself (USD), tracked separately from run cost. */
  judge_cost_usd: z.number().min(0),
});
export type JudgeResult = z.infer<typeof judgeResultSchema>;
```

Add `judge?: JudgeResult` to existing `evalRunCaptureSchema`.

### New failure type

`EvalFailure` discriminated union gains:

```typescript
{
  type: "judge_below_threshold";
  detail: string;       // "data_grounding scored below threshold"
  expected: string;     // "data_grounding >= 4"
  actual: string;       // "data_grounding = 2: 'cited price 4500 not retrieved this session'"
}
```

### Cost aggregation on case result

Add `judge_total_cost_usd?: number` (sum of `run.judge.judge_cost_usd`) to `EvalCaseResult`.

### Backward-compat

All additions are `optional()`. The 8 MVP cases without `judge:` blocks continue to parse and run unchanged. Existing JSON reports re-parse fine.

---

## Component 2 — `grader.ts` module

**Location:** `src/services/eval/grader.ts` (new)

### Public signature

```typescript
import type { EvalRunCapture, JudgeConfig } from "../../types.js";

export interface GradeRunOptions {
  /** Override judge model. Defaults to "claude-opus-4-7". */
  model?: string;
  /** Path to calibration directory. Defaults to "tests/eval/calibration". */
  calibrationDir?: string;
  /** AbortSignal for the underlying SDK call. */
  signal?: AbortSignal;
}

/** Run the LLM-as-judge against an EvalRunCapture. Returns the run augmented
 *  with `judge` field populated and any judge_below_threshold failures appended.
 *  Pure async — no global state, no mutation of input. */
export async function gradeRun(
  run: EvalRunCapture,
  judgeConfig: JudgeConfig,
  options?: GradeRunOptions,
): Promise<EvalRunCapture>;
```

### Internal pipeline

```
gradeRun(run, judgeConfig)
  ├─ 1. loadCalibration(dims) → Map<JudgeDim, string>      [cached module-scope]
  ├─ 2. buildJudgePrompt(run, judgeConfig, calibration) → string
  ├─ 3. callJudge(prompt, model) → { scores, rationale, cost_usd }
  ├─ 4. checkThresholds(scores, judgeConfig.dims) → JudgeFailure[]
  └─ 5. return { ...run, judge: result, failures: [...run.failures, ...new] }
```

### `loadCalibration(dims)` — internal

Reads `tests/eval/calibration/<dim>.md` for each dim in the judgeConfig. Returns `Map<JudgeDim, string>`. Cached in module scope (calibration files immutable per process). On read failure → throws (calibration is required, fail-fast).

### `buildJudgePrompt(run, judgeConfig, calibration)` — internal

Builds a single prompt string with this structure:

```
You are an evaluator scoring an AI agent's output against a rubric.

# Task that the agent received
<task>
{run.prompt}
</task>

# Agent's final response
<agent_output>
{run.final_response}
</agent_output>

# Tools the agent invoked (chronological)
<tool_history>
{tool_history as YAML list with names + elapsed times}
</tool_history>

# Dimensions to score (1-5 scale)

## data_grounding
{contents of tests/eval/calibration/data_grounding.md}

## task_completion
{contents of tests/eval/calibration/task_completion.md}

# Output format

Score each dimension 1-5 based on the calibration. Provide one-sentence
rationale per dimension.

<judge_score>
data_grounding: <1-5>
data_grounding_rationale: <one sentence>
task_completion: <1-5>
task_completion_rationale: <one sentence>
</judge_score>
```

### `callJudge(prompt, model)` — internal

Uses the Claude Agent SDK's `query()` (already imported elsewhere) with:
- `model: "claude-opus-4-7"` (default)
- `maxTurns: 1` — single-shot scoring, no tool use
- `maxBudgetUsd: 5` — hard cap to prevent runaway
- No `mcpServers`, no `agents`, no hooks — pure text-in/text-out

Captures `cost_usd` from the result.

### `parseJudgeResponse(text)` — internal

Regex-based parser for the `<judge_score>` XML block. Extracts each dim's score (1-5 int) and rationale. On parse failure → throws (caller catches and treats as judge_below_threshold across all dims with score=1).

### `checkThresholds(scores, dimsConfig)` — internal

For each dim in dimsConfig:
- If `scores[dim] < dimsConfig[dim]` → emit `judge_below_threshold` failure with detail explaining which dim, expected vs actual, and the rationale.

### Error handling

| Failure mode | Behavior |
|---|---|
| Calibration file missing | Throw — fail loud (config error in repo) |
| Judge API call fails (network, auth) | Re-throw — runner.ts decides how to handle |
| Judge returns malformed XML | Catch parser error; treat as judge_below_threshold across all dims with score=1 + rationale="parser failed: <message>" |
| Judge times out (10s default) | Re-throw |
| Score outside 1-5 range | Clamp to 1-5 + log warning |

The function never silently swallows. Fail-closed: if the judge can't score, the run fails the judge gate.

---

## Component 3 — Runner integration (`runner.ts`)

In `runEvalCase` (around the per-run loop):

```typescript
for (const runIdx of runs) {
  let run = await captureRun(...);
  run = evaluateRun(run, case.assertions);  // existing

  // NEW: LLM-judge after mechanism asserts pass and run didn't error
  if (case.assertions.judge && !run.error) {
    try {
      run = await gradeRun(run, case.assertions.judge);
    } catch (err) {
      // Judge call failed (not a low-score outcome) — log and treat as judge failure
      console.warn(`[eval-grader] gradeRun threw for case ${case.id}:`, err instanceof Error ? err.message : err);
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

  caseRuns.push(run);
}
```

After per-run loop, sum `run.judge?.judge_cost_usd ?? 0` into the case aggregate's new `judge_total_cost_usd` field.

---

## Component 4 — Report extension (`report.ts`)

### Terminal report

After existing per-case PASS/FAIL line, when judge ran, add a sub-line:

```
+ mvp-portfolio-review-spanish  PASS 3/3  67.2s  $0.31  judge: data_grounding=4.3 task_completion=4.7 ($0.91)
```

### JSON report

Each `EvalCaseResult` gains:
- `judge_total_cost_usd: number | undefined`

Each `EvalRunCapture` in `runs[]` gains:
- `judge: JudgeResult | undefined`

The aggregate `total_cost_usd` at the top of the report stays as the agent run cost. The judge cost is separate, surfaced as `total_judge_cost_usd: number` at the top level (sum across all cases).

---

## Component 5 — Calibration content

### `tests/eval/calibration/data_grounding.md`

```markdown
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
```

### `tests/eval/calibration/task_completion.md`

```markdown
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
```

---

## Component 6 — Initial opt-in cases

Three high-value cases gain `judge:` blocks:

| Case file | dims + thresholds | Why |
|---|---|---|
| `mvp-portfolio-review-spanish.yaml` | `task_completion: 4`, `data_grounding: 4` | Portfolio review quality is inherently subjective. Mechanism asserts only check that `get_positions` was called — they can't tell good from bad review. |
| `no-hallucinated-prices.yaml` | `data_grounding: 5` | Case literally tests anti-hallucination. data_grounding IS the test. High bar (5). |
| `mvp-market-regime-spanish.yaml` | `task_completion: 4`, `data_grounding: 4` | Regime classification quality requires judgment — was the regime call data-supported? Was the explanation actionable? |

After Phase 3b ships, future cases can opt in by adding a `judge:` block. Easy to expand.

---

## Definition of Done

### Unit-test level

1. **`tests/eval/grader.test.ts`** (~12 tests):
   - `parseJudgeResponse` extracts both dims correctly
   - `parseJudgeResponse` throws on missing dim
   - `parseJudgeResponse` clamps out-of-range scores to 1-5
   - `checkThresholds` emits failure when score < threshold
   - `checkThresholds` emits no failure when score >= threshold
   - `checkThresholds` handles missing dim in scores (treats as score=1)
   - `loadCalibration` reads correct file per dim
   - `loadCalibration` throws if calibration file missing
   - `loadCalibration` caches result (call twice, only one read)
   - `gradeRun` end-to-end with mocked SDK (assert correct prompt structure)
   - `gradeRun` augments run with `judge` field on success
   - `gradeRun` malformed judge response → all dims score=1 + parser-failed rationale

2. **Schema tests** in existing `tests/eval-types.test.ts`:
   - `judgeConfigSchema` parses valid config
   - `judgeConfigSchema` rejects scores outside 1-5
   - `evalAssertionsSchema` accepts case without judge (back-compat)
   - `evalAssertionsSchema` accepts case with judge

3. **Runner integration** in `tests/eval-runner.test.ts`:
   - `runEvalCase` calls `gradeRun` when `case.assertions.judge` is set
   - `runEvalCase` does NOT call `gradeRun` when no judge configured
   - `runEvalCase` does NOT call `gradeRun` if run errored before grading
   - `EvalCaseResult.judge_total_cost_usd` is the sum of `run.judge.judge_cost_usd`

4. **Existing tests still green** (`pnpm test`).

### Integration level

5. **MVP eval suite runs successfully** with 3 cases now opting into judge:
   - All 8 cases still PASS
   - The 3 with judge get scored 4-5 on both dims, pass thresholds
   - JSON report shows `judge` block on the 3 opt-in cases, absent on others
   - `judge_total_cost_usd` summed correctly per case
   - Total eval cost ~$5-6 (was ~$3, +$2-3 judge overhead)

6. **Negative test**: artificially set `data_grounding: 5` on `mvp-portfolio-review-spanish` → case should FAIL with `judge_below_threshold`. Verify the failure message includes dim + threshold + actual + rationale. Revert after.

### Documentation

7. `tests/eval/README.md` documents the `judge:` block + the 2 dimensions + how to update calibration.
8. `CLAUDE.md` "Prompt eval harness" section mentions LLM-judge.
9. Roadmap status log entry: "Phase 3b complete: LLM-judge eval grader (G5 v1)".

---

## Risks

| Risk | Mitigation |
|---|---|
| Calibration drift — judge inconsistency across runs | Same model + same calibration file → reproducible. Track variance over time via CI nightly runs. If variance > 0.5 across 5 runs of same input, expand calibration corpus. |
| Judge cost surprise (Opus 4.7 more expensive than estimated) | Each run logs `judge_cost_usd` separately. Eval summary surfaces total. Hard cap via `maxBudgetUsd: 5` per judge call. Low absolute risk (~$3/eval). |
| Judge as bottleneck — slows eval runs | Judge runs sequentially after each run completes. ~5-10s per call × 9 calls = ~1 min added per eval suite. Acceptable. |
| False positives (judge fails but human disagrees) | Initial deployment has only 3 cases. Manual review of first ~10 eval runs to calibrate thresholds. If pattern emerges, lower thresholds OR refine calibration examples. |
| Calibration files get stale over time | The `loadCalibration` function fail-loud on missing files catches the obvious case (renamed/deleted dim without updating calibration). |
| Schema migration breaks back-compat | All new fields `optional()`. Existing 8 MVP cases without `judge:` continue to parse and run unchanged. |
| Judge invocation fails (auth/network) and runner crashes the whole eval | `runner.ts` catches `gradeRun` throws and marks the run as failed via `judge_below_threshold` rather than aborting. Runner continues to next case. |

---

## Effort

**~3 days** distributed:

| Component | Days |
|---|---:|
| Calibration markdown files | 0.25 |
| Schema additions + 4 unit tests | 0.25 |
| `gradeRun` + helpers + ~12 unit tests | 1.0 |
| Runner integration + 4 assertions | 0.5 |
| Report extension (terminal + JSON) | 0.25 |
| Add `judge:` block to 3 case YAMLs + verify | 0.25 |
| MVP eval real run (verify 8/8 PASS + costs + negative test) | 0.25 |
| Docs (`tests/eval/README.md` + CLAUDE.md + roadmap) | 0.25 |
| **Total** | **~3** |

## Cost expectation

| Item | Cost |
|---|---:|
| MVP eval re-run (with judge) | ~$5-6 |
| Calibration tuning re-runs | $5-10 |
| Negative test (force fail + verify) | ~$2 |
| **Total expected** | **$12-18** |

---

## Implementation order (TDD bite-sized for `writing-plans`)

1. **Calibration markdown files** (no code, just content). Commit.
2. **Schema additions** in `src/types.ts` + back-compat tests. Commit.
3. **`gradeRun` + helpers** in `grader.ts` (TDD, isolated unit). Commit.
4. **Runner integration** — wire `gradeRun` into `runner.ts` + tests. Commit.
5. **Report extension** — surface judge scores in terminal + JSON. Commit.
6. **Opt-in 3 cases** — add `judge:` blocks to the 3 YAMLs. Commit.
7. **MVP eval verification** — real run + audit-log entry + negative test. Commit.
8. **Docs** — `tests/eval/README.md` + CLAUDE.md + roadmap status log. Commit.

8 commits total.
