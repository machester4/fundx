# Phase 2 — Gate Hooks (G1 + G3)

**Date:** 2026-04-27 (spec dated; Phase 2 design completed 2026-04-28)
**Status:** Approved (design)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Phase 1b results:** [audit-results](./2026-04-27-harness-phase-1b-audit-results.md)
**Closes gaps:** G1 — evaluator verdicts not binding; G3 — Orient not verified
**Patterns enforced:** #2 (Orient → Work → Reflect cycle), #4 (hard circuit breakers via hooks)

---

## Goal

Two complementary mechanisms layered on top of `runFundSession`:

- **G3 — Pre-population.** The first user message in every autonomous session is augmented with a `<state_snapshot>` envelope containing handoff, portfolio, objective tracker, pending sessions, top-10 recent trades, and top-10 watchlist candidates. Removes the "did the agent read state?" ambiguity by making state structurally part of the prompt.

- **G1 — Verdict gate hook.** A `PreToolUse` hook on `mcp__broker-local__place_order` denies the call unless the most-recent verdict for the (ticker, side) tuple, parsed from sub-agent outputs in transcript, satisfies the side-specific rule:
  - BUY: requires both `trade-evaluator` PROCEED **and** `risk-guardian` APPROVED.
  - SELL: requires `risk-guardian` APPROVED only.
  - Daemon-triggered stop-loss exits do not pass through this hook (separate execution path).

Both mechanisms are confined to the autonomous-session code path (`runFundSession` only). Interactive chat / ask / eval surfaces are unchanged.

## Non-goals

- Gating other mutating broker-local tools (`update_universe`, etc.) — out of scope for v1; G1 prioritises `place_order` because it directly affects capital.
- Changes to chat / ask / eval surfaces — those have human-in-the-loop self-regulation.
- Refactoring sub-agent semantics beyond adding TICKER + SIDE fields to existing output XML formats.
- Replacing the `session-init` rule entirely; it is simplified, not removed.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  runFundSession (autonomous session)                            │
│                                                                  │
│  1. Resolve budget (Phase 1a — already in place)                │
│  2. ★ Build state snapshot                                ◀ G3  │
│       buildStateSnapshot(fundName) → <state_snapshot>...        │
│  3. Build prompt: prefix → snapshot → focus → universe → hint   │
│  4. ★ Instantiate VerdictTracker + register PreToolUse hook ◀ G1│
│  5. runAgentQuery({                                             │
│        ...                                                       │
│        onMessage: (msg) => verdictTracker.observe(msg),         │
│        hooks: { PreToolUse: [{ matcher: place_order, ... }] },  │
│      })                                                          │
│                                                                  │
│  ┌──── Hook callback (fires on each place_order PreToolUse) ┐   │
│  │  const { symbol, side } = input.tool_input               │   │
│  │  return verdictTracker.checkPlaceOrder({ symbol, side }) │   │
│  └───────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

---

## Component 1 — `buildStateSnapshot`

**Location:** `src/services/snapshot.service.ts` (new)

**Signature:**

```typescript
export async function buildStateSnapshot(fundName: string): Promise<string>
```

**Output format:**

```xml
<state_snapshot>
  <session_handoff>
    {contents of state/session-handoff.md, or "(none — first session)"}
  </session_handoff>

  <portfolio>
    {contents of state/portfolio.json}
  </portfolio>

  <objective_tracker>
    {contents of state/objective_tracker.json, or "(none)"}
  </objective_tracker>

  <pending_sessions>
    {contents of state/pending_sessions.json, or "(none)"}
  </pending_sessions>

  <recent_trades count="10">
    {top 10 by entry_date DESC from state/trade_journal.sqlite as JSON, or "(empty)"}
  </recent_trades>

  <watchlist top="10">
    {top 10 candidate/watching entries from screener.watchlist_query as JSON, or "(empty)"}
  </watchlist>
</state_snapshot>
```

**Robustness rules:**

- Each file read wrapped in `try/catch`. Missing or unreadable file → emit `(none — <reason>)` placeholder; never throw.
- Each query (journal, watchlist) wrapped in `try/catch`. Failure → `(empty — <reason>)` placeholder.
- Total snapshot size NOT capped in v1; expected ~5–7K tokens. If size becomes a problem in production, add a per-section truncation pass.
- Function logs failures to `daemon.log` via `console.warn`, never silently swallows.

**Token budget impact:** ~5–7K tokens per session at ~$3/1M input = +$0.02 per session. Trivial vs Phase 1a per-session cap of ~$5.

---

## Component 2 — Injection in `buildAutonomousPrompt`

**Location:** `src/services/session.service.ts` (modify existing function)

Add new optional param `stateSnapshot?: string` to `BuildAutonomousPromptInput`. Insert it AFTER the session-mode prefix, BEFORE the "You are running" line:

```typescript
const lines: string[] = [
  sessionModePrefix("autonomous-scheduled"),
  ``,
  ...(input.stateSnapshot ? [input.stateSnapshot, ``] : []),
  `You are running a ${input.sessionType} session for fund '${input.fundName}'.`,
  ...
];
```

`runFundSession` calls `buildStateSnapshot(fundName)` immediately after `loadGlobalConfig`, passes the result to `buildAutonomousPrompt` via the new field.

---

## Component 3 — `VerdictTracker`

**Location:** `src/services/verdict-tracker.ts` (new)

**Public types:**

```typescript
export interface Verdict {
  ticker: string;
  side: 'buy' | 'sell';
  source: 'trade-evaluator' | 'risk-guardian';
  recommendation: 'PROCEED' | 'RECONSIDER' | 'REJECT' | 'APPROVED' | 'REJECTED';
  approved: boolean;       // PROCEED or APPROVED
  observedAt: number;      // Date.now() at observation
}

export class VerdictTracker {
  observe(message: SDKMessage): void;
  checkPlaceOrder(input: { symbol: string; side: 'buy' | 'sell' }): HookJSONOutput;
}
```

**`observe` logic:**

1. If `message.type !== 'assistant'`, return.
2. For each content block in `message.message.content`:
   - If block is `tool_result` with text content:
     - Run regex match for `<trade_evaluation>...</trade_evaluation>` and `<risk_validation>...</risk_validation>`.
     - For each match, parse the inner block for `TICKER:`, `SIDE:`, `RECOMMENDATION:` (or `VERDICT:`) lines.
     - If all three fields present and parseable → push a `Verdict` to internal array with `observedAt = Date.now()`.
     - If parse fails → log warning to console, do not push (place_order will deny later for missing verdict).

**`checkPlaceOrder` logic:**

```typescript
checkPlaceOrder({ symbol, side }) {
  const evaluator = this.mostRecent('trade-evaluator', symbol, side);
  const guardian  = this.mostRecent('risk-guardian',  symbol, side);

  if (side === 'buy') {
    if (evaluator?.approved && guardian?.approved) return { decision: 'approve' };
    return this.denyBuy(symbol, evaluator, guardian);
  }
  if (side === 'sell') {
    if (guardian?.approved) return { decision: 'approve' };
    return this.denySell(symbol, guardian);
  }
  // Unknown side — fail open with logged warning (defensive: don't block legit code paths).
  console.warn(`[verdict-tracker] unknown side '${side}' for ${symbol} — allowing place_order`);
  return { decision: 'approve' };
}
```

**Denial messages (factual block style — Pregunta 5):**

- `denyBuy`:
  > `place_order denied: BUY {symbol} requires both trade-evaluator PROCEED and risk-guardian APPROVED for ({symbol}, buy). Found: trade-evaluator={evaluatorStatus}, risk-guardian={guardianStatus}. Required: invoke trade-evaluator (Task tool) and risk-guardian for this trade before retrying.`
- `denySell`:
  > `place_order denied: SELL {symbol} requires risk-guardian APPROVED for ({symbol}, sell). Found: risk-guardian={guardianStatus}. Required: invoke risk-guardian (Task tool) for this trade before retrying.`

`{evaluatorStatus}` / `{guardianStatus}` is one of: `'PROCEED'`, `'RECONSIDER'`, `'REJECT'`, `'APPROVED'`, `'REJECTED'`, `'none found'`.

---

## Component 4 — Sub-agent output format updates

**Location:** `src/subagent.ts` (modify trade-evaluator + risk-guardian)

Add `TICKER:` and `SIDE:` lines at the top of each output XML block:

`trade-evaluator <trade_evaluation>`:
```
<trade_evaluation>
TICKER: AAPL
SIDE: buy
SCORE: [1-5]
... (existing fields)
RECOMMENDATION: PROCEED / RECONSIDER / REJECT
</trade_evaluation>
```

`risk-guardian <risk_validation>`:
```
<risk_validation>
TICKER: AAPL
SIDE: buy
VERDICT: APPROVED | REJECTED
... (existing fields)
</risk_validation>
```

Update prompts to instruct the sub-agent to emit TICKER + SIDE corresponding to the trade being evaluated.

Update `tests/subagent.test.ts` assertions for both agents to verify presence of TICKER + SIDE in prompt output format spec.

---

## Component 5 — `runAgentQuery` accepts hooks

**Location:** `src/agent.ts`

Extend `AgentQueryOptions` interface:

```typescript
import type { HookEvent, HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";

export interface AgentQueryOptions {
  // ... existing fields
  /** PreToolUse / PostToolUse / Stop hooks (passed through to SDK) */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}
```

Pass `options.hooks` through to the SDK `query()` options. No transformation needed.

---

## Component 6 — `session-init` rule simplification

**Location:** `src/skills.ts` (modify FUND_RULES entry for `session-init.md`)

Current rule (autonomous mode section): "Read `state/session-handoff.md`, `state/portfolio.json`, `state/objective_tracker.json`... in order... write Session Contract..."

Simplified rule:

```markdown
## Applies to
Autonomous scheduled sessions (mode prefix: "Session mode: autonomous scheduled").

## What you receive
You begin each session with a <state_snapshot> envelope in your first user message
containing the same artifacts the previous version of this rule asked you to read:
session-handoff, portfolio, objective_tracker, pending_sessions, recent trades,
watchlist. Interpret the snapshot directly. The state files in `state/` remain the
canonical source if you need to re-read something specific (e.g., the full journal
beyond top 10).

## What you must do
1. Verify state integrity: portfolio.json cash + positions = capital.initial. If not,
   stop and surface the discrepancy.
2. Write a Session Contract to `state/session-handoff.md` (replace prior contents'
   `## Session Contract` block) declaring:
   - This session's intent in 1-2 sentences
   - The success criteria
   - What "done" looks like
3. Proceed with the session protocol.
```

Run `tests/skills.test.ts` to verify the rule content assertions still pass; update if any reference the removed file-reading sequence.

After this change: `pnpm dev -- fund upgrade --all` to propagate to existing funds.

---

## Definition of Done

### Unit-test level

1. **`tests/verdict-tracker.test.ts`** (~20 tests):
   - `observe` extracts TICKER+SIDE+RECOMMENDATION from `<trade_evaluation>` in tool_result content.
   - `observe` extracts TICKER+SIDE+VERDICT from `<risk_validation>` in tool_result content.
   - `observe` ignores messages without verdict XML.
   - `mostRecent` returns latest verdict for matching (source, ticker, side).
   - `mostRecent` returns undefined for non-matching tuples.
   - `checkPlaceOrder` BUY: both APPROVED → returns approve.
   - `checkPlaceOrder` BUY: missing evaluator → block with explanatory message.
   - `checkPlaceOrder` BUY: missing guardian → block.
   - `checkPlaceOrder` BUY: evaluator REJECT → block.
   - `checkPlaceOrder` SELL: only guardian APPROVED → approve.
   - `checkPlaceOrder` SELL: missing guardian → block.
   - `checkPlaceOrder` parse failure (malformed XML) → block, helpful message.
   - Edge: subsequent verdict for same (source, ticker, side) overrides earlier.
   - Edge: `observe` handles message with no `content` field gracefully.
   - Edge: `observe` handles tool_result with non-string content gracefully.

2. **`tests/snapshot.test.ts`** (~10 tests):
   - All 6 files present → returns full XML envelope with all sections.
   - Missing handoff → `<session_handoff>(none — first session)</session_handoff>`.
   - Missing pending_sessions → `(none)` placeholder.
   - Empty journal → `<recent_trades>(empty)</recent_trades>`.
   - Empty watchlist → `(empty)` placeholder.
   - Returns valid string when state directory does not exist (fund created moments ago).
   - Snapshot opens with `<state_snapshot>` and closes with `</state_snapshot>`.
   - Snapshot length under 50KB (sanity check; not a hard cap, just regression detection).

3. **Existing tests still green** (`pnpm test`).

### Integration level

4. **Smoke test 1: BUY without verdicts → denied.** Paper session on `fundx-audit` where the agent attempts `place_order(buy, X)` without first invoking trade-evaluator/risk-guardian → tool fails with denial systemMessage. Verify in session log + transcript that the message reaches the agent.

5. **Smoke test 2: BUY with verdicts → allowed.** Same fund, agent invokes both evaluators with PROCEED/APPROVED for the same (ticker, side), then `place_order` → succeeds. Verify trade in `portfolio.json` post-session.

6. **Smoke test 3: SELL with only risk-guardian → allowed.** Agent invokes risk-guardian APPROVED for SELL of an existing position, then `place_order(sell)` → succeeds.

7. **MVP eval suite passes** (`pnpm dev -- eval --filter mvp-`). Eval cases are read-only (chat/ask) so don't pass through `runFundSession` hooks, but verify no regression.

### Documentation

8. `CLAUDE.md` "Configuration" section gets a one-line mention of the snapshot + hook gate.
9. `session-init` rule updated and propagated via `fundx fund upgrade --all`.

### Roadmap update

10. `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md` status log entry: "Phase 2 complete: G3 via state snapshot pre-population, G1 via PreToolUse hook gate. Closes both gaps."

---

## Risks

| Risk | Mitigation |
|---|---|
| Verdict parsing brittleness (sub-agent emits malformed XML → hook denies legit trade) | Graceful try/catch in `observe`; warning log; fallback: parse failure → verdict not tracked → place_order denied (safe direction); unit tests cover edge cases. |
| False-positive denials in production (parser misses verdict that was emitted) | Extensive unit tests + 3 smoke tests with realistic scenarios; log every block in `daemon.log` + Telegram alert for visibility; rollback path = revert `hooks` field in `runAgentQuery`. |
| Pre-population token cost (~$0.02 / session × ~5 funds × ~3 sessions/day = ~$0.30/day overhead) | Trivial vs per-session $5 cap. Optimisation lever: drop watchlist + journal sections (drops ~30%) if cost becomes a concern. |
| Hook callback latency (synchronous before each place_order) | Tracking is in-memory (no file I/O); regex parsing is sub-millisecond. <10ms per call expected. |
| Backward compat with first-session funds (no state files) | `buildStateSnapshot` handles missing files gracefully with `(none)` markers; tests cover this. |
| `session-init` rule oversimplified — Opus 4.7 still needs orient sequence | Rule retains content (not deleted); smoke test 2 verifies agent comprehends pre-loaded state and proceeds. If failure observed in production, rule can be expanded back. |
| Hook denies daemon-triggered stop-loss exits (false positive) | Daemon stop-loss code path does NOT use `runAgentQuery`/hook. Confirm during implementation that the stop-loss execution flow bypasses the agent entirely. |

**Failure-mode bias is fail-closed**: hook denies on parse error or missing data. The cost of a false-positive deny (legit trade blocked, user investigates) is much smaller than a false-negative allow (rogue trade slips through gate, real money lost — even paper).

---

## Effort

**~3.5 days** distributed as:

| Component | Days |
|---|---:|
| `VerdictTracker` + ~20 unit tests | 1.0 |
| `buildStateSnapshot` + ~10 unit tests | 0.5 |
| Subagent prompt updates + test updates | 0.25 |
| `AgentQueryOptions` hooks pass-through | 0.25 |
| Wire in `runFundSession` | 0.5 |
| `session-init` rule simplification + skills test | 0.25 |
| Smoke tests (3 scenarios) + MVP eval | 0.5 |
| Docs + roadmap | 0.25 |
| **Total** | **~3.5** |

---

## Cost expectation

| Item | Cost |
|---|---:|
| 3 smoke tests (~$3-5 each) | $9-15 |
| MVP eval re-run | ~$2.80 |
| Possible re-runs / debugging | $5-10 |
| **Total expected** | **$17-28** |

Well within Phase 1b-comparable budget.

---

## Implementation order (TDD bite-sized for `writing-plans`)

1. **`VerdictTracker` class** (TDD, isolated unit, no dependencies). Test → impl → commit.
2. **`buildStateSnapshot` helper** (TDD, isolated unit, mock fs). Test → impl → commit.
3. **Subagent prompt updates** — add TICKER+SIDE to two outputs in `subagent.ts`. Update existing assertions. Commit.
4. **`AgentQueryOptions` hooks field** — add type field in `agent.ts`, pass through to SDK `query()`. Commit.
5. **Wire in `runFundSession`** — load snapshot, instantiate tracker, register hook. Update `tests/session.test.ts` mocks. Commit.
6. **`session-init` rule simplification** — edit content in `src/skills.ts`. Update assertions. `fund upgrade --all`. Commit.
7. **3 smoke tests** on `fundx-audit` (still exists from Phase 1b) + MVP eval verification. Commit log update.
8. **Docs + roadmap** — CLAUDE.md, status log entry. Commit.

Each task small-medium with separate commits. Total: ~8 commits.
