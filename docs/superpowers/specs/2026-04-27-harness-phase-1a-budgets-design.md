# Phase 1a — Execution Budgets (G2) — v1 minimal

**Date:** 2026-04-27
**Status:** Approved (design — v1 minimal scope after code-truth audit)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Closes gap:** G2 — no execution budgets in production sessions
**Pattern enforced:** #9 — execution budgets enforced by the harness, not the prompt

> **Scope correction (2026-04-27):** A code-truth pass on `src/agent.ts` and `src/services/session.service.ts` revealed that the SDK already enforces both `maxTurns` and `maxBudgetUsd` natively (`src/agent.ts:238–240`), the `error_max_budget` and `error_max_turns` statuses already exist in `SessionLogV2` (`types.ts:592–593`), and `runFundSession` already wires `maxTurns` (default 50). The original spec implied building a token-counting middleware and an injected 75% warning — most of that is already done by the SDK or unnecessary. The 75% soft-warning piece would require refactoring `runAgentQuery` to streaming-input mode (a structural change with high blast radius across `session`, `chat`, `ask`, `gateway`, `eval`) and is **deferred** to a follow-on phase. v1 ships hard-kill-at-100 % only.

---

## Goal

Every autonomous session run via `runFundSession` has explicit, per-session-type **turn and USD caps** resolved through a config cascade. The SDK enforces them as hard kill at 100 %. Telegram alerts distinguish budget-kills from generic errors. Session log records the resolved budget for visibility.

## What v1 ships

| Capability | Mechanism | New code? |
|---|---|---|
| Hard kill at 100 % of turns | SDK already enforces `maxTurns` | No (already wired) |
| Hard kill at 100 % of USD | SDK enforces `maxBudgetUsd`; we start passing it | Wire-up only |
| Per-session-type cascade (fund → global → defaults) | New pure resolver fn `resolveBudget` | Yes |
| Telegram alert distinguishes budget-kill from error | Branch on `status === "error_max_budget"` or `"error_max_turns"` in existing notify path | Small edit |
| Session log records resolved budget | Add `budget_resolved: Budget` field on `SessionLogV2` | Schema + log write |

## What v1 does NOT ship (deferred)

- **75 % soft warning with mid-stream injection.** Requires refactoring `runAgentQuery` to use the SDK's streaming-input mode (async iterator for `prompt` instead of single-string). High blast radius across `session.service.ts`, `chat.service.ts`, `ask.service.ts`, `gateway.service.ts`, `eval/runner.ts`. Captured as **future Phase 1c** (or rolled into Phase 4 brainstorming once we have observability data on whether sessions actually need the soft wrap-up vs. a clean hard-kill).
- **Daily-per-fund aggregate cap.** Captured in Phase 4 (G6).
- **Caps on interactive (chat / ask) sessions.** Out of scope; human-in-the-loop self-regulates.
- **Auto-tuning budgets from observed p95.** Static defaults first; revisit after 2–4 weeks of `session_log.json` data.

---

## Components

### 1. Schema (`src/types.ts`)

Add Zod schema:

```typescript
export const budgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxUsd: z.number().positive(),
});

export type Budget = z.infer<typeof budgetSchema>;

export const fundBudgetConfigSchema = z.object({
  default: budgetSchema.optional(),
  perSessionType: z.record(z.string(), budgetSchema).optional(),
}).optional();
```

Extend `fundConfigSchema` with `budget: fundBudgetConfigSchema`.
Extend `globalConfigSchema` with `budget: fundBudgetConfigSchema`.

Extend `sessionLogV2Schema` with one new field:

```typescript
budget_resolved: budgetSchema.optional(),
```

The existing `cost_usd`, `num_turns`, and `status` fields cover usage and outcome; no further additions needed.

### 2. Resolver (`src/services/session.service.ts`)

Add a pure function:

```typescript
export function resolveBudget(
  fundConfig: FundConfig,
  globalConfig: GlobalConfig,
  sessionType: string,
): Budget
```

Cascade order (most specific wins):

1. `fundConfig.budget?.perSessionType?.[sessionType]`
2. `fundConfig.budget?.default`
3. `globalConfig.budget?.perSessionType?.[sessionType]`
4. `globalConfig.budget?.default`
5. Hardcoded `DEFAULTS_BY_SESSION_TYPE[sessionType]` (see next section)
6. Hardcoded `FALLBACK_DEFAULT` if session type is unknown

Pure function — no I/O. Unit-testable in isolation.

### 3. Defaults (`DEFAULTS_BY_SESSION_TYPE` constant in `session.service.ts`)

| `session_type` | maxTurns | maxUsd |
|---|---:|---:|
| `pre_market` | 40 | $5 |
| `mid_session` | 25 | $3 |
| `post_market` | 60 | $7 |

Catchup (`catchup_<type>`) and special (`special_<trigger>`) sessions fall through to `FALLBACK_DEFAULT` — prefix matching is a future improvement, intentionally out of scope for v1.

`FALLBACK_DEFAULT`: `{ maxTurns: 50, maxUsd: 5 }` — matches the existing `DEFAULT_MAX_TURNS = 50` plus a sensible USD cap.

### 4. Wire into `runFundSession`

In `src/services/session.service.ts:104–143` (around the existing `effectiveMaxTurns` calculation):

- Resolve the budget at session start: `const budget = resolveBudget(config, globalConfig, sessionType);`
- Pass `maxTurns: budget.maxTurns` and `maxBudgetUsd: budget.maxUsd` to `runAgentQuery`. The existing `options?.maxTurns` override stays as an escape hatch for the eval harness (highest priority).
- Persist `budget_resolved: budget` in the `SessionLogV2` written at line 191–205.

### 5. Telegram alert distinguishes budget-kill

In the existing notify path of `runFundSession` (around line 226–230):

- If `result.status === "error_max_budget"` or `"error_max_turns"`: send a dedicated message with the resolved budget and actuals. Use the existing `notifySession` helper. Status remains routed through the normal completion notify; the differentiation is in the message body / emoji, not in a new transport.

Example:

```
🛑 <displayName> — <session_type> stopped at budget
Limit: <maxTurns> turns / $<maxUsd>
Used: <num_turns> turns / $<cost_usd>
Reason: <error_max_turns | error_max_budget>
```

If Telegram fails, the existing `notifySession` swallows the error silently (best-effort by design at line 92–97). Leave that behavior — it is consistent with the rest of the file.

### 6. Backward-compat

- Existing fund configs without a `budget` block → cascade falls through to `DEFAULTS_BY_SESSION_TYPE`. No migration needed.
- Eval harness paths that pass `options.maxTurns` continue to override (highest priority in the resolver). Eval cases stay green without changes.

---

## Definition of Done

1. **Unit tests** in `tests/budget.test.ts`:
   - `resolveBudget` cascade covers all 6 levels (per-session-type fund → fund default → per-session-type global → global default → session-type default → fallback default).
   - Unknown session types fall through to `FALLBACK_DEFAULT`.

2. **Integration check** (manual or scripted):
   - Set `globalConfig.budget.perSessionType['pre-market'].maxUsd = 0.10` artificially.
   - Run a `pre-market` session against a paper fund.
   - Verify `result.status === "error_max_budget"`.
   - Verify Telegram alert says "stopped at budget".
   - Verify `session_log.json` shows `budget_resolved: { maxTurns: 40, maxUsd: 0.10 }` and `cost_usd ≈ 0.10`.

3. **MVP eval suite passes** (`pnpm dev -- eval --filter mvp-`) — defaults must be generous enough not to trip cases. Eval `runs` paths use `runAsk` / `runChatTurn` which do not go through `runFundSession`, so should be unaffected; verify regardless.

4. **One real `pre-market` session** of a paper fund completes without tripping caps (false-alarm check).

5. **Documentation:**
   - One-line mention in `CLAUDE.md` "Configuration" section pointing to the cascade.
   - Code comment in `resolveBudget` explaining the cascade order.

---

## Risks (v1)

| Risk | Mitigation |
|---|---|
| Wrong default budgets cause unexpected hard-kills in production | Defaults are conservative-on-the-high-side (60 turns / $7 for `post-market`); revisit after 2 weeks of `session_log.json` data. Override via global or fund config is one YAML edit. |
| Hard-kill at 100 % interrupts the agent before it writes handoff | Real risk for v1 — this is precisely what the deferred 75 % warning would mitigate. Phase 1b audit will inform whether Opus 4.7 writes handoffs defensively enough that the warning isn't needed. |
| Eval suite is sensitive to new `budget_resolved` field in `session_log.json` | Field is `optional()` in the Zod schema — old logs parse fine. |

---

## Effort

**0.5–1 day** (down from the original 2–3 days estimate after the code-truth audit).
