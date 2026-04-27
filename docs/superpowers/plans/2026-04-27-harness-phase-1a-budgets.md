# Phase 1a — Execution Budgets (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve a per-session-type `{ maxTurns, maxUsd }` budget through a fund→global→defaults cascade, pass it to the SDK, persist the resolved budget in the session log, and produce a distinguished Telegram alert when the SDK hard-kills on budget.

**Architecture:** All new logic is **pure functions** in `src/services/session.service.ts` (resolver + alert builder). The only I/O change is wiring two values into the existing `runAgentQuery` call and persisting one new field. The SDK already enforces `maxTurns` and `maxBudgetUsd` natively — this plan does not introduce any middleware, hooks, or stream interception. Backward-compat is preserved by leaving the legacy `globalConfig.max_budget_usd` field in place (it becomes effectively superseded by the new cascade for autonomous sessions).

**Tech Stack:** TypeScript (strict ESM), Zod (runtime validation), Vitest (test framework), pnpm (package manager). Tests in `tests/`, source in `src/`. Imports use `.js` extensions for ESM compat.

**Spec:** [`docs/superpowers/specs/2026-04-27-harness-phase-1a-budgets-design.md`](../specs/2026-04-27-harness-phase-1a-budgets-design.md)

---

## File Structure

| File | Type | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | Add `Budget`, `FundBudgetConfig` schemas; extend `fundConfigSchema`, `globalConfigSchema`, and `sessionLogV2Schema` |
| `src/services/session.service.ts` | Modify | Add `resolveBudget`, `DEFAULTS_BY_SESSION_TYPE`, `FALLBACK_DEFAULT`, `buildBudgetAlert`; wire into `runFundSession` |
| `tests/budget.test.ts` | Create | Unit tests for `resolveBudget` cascade and `buildBudgetAlert` formatting |
| `CLAUDE.md` | Modify | One-line mention of the budget cascade in "Configuration" section |

No new files in `src/` (no separate `budget.service.ts` — the resolver is small enough to live alongside `runFundSession` which is its only caller).

---

## Task 1: Schemas

**Files:**
- Modify: `src/types.ts:159–212` (FundConfig), `src/types.ts:258–290` (GlobalConfig), `src/types.ts:583–596` (SessionLogV2)
- Test: `tests/budget.test.ts` (new file)

- [ ] **Step 1: Write the failing test for schema parsing**

Create `tests/budget.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  budgetSchema,
  fundBudgetConfigSchema,
  fundConfigSchema,
  globalConfigSchema,
  sessionLogV2Schema,
} from "../src/types.js";

describe("budgetSchema", () => {
  it("parses a valid budget", () => {
    const out = budgetSchema.parse({ maxTurns: 40, maxUsd: 5 });
    expect(out).toEqual({ maxTurns: 40, maxUsd: 5 });
  });

  it("rejects non-positive turns", () => {
    expect(() => budgetSchema.parse({ maxTurns: 0, maxUsd: 5 })).toThrow();
    expect(() => budgetSchema.parse({ maxTurns: -1, maxUsd: 5 })).toThrow();
  });

  it("rejects non-positive usd", () => {
    expect(() => budgetSchema.parse({ maxTurns: 40, maxUsd: 0 })).toThrow();
    expect(() => budgetSchema.parse({ maxTurns: 40, maxUsd: -1 })).toThrow();
  });

  it("rejects non-integer turns", () => {
    expect(() => budgetSchema.parse({ maxTurns: 1.5, maxUsd: 5 })).toThrow();
  });
});

describe("fundBudgetConfigSchema", () => {
  it("accepts undefined", () => {
    const out = fundBudgetConfigSchema.parse(undefined);
    expect(out).toBeUndefined();
  });

  it("accepts a default-only block", () => {
    const out = fundBudgetConfigSchema.parse({
      default: { maxTurns: 30, maxUsd: 4 },
    });
    expect(out?.default).toEqual({ maxTurns: 30, maxUsd: 4 });
  });

  it("accepts perSessionType overrides", () => {
    const out = fundBudgetConfigSchema.parse({
      perSessionType: {
        "pre-market": { maxTurns: 40, maxUsd: 5 },
        "post-market": { maxTurns: 60, maxUsd: 7 },
      },
    });
    expect(out?.perSessionType?.["pre-market"]).toEqual({ maxTurns: 40, maxUsd: 5 });
  });
});

describe("fundConfigSchema with budget", () => {
  it("accepts a fund config without budget (back-compat)", () => {
    const minimal = {
      fund: { name: "f", display_name: "F", created: "2026-04-27" },
      capital: { initial: 1000 },
      objective: { type: "growth", multiplier: 2 },
      risk: { max_position_pct: 25, max_drawdown_pct: 25 },
      universe: { kind: "preset", preset: "sp100" },
      schedule: { sessions: {} },
    };
    const out = fundConfigSchema.parse(minimal);
    expect(out.budget).toBeUndefined();
  });

  it("accepts a fund config with budget block", () => {
    const withBudget = {
      fund: { name: "f", display_name: "F", created: "2026-04-27" },
      capital: { initial: 1000 },
      objective: { type: "growth", multiplier: 2 },
      risk: { max_position_pct: 25, max_drawdown_pct: 25 },
      universe: { kind: "preset", preset: "sp100" },
      schedule: { sessions: {} },
      budget: { default: { maxTurns: 50, maxUsd: 6 } },
    };
    const out = fundConfigSchema.parse(withBudget);
    expect(out.budget?.default).toEqual({ maxTurns: 50, maxUsd: 6 });
  });
});

describe("globalConfigSchema with budget", () => {
  it("accepts an empty global config (back-compat)", () => {
    const out = globalConfigSchema.parse({});
    expect(out.budget).toBeUndefined();
  });

  it("accepts a global config with budget block", () => {
    const out = globalConfigSchema.parse({
      budget: { default: { maxTurns: 100, maxUsd: 10 } },
    });
    expect(out.budget?.default).toEqual({ maxTurns: 100, maxUsd: 10 });
  });
});

describe("sessionLogV2Schema with budget_resolved", () => {
  it("accepts a session log without budget_resolved (back-compat)", () => {
    const out = sessionLogV2Schema.parse({
      fund: "f",
      session_type: "pre-market",
      started_at: "2026-04-27T10:00:00.000Z",
    });
    expect(out.budget_resolved).toBeUndefined();
  });

  it("accepts a session log with budget_resolved", () => {
    const out = sessionLogV2Schema.parse({
      fund: "f",
      session_type: "pre-market",
      started_at: "2026-04-27T10:00:00.000Z",
      budget_resolved: { maxTurns: 40, maxUsd: 5 },
    });
    expect(out.budget_resolved).toEqual({ maxTurns: 40, maxUsd: 5 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/budget.test.ts`
Expected: FAIL with "Cannot find name 'budgetSchema'" (or similar — all four imports fail).

- [ ] **Step 3: Add schemas to `src/types.ts`**

Insert this block immediately above the `// ── Fund Config Schema ─────────────────────────────────────────` heading at `src/types.ts:159`:

```typescript
// ── Budget Schema ──────────────────────────────────────────────

export const budgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxUsd: z.number().positive(),
});

export type Budget = z.infer<typeof budgetSchema>;

export const fundBudgetConfigSchema = z
  .object({
    default: budgetSchema.optional(),
    perSessionType: z.record(z.string(), budgetSchema).optional(),
  })
  .optional();

export type FundBudgetConfig = z.infer<typeof fundBudgetConfigSchema>;

```

In `fundConfigSchema` (`src/types.ts:161–210`), add a new property at the end of the object passed to `z.object({...})`, just before the closing `})`:

```typescript
  budget: fundBudgetConfigSchema,
```

In `globalConfigSchema` (`src/types.ts:260–288`), add the same property at the end of the object, just before the closing `})`:

```typescript
  budget: fundBudgetConfigSchema,
```

In `sessionLogV2Schema` (`src/types.ts:584–594`), add a new line inside the `.extend({...})` call:

```typescript
  budget_resolved: budgetSchema.optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/budget.test.ts`
Expected: PASS — all 11 tests green.

- [ ] **Step 5: Type-check the whole project**

Run: `pnpm typecheck`
Expected: 0 errors. (If errors appear, they will be in places that destructure FundConfig/GlobalConfig literally — fix by treating the new field as optional.)

- [ ] **Step 6: Commit**

```bash
git add src/types.ts tests/budget.test.ts
git commit -m "feat(types): add Budget, FundBudgetConfig schemas; extend Fund/Global/SessionLog"
```

---

## Task 2: `resolveBudget` cascade

**Files:**
- Modify: `src/services/session.service.ts` (add new exports near the top, after the existing `DEFAULT_*` constants at line 12–13)
- Test: `tests/budget.test.ts` (append new `describe` block)

- [ ] **Step 1: Write the failing test**

Append to `tests/budget.test.ts`:

```typescript
import { resolveBudget } from "../src/services/session.service.js";
import type { FundConfig, GlobalConfig } from "../src/types.js";

const baseFund = (): FundConfig => ({
  fund: { name: "f", display_name: "F", description: "", created: "2026-04-27", status: "active" },
  capital: { initial: 1000, currency: "USD" },
  objective: { type: "growth", multiplier: 2 } as FundConfig["objective"],
  risk: { max_position_pct: 25, max_drawdown_pct: 25 } as FundConfig["risk"],
  universe: { kind: "preset", preset: "sp100" } as FundConfig["universe"],
  schedule: { sessions: {}, special_sessions: [] },
  broker: { mode: "paper" },
  notifications: {
    telegram: { enabled: false, trade_alerts: true, stop_loss_alerts: true, daily_digest: true, weekly_digest: true, milestone_alerts: true, drawdown_alerts: true },
    quiet_hours: { enabled: true, start: "23:00", end: "07:00", allow_critical: true },
  },
  claude: { model: "sonnet", personality: "", decision_framework: "" },
});

const baseGlobal = (): GlobalConfig => ({
  default_model: "sonnet",
  timezone: "UTC",
  broker: {},
  telegram: { enabled: false },
  market_data: { provider: "fmp" },
});

describe("resolveBudget cascade", () => {
  it("level 1 — fund per-session-type wins over everything", () => {
    const fund = baseFund();
    fund.budget = {
      perSessionType: { "pre-market": { maxTurns: 11, maxUsd: 1 } },
      default: { maxTurns: 22, maxUsd: 2 },
    };
    const global = baseGlobal();
    global.budget = {
      perSessionType: { "pre-market": { maxTurns: 33, maxUsd: 3 } },
      default: { maxTurns: 44, maxUsd: 4 },
    };
    expect(resolveBudget(fund, global, "pre-market")).toEqual({ maxTurns: 11, maxUsd: 1 });
  });

  it("level 2 — fund default wins when no fund per-session-type for that type", () => {
    const fund = baseFund();
    fund.budget = {
      perSessionType: { "post-market": { maxTurns: 99, maxUsd: 9 } },
      default: { maxTurns: 22, maxUsd: 2 },
    };
    const global = baseGlobal();
    global.budget = { default: { maxTurns: 44, maxUsd: 4 } };
    expect(resolveBudget(fund, global, "pre-market")).toEqual({ maxTurns: 22, maxUsd: 2 });
  });

  it("level 3 — global per-session-type wins when no fund budget at all", () => {
    const fund = baseFund();
    const global = baseGlobal();
    global.budget = {
      perSessionType: { "pre-market": { maxTurns: 33, maxUsd: 3 } },
      default: { maxTurns: 44, maxUsd: 4 },
    };
    expect(resolveBudget(fund, global, "pre-market")).toEqual({ maxTurns: 33, maxUsd: 3 });
  });

  it("level 4 — global default wins when no per-session-type at any level", () => {
    const fund = baseFund();
    const global = baseGlobal();
    global.budget = { default: { maxTurns: 44, maxUsd: 4 } };
    expect(resolveBudget(fund, global, "pre-market")).toEqual({ maxTurns: 44, maxUsd: 4 });
  });

  it("level 5 — known session-type default when no config at all", () => {
    const fund = baseFund();
    const global = baseGlobal();
    expect(resolveBudget(fund, global, "pre_market")).toEqual({ maxTurns: 40, maxUsd: 5 });
    expect(resolveBudget(fund, global, "mid_session")).toEqual({ maxTurns: 25, maxUsd: 3 });
    expect(resolveBudget(fund, global, "post_market")).toEqual({ maxTurns: 60, maxUsd: 7 });
  });

  it("level 6 — fallback default for unknown session type", () => {
    const fund = baseFund();
    const global = baseGlobal();
    expect(resolveBudget(fund, global, "made-up-type")).toEqual({ maxTurns: 50, maxUsd: 5 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/budget.test.ts`
Expected: FAIL — "resolveBudget is not exported from session.service".

- [ ] **Step 3: Add `resolveBudget` to `src/services/session.service.ts`**

Add these exports immediately after `const DEFAULT_SESSION_TIMEOUT_MINUTES = 15;` at line 13:

```typescript
import type { Budget, FundConfig, GlobalConfig, SessionLogV2, UniverseResolution } from "../types.js";
```

(Replace the existing `import type { SessionLogV2, UniverseResolution } from "../types.js";` at line 7 with the line above — the new types are added inline.)

Then add, immediately after the two `DEFAULT_*` consts at line 13:

```typescript
/** Hardcoded per-session-type defaults — last layer of the budget cascade
 *  before the global FALLBACK_DEFAULT. Conservative on the high side so a
 *  default-only deployment doesn't trip caps in normal operation. */
const DEFAULTS_BY_SESSION_TYPE: Record<string, Budget> = {
  "pre-market": { maxTurns: 40, maxUsd: 5 },
  "mid-session": { maxTurns: 25, maxUsd: 3 },
  "post-market": { maxTurns: 60, maxUsd: 7 },
  "on-demand": { maxTurns: 30, maxUsd: 4 },
  "special": { maxTurns: 50, maxUsd: 6 },
};

/** Used when the session_type is not present in DEFAULTS_BY_SESSION_TYPE
 *  (e.g. a custom session type). Generous middle-of-the-road. */
const FALLBACK_DEFAULT: Budget = { maxTurns: 50, maxUsd: 5 };

/** Resolve the budget for a session through a 6-level cascade.
 *  Most-specific override wins:
 *    1. fund.budget.perSessionType[sessionType]
 *    2. fund.budget.default
 *    3. global.budget.perSessionType[sessionType]
 *    4. global.budget.default
 *    5. DEFAULTS_BY_SESSION_TYPE[sessionType]
 *    6. FALLBACK_DEFAULT
 *  Pure function — no I/O. Tested in tests/budget.test.ts. */
export function resolveBudget(
  fund: FundConfig,
  global: GlobalConfig,
  sessionType: string,
): Budget {
  return (
    fund.budget?.perSessionType?.[sessionType] ??
    fund.budget?.default ??
    global.budget?.perSessionType?.[sessionType] ??
    global.budget?.default ??
    DEFAULTS_BY_SESSION_TYPE[sessionType] ??
    FALLBACK_DEFAULT
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/budget.test.ts`
Expected: PASS — 6 new tests green plus all 11 from Task 1.

- [ ] **Step 5: Commit**

```bash
git add src/services/session.service.ts tests/budget.test.ts
git commit -m "feat(session): add resolveBudget cascade with per-session-type defaults"
```

---

## Task 3: `buildBudgetAlert` pure helper

**Files:**
- Modify: `src/services/session.service.ts` (add new export below `resolveBudget`)
- Test: `tests/budget.test.ts` (append new `describe` block)

- [ ] **Step 1: Write the failing test**

Append to `tests/budget.test.ts`:

```typescript
import { buildBudgetAlert } from "../src/services/session.service.js";

describe("buildBudgetAlert", () => {
  it("formats an error_max_budget alert with all fields", () => {
    const out = buildBudgetAlert({
      displayName: "My Fund",
      sessionType: "pre-market",
      status: "error_max_budget",
      budget: { maxTurns: 40, maxUsd: 5 },
      numTurns: 22,
      costUsd: 5.03,
    });
    expect(out).toContain("My Fund");
    expect(out).toContain("pre-market");
    expect(out).toContain("stopped at budget");
    expect(out).toContain("40 turns");
    expect(out).toContain("$5");
    expect(out).toContain("22 turns");
    expect(out).toContain("$5.03");
    expect(out).toContain("error_max_budget");
  });

  it("formats an error_max_turns alert", () => {
    const out = buildBudgetAlert({
      displayName: "My Fund",
      sessionType: "post-market",
      status: "error_max_turns",
      budget: { maxTurns: 60, maxUsd: 7 },
      numTurns: 60,
      costUsd: 4.21,
    });
    expect(out).toContain("error_max_turns");
    expect(out).toContain("60 turns");
    expect(out).toContain("$7");
  });

  it("escapes HTML-special characters in displayName", () => {
    const out = buildBudgetAlert({
      displayName: "Fund & <Co>",
      sessionType: "pre-market",
      status: "error_max_budget",
      budget: { maxTurns: 40, maxUsd: 5 },
      numTurns: 22,
      costUsd: 5.0,
    });
    expect(out).toContain("Fund &amp; &lt;Co&gt;");
    expect(out).not.toContain("Fund & <Co>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/budget.test.ts`
Expected: FAIL — "buildBudgetAlert is not exported from session.service".

- [ ] **Step 3: Add `buildBudgetAlert` to `src/services/session.service.ts`**

Add directly after `resolveBudget` (and after the existing `escapeHtml` helper at line 87 — order does not matter since they are top-level exports):

```typescript
export interface BuildBudgetAlertInput {
  displayName: string;
  sessionType: string;
  status: "error_max_budget" | "error_max_turns";
  budget: Budget;
  numTurns: number;
  costUsd: number;
}

/** Format a Telegram alert (HTML parse-mode) for a session that the SDK
 *  hard-killed on a budget cap. Returns the message body — caller passes
 *  it to notifySession(). Pure function, tested in tests/budget.test.ts. */
export function buildBudgetAlert(input: BuildBudgetAlertInput): string {
  const safeName = escapeHtml(input.displayName);
  return [
    `🛑 <b>${safeName}</b> — ${input.sessionType} stopped at budget`,
    `Limit: ${input.budget.maxTurns} turns / $${input.budget.maxUsd}`,
    `Used: ${input.numTurns} turns / $${input.costUsd.toFixed(2)}`,
    `Reason: <code>${input.status}</code>`,
  ].join("\n");
}
```

(`escapeHtml` is currently a private function in the same file — leave it private; `buildBudgetAlert` is in the same module so it can call it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/budget.test.ts`
Expected: PASS — 3 new tests green plus 17 from prior tasks.

- [ ] **Step 5: Commit**

```bash
git add src/services/session.service.ts tests/budget.test.ts
git commit -m "feat(session): add buildBudgetAlert formatter for budget hard-kill"
```

---

## Task 4: Wire into `runFundSession`

**Files:**
- Modify: `src/services/session.service.ts:100–271` (the `runFundSession` function body)

- [ ] **Step 1: Verify the existing test suite is green before modifying production wiring**

Run: `pnpm test`
Expected: PASS — record the green baseline. If any test is already failing on `main`, stop and ask the user before continuing.

- [ ] **Step 2: Modify `runFundSession` to load global config + resolve budget**

In `src/services/session.service.ts`, find this block at lines 105 and 143–147:

```typescript
  const config = await loadFundConfig(fundName);
  // ...
  const model = config.claude.model || undefined;
  const effectiveMaxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
  const effectiveDuration = options?.maxDurationMinutes
    ?? sessionConfig?.max_duration_minutes
    ?? DEFAULT_SESSION_TIMEOUT_MINUTES;
```

Replace with (note: `loadGlobalConfig` is already imported at line 9):

```typescript
  const config = await loadFundConfig(fundName);
  const globalConfig = await loadGlobalConfig();
  // ...
  const model = config.claude.model || undefined;
  const budget = resolveBudget(config, globalConfig, sessionType);
  const effectiveMaxTurns = options?.maxTurns ?? budget.maxTurns;
  const effectiveMaxBudgetUsd = budget.maxUsd;
  const effectiveDuration = options?.maxDurationMinutes
    ?? sessionConfig?.max_duration_minutes
    ?? DEFAULT_SESSION_TIMEOUT_MINUTES;
```

(The `// ...` represents existing code between the two anchors — leave it untouched. The change is: add `globalConfig` load, add `budget` resolve, change `effectiveMaxTurns` fallback from `DEFAULT_MAX_TURNS` to `budget.maxTurns`, add `effectiveMaxBudgetUsd`. The `options?.maxTurns` override is preserved at top priority for the eval harness.)

- [ ] **Step 3: Pass `maxBudgetUsd` to `runAgentQuery`**

Find both `runAgentQuery` invocations in `runFundSession` (lines 156–164 and 174–181). In each, add a `maxBudgetUsd` argument right after `maxTurns`:

First call (line 156–164), change:

```typescript
    result = await runAgentQuery({
      fundName,
      prompt,
      model,
      maxTurns: effectiveMaxTurns,
      timeoutMs: timeout,
      agents,
      resumeSessionId: activeSession?.session_id,
    });
```

to:

```typescript
    result = await runAgentQuery({
      fundName,
      prompt,
      model,
      maxTurns: effectiveMaxTurns,
      maxBudgetUsd: effectiveMaxBudgetUsd,
      timeoutMs: timeout,
      agents,
      resumeSessionId: activeSession?.session_id,
    });
```

Second call (line 174–181), change:

```typescript
      result = await runAgentQuery({
        fundName,
        prompt,
        model,
        maxTurns: effectiveMaxTurns,
        timeoutMs: timeout,
        agents,
      });
```

to:

```typescript
      result = await runAgentQuery({
        fundName,
        prompt,
        model,
        maxTurns: effectiveMaxTurns,
        maxBudgetUsd: effectiveMaxBudgetUsd,
        timeoutMs: timeout,
        agents,
      });
```

- [ ] **Step 4: Persist `budget_resolved` in the session log**

Find the `SessionLogV2` literal at lines 191–205:

```typescript
  const log: SessionLogV2 = {
    fund: fundName,
    session_type: sessionType,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    trades_executed: 0,
    summary: result.output.slice(0, 500),
    cost_usd: result.cost_usd,
    tokens_in: sumTokens(result.usage, "inputTokens"),
    tokens_out: sumTokens(result.usage, "outputTokens"),
    model_used: Object.keys(result.usage)[0],
    num_turns: result.num_turns,
    session_id: result.session_id,
    status: result.status,
  };
```

Add one line at the end (just before the closing `};`):

```typescript
    budget_resolved: budget,
```

- [ ] **Step 5: Branch the completion notification on budget kill**

Find the existing notification block at lines 226–230:

```typescript
  await notifySession(
    `${statusEmoji} <b>${displayName}</b> — ${sessionType} (${durationStr})\n` +
    `<i>${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out | ${log.num_turns} turns</i>\n\n` +
    (summary ? `${escapeHtml(summary)}${truncated ? "..." : ""}` : "No output"),
  );
```

Wrap it in a conditional that uses `buildBudgetAlert` for budget kills, the existing format otherwise:

```typescript
  if (result.status === "error_max_budget" || result.status === "error_max_turns") {
    await notifySession(
      buildBudgetAlert({
        displayName: config.fund.display_name,
        sessionType,
        status: result.status,
        budget,
        numTurns: log.num_turns ?? 0,
        costUsd: log.cost_usd ?? 0,
      }),
    );
  } else {
    await notifySession(
      `${statusEmoji} <b>${displayName}</b> — ${sessionType} (${durationStr})\n` +
      `<i>${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out | ${log.num_turns} turns</i>\n\n` +
      (summary ? `${escapeHtml(summary)}${truncated ? "..." : ""}` : "No output"),
    );
  }
```

(`buildBudgetAlert` HTML-escapes the display name internally — pass the raw string, not `displayName` which is already escaped at line 116.)

- [ ] **Step 6: Run the existing test suite to verify no regression**

Run: `pnpm test`
Expected: PASS — the new `tests/budget.test.ts` plus all prior tests remain green. There is no automated test for `runFundSession` itself; correctness here relies on the unit-tested helpers + manual smoke test in Task 5.

- [ ] **Step 7: Type-check**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/services/session.service.ts
git commit -m "feat(session): wire resolveBudget + buildBudgetAlert into runFundSession"
```

---

## Task 5: Manual smoke test + docs

**Files:**
- Modify: `CLAUDE.md` (add one line in "Configuration" section)
- Manual: smoke test against a paper fund

- [ ] **Step 1: Run the MVP eval suite to confirm no regression**

Run: `pnpm dev -- eval --filter mvp-`
Expected: PASS — all 8 MVP cases green. Eval cases use `runAsk` and `runChatTurn` (not `runFundSession`), so should be unaffected, but verify.

If any case fails: inspect the report; if a case is now over the new default budget, increase the relevant entry in `DEFAULTS_BY_SESSION_TYPE` and re-run. **Do not loosen budgets to suppress an actual regression** — investigate first.

- [ ] **Step 2: Manual smoke test — verify budget hard-kill path**

Pick a paper fund (or create a throwaway one with `fundx fund create`). Edit `~/.fundx/config.yaml` to add an artificially-low budget for `pre-market`:

```yaml
budget:
  perSessionType:
    pre-market:
      maxTurns: 50
      maxUsd: 0.10
```

Run a `pre-market` session manually:

```bash
pnpm dev -- session run <fund-name> pre-market
```

Verify, in this order:

1. The session terminates quickly (a few turns at most).
2. The Telegram message (if Telegram is configured) starts with "🛑" and says "stopped at budget".
3. `~/.fundx/funds/<fund-name>/state/session_log.json` shows the latest entry with:
   - `status: "error_max_budget"`
   - `budget_resolved: { maxTurns: 50, maxUsd: 0.10 }`
   - `cost_usd ≈ 0.10` (slightly over is normal — SDK tallies in chunks)

If any of those three fail: inspect logs at `~/.fundx/daemon.log` and the failing assertion, fix, re-test.

Revert the `~/.fundx/config.yaml` budget block when done so future sessions are not capped at $0.10.

- [ ] **Step 3: Manual smoke test — verify normal session unaffected**

Run a regular `pre-market` session against the same fund (without the artificial cap):

```bash
pnpm dev -- session run <fund-name> pre-market
```

Verify:

1. Session completes normally with `status: "success"`.
2. Telegram message uses the standard `✅` completion format (not the budget alert).
3. `session_log.json` shows `budget_resolved: { maxTurns: 40, maxUsd: 5 }` (the per-session-type default).

- [ ] **Step 4: Update `CLAUDE.md`**

Find the "Configuration" section in `CLAUDE.md` (around the "Per-fund config" bullet). Add this line right after the existing "Global config" bullet:

```markdown
- Budgets: per-session-type `maxTurns` / `maxUsd` cap resolved through `fund.budget` → `global.budget` → hardcoded defaults (see `resolveBudget` in `src/services/session.service.ts`). SDK hard-kills at 100 % via `error_max_budget` / `error_max_turns` status; Telegram alert distinguishes budget kills from generic errors.
```

- [ ] **Step 5: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document budget cascade and hard-kill behavior"
```

---

## Self-Review Checklist (before marking complete)

After all 5 tasks complete, run this once:

- [ ] `pnpm test` is green (full suite, not just budget.test.ts).
- [ ] `pnpm typecheck` is clean.
- [ ] `pnpm lint` is clean (or any warnings are pre-existing).
- [ ] `pnpm build` succeeds.
- [ ] `git log --oneline -5` shows 4 commits with descriptive messages.
- [ ] The artificially-low-budget smoke test was actually run (not just reasoned about).
- [ ] `CLAUDE.md` reflects the new feature.
- [ ] Roadmap status log updated: append a 2026-04-27 entry "Phase 1a v1 complete: resolveBudget + buildBudgetAlert wired into runFundSession; smoke test green".

If any of these is not true, the phase is **not** done. Do not mark Phase 1a as complete in the roadmap.
