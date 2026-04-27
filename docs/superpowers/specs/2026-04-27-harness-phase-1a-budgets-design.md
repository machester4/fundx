# Phase 1a — Execution Budgets (G2)

**Date:** 2026-04-27
**Status:** Approved (design)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Closes gap:** G2 — no execution budgets in production sessions
**Pattern enforced:** #9 — execution budgets enforced by the harness, not the prompt

---

## Goal

Every autonomous session run via `runFundSession` enforces hard caps on **turns** and **USD**, with a soft warning at 75 % of either cap and a hard kill at 100 %. State, logging, and Telegram alerts cover the kill path so a budget event is never silent.

## Non-goals

- **Daily-per-fund aggregate cap** — useful but adds persistent tracking complexity. Deferred to Phase 4 (G6).
- **Caps on interactive (chat / ask) sessions** — interactive sessions have a human in the loop; cost is self-regulating.
- **Auto-tuning budgets from observed p95** — first version uses static defaults. Adaptive tuning is a follow-on once a few weeks of `session_log.json` data exist.

---

## Components

### 1. Schema (`src/types.ts`)

Add Zod schemas:

```typescript
const Budget = z.object({
  maxTurns: z.number().int().positive(),
  maxUsd: z.number().positive(),
});

// Extend FundConfig:
budget: z.object({
  default: Budget.optional(),
  perSessionType: z.record(z.enum(SESSION_TYPES), Budget).optional(),
}).optional()

// Extend GlobalConfig: same shape.
```

Reuse the existing `SESSION_TYPES` enum.

### 2. Resolver (`src/services/session.service.ts`)

Add a pure function:

```typescript
export function resolveBudget(
  fundConfig: FundConfig,
  globalConfig: GlobalConfig,
  sessionType: SessionType,
): Budget
```

Cascade order (most specific wins):

1. `fundConfig.budget.perSessionType[sessionType]`
2. `fundConfig.budget.default`
3. `globalConfig.budget.perSessionType[sessionType]`
4. `globalConfig.budget.default`
5. Hardcoded defaults (next section)

Pure function — no I/O. Unit-testable in isolation.

### 3. Defaults (initial, conservative)

| `session_type` | maxTurns | maxUsd |
|---|---:|---:|
| `pre-market` | 40 | $5 |
| `mid-session` | 25 | $3 |
| `post-market` | 60 | $7 |
| `on-demand` | 30 | $4 |
| `special` | 50 | $6 |

These are intuition-based. After 2–4 weeks of production use, derive from `session_log.json` p95 × 1.5 buffer.

### 4. Budget middleware (`src/services/budget.service.ts` — new)

A wrapper around the SDK's async iterator:

```typescript
export interface BudgetTracker {
  state: 'idle' | 'warned' | 'killed';
  turnsUsed: number;
  usdUsed: number;
  observe(message: SDKMessage): { warning?: WarningInfo; kill?: KillInfo };
}
```

For each message coming from the SDK:

- Increment `turnsUsed` for `assistant` messages (one assistant turn ≈ one model call). Pick the simpler measure that matches what the cap is about.
- Increment `usdUsed` from `message.usage` × per-model price (`MODEL_PRICING` constant in this file). Account for `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` separately.
- If state === 'idle' and (turns ≥ 0.75 × maxTurns OR usd ≥ 0.75 × maxUsd): return `{ warning: ... }`, transition to 'warned'.
- If state ∈ {'idle', 'warned'} and (turns ≥ maxTurns OR usd ≥ maxUsd): return `{ kill: ... }`, transition to 'killed'.

Middleware is **observation-only**; the caller (`session.service.ts`) owns side effects (injecting warning, calling cancel).

### 5. Warning injection

In `runFundSession`, after each SDK message the middleware's `observe` is called. If a warning is returned, the harness sends a `system`-style message back into the SDK input channel:

```
Budget warning: 75% consumed (turns: X/Y, cost: $A.AA / $B.BB).

You must now wrap up:
1. If you were about to start new analysis or trades, STOP.
2. Write the session-handoff.md (use the session-reflection skill).
3. Evaluate the session contract.
4. End the session.

You will be hard-stopped at 100% (turns: Y, cost: $B.BB).
```

The exact SDK API for mid-stream system message injection is to be confirmed during implementation. If the TS SDK does not expose it natively, fall back to `sendUserMessage` with a clearly-marked prefix and adjust the warning text. (See "Implementation notes".)

### 6. Hard kill

When the middleware returns `{ kill: ... }`:

1. Call the SDK client's interrupt / cancel method.
2. Drain remaining messages until the iterator closes naturally.
3. Set `sessionStatus = "killed_budget"` and `killReason = kill.reason` (`"turns"` or `"usd"`).
4. Continue to step 7 (persistence) — do not re-throw.

### 7. Persistence (`session_log.json`)

After session end (normal, killed, or errored), write the following fields in the existing per-session log entry:

```json
{
  "...existing fields...": null,
  "budget_resolved": { "maxTurns": 40, "maxUsd": 5 },
  "turns_used": 38,
  "usd_used": 4.27,
  "warned_at_75": true,
  "killed_at_100": false,
  "kill_reason": null
}
```

### 8. Telegram alert

On hard kill (only — not on warning), send via `mcp__telegram-notify__send_message` with **high priority** (override quiet hours):

```
🛑 FundX budget hit
Fund: <fund_name>
Session: <session_type>
Limit: <maxTurns> turns / $<maxUsd>
Used: <turns_used> turns / $<usd_used>
Killed at: <kill_reason>
```

If Telegram fails, **log the failure** to `daemon.log` — do not swallow silently. (This is the canonical anti-pattern flagged in the audit.)

---

## Definition of Done

1. **Unit tests** in `tests/budget.test.ts`:
   - `resolveBudget` cascade covers all 5 levels.
   - Middleware emits warning at exact 75 % boundary in turns and in USD (separately).
   - Middleware emits kill at exact 100 % boundary in turns and in USD.
   - State machine doesn't double-warn or double-kill.

2. **Integration test** with the real SDK and a seeded eval fund:
   - Set `maxUsd = $0.10` artificially low.
   - Verify the warning appears in transcript.
   - Verify the hard kill fires.
   - Verify `session_log.json` records both events.
   - Verify Telegram alert (mock the notify MCP).

3. **MVP eval suite passes** (`pnpm dev -- eval --filter mvp-`) — defaults must be generous enough not to trip eval cases.

4. **One real `pre-market` session** of a paper fund runs to completion without tripping caps (false-alarm check).

5. **Documentation:**
   - `CLAUDE.md` "Tech Stack" or new `docs/budgets.md` short doc explaining the cascade.
   - `state/session_log.json` field schema documented in code comments where it's written.

---

## Implementation notes (open during execution)

- **SDK API for mid-stream system-message injection** — verify the Claude Agent SDK TypeScript exposes a way to send a system-class message into an in-flight `query()`. If not, fall back to `sendUserMessage` with marker prefix and adjust warning text.
- **Token accounting** — sum `cache_creation_input_tokens` + `cache_read_input_tokens` + `input_tokens` + `output_tokens` × respective per-model rates. Use Anthropic's public price table.
- **Order of failure paths** — if the SDK throws while writing `session_log.json`, prefer leaving a stale partial log entry to crashing the daemon. Wrap log writes in try/catch and log to `daemon.log` on failure.

---

## Risks

| Risk | Mitigation |
|---|---|
| Wrong default budgets cause warning storms | Start with the table above (generous on `post-market`: 60 turns / $7); revisit after 2 weeks of production data. |
| Middleware breaks streaming UI in interactive sessions | Phase 1a touches only `runFundSession` (autonomous). Interactive `chat`/`ask` paths are unchanged. |
| Token-rate table goes stale after Anthropic price change | Centralise `MODEL_PRICING` in one constant; one-line edit for updates. |
| SDK doesn't expose mid-stream system-message injection | Fallback to `sendUserMessage` with marker prefix, documented in code comments. |

---

## Effort

2–3 days concentrated.
