# L3 Reliability — Self-Healing, Integration Tests, and Operational Polish

**Date:** 2026-05-10
**Status:** Draft (awaiting user review)
**Owner:** michael
**Roadmap context:** Phase 5 of harness hardening; refines L3 (Conditional Autonomy with weekly-monthly human review). Explicitly **not** chasing L4 features (live broker, cross-fund rebalancing).

## Goal

Increase harness reliability and autonomy under L3 supervision by:

1. **Phase 5a — Self-healing primitives**: absorb common transient failures (auth expiration, hung sessions, MCP crashes, transient API errors) without crashing the daemon or losing sessions.
2. **Phase 5b — Integration test suite**: cover end-to-end seams that current unit tests miss (`runFundSession` wiring, daemon tick, self-healing scenarios).
3. **Phase 5c — Heartbeat doc + cap defaults**: document the deferred live heartbeat smoke procedure; raise `dailyCapUsd` default from $5 → $20 to align with the user's "quality over cost-control" stance.

**Out of scope** (deferred or in eval domain):
- Tool payloads in LLM-judge prompt — eval domain, separate Phase 6 candidate.
- `mvp-portfolio-review-spanish` nightly CI watch — eval domain, monitoring already in place.
- Live broker integration, cross-fund autonomous rebalancing — L4 features.
- Phase 1c soft-warning at 75% budget — dropped (the user prioritises continuity quality over cost reduction; raising the cap default + relying on hard-kill at 100% is sufficient).

## Implementation deviations (2026-05-10)

- **5a.1 Auth in-place refresh — DROPPED.** Code review of the WIP `reloadAuthToken` helper revealed the design assumption was wrong: `claude_code_oauth_token` does not exist in `globalConfigSchema` and is never written to `~/.fundx/config.yaml`. The token lives only in `process.env.CLAUDE_CODE_OAUTH_TOKEN`, inherited from the user's shell at `fundx start` time. There is no persistent source of truth from which to "reload". Persisting the OAuth token in plain YAML was rejected as a security tradeoff. The current `daemon.needs-restart` path remains (user re-runs `fundx start` after `claude` re-auth in their shell) — visible blip on token expiry, but infrequent (weeks-to-months cadence) and acceptable for L3. Self-healing scope shrinks from 4 → 3 primitives: watchdog, MCP transport retry, FMP/Telegram retries.

## Architecture & module layout

The work touches four existing service files and adds two new pure helpers + a new integration test directory.

```
src/
  services/
    auth.service.ts          (NEW) — reloadAuthToken() helper, propagates current OAuth token to env
    retry.service.ts         (NEW) — withRetry(fn, opts) helper: backoff exponencial, jitter, max attempts
    session.service.ts       (modify) — wall-clock watchdog in runFundSession
    market.service.ts        (modify) — wrap FMP/Yahoo calls in withRetry
    gateway.service.ts       (modify) — wrap Telegram sends in withRetry
  agent.ts                   (modify) — auth-error detection + 1 retry; MCP transport-error retry
  mcp/
    telegram-notify.ts       (modify) — wrap MCP-driven sends in withRetry

tests/
  integration/               (NEW dir)
    run-fund-session.test.ts (NEW) — e2e with mock SDK
    daemon-tick.test.ts      (NEW) — real daemon subprocess, accelerated cron
    self-healing.test.ts     (NEW) — 4 failure-mode scenarios

docs/
  operations.md              (modify) — add manual heartbeat smoke procedure
```

**Boundary principle**: `withRetry` is pure and reusable. Each call site supplies a `shouldRetry` predicate that decides what is retryable for that domain (transport vs application errors, retryable HTTP codes, etc.). The helper does not embed any domain knowledge.

## Phase 5a — Self-healing primitives

### Shared helper — `withRetry`

```typescript
// src/services/retry.service.ts
export interface RetryOptions {
  maxAttempts: number;          // default 3
  baseDelayMs: number;          // default 500
  maxDelayMs: number;           // default 8000
  jitter: boolean;              // default true (±25%)
  shouldRetry: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T>;
```

Backoff: `min(maxDelayMs, baseDelayMs * 2^(attempt-1))` with optional ±25% jitter. The helper tracks attempts, sleeps between retries, and rethrows after `maxAttempts`. Logging happens via `onRetry` callback (call site owns the log format).

### 5a.1 — Auth token in-place refresh

**Today:** `runAgentQuery` does not detect 401 errors from the SDK; the error propagates and the session runner writes `daemon.needs-restart` → supervisor kills the daemon → `forkSupervisor` reads the new token from env on relaunch. This is the most frequent restart cause in normal operation.

**Change:**
- New helper `reloadAuthToken()` in `src/services/auth.service.ts`: re-reads `CLAUDE_CODE_OAUTH_TOKEN` from `~/.fundx/config.yaml` and assigns it to `process.env`. Idempotent.
- In `runAgentQuery` (`src/agent.ts`), wrap the `for await` in a try/catch that detects auth errors (status 401, message includes `invalid_token` or `expired_token`).
- On detection: call `reloadAuthToken()` and retry the query **once** with the fresh token (rebuilding the child env to pick up the new value).
- If the retry also fails with auth error → fall through to existing `daemon.needs-restart` path. No infinite ladder.

**Files touched:** `src/agent.ts`, new `src/services/auth.service.ts`, `src/services/index.ts` (barrel export).

### 5a.2 — Watchdog interno (sesiones colgadas)

**Today:** `runAgentQuery` accepts `timeoutMs` that triggers `abortController.abort()`. If the SDK ignores the abort (deadlock in MCP, generator stuck), the session hangs and blocks the next cron tick.

**Change:**
- In `runFundSession` (`src/services/session.service.ts`), register an absolute wall-clock timer `WATCHDOG_HARD_MS = 20 * 60 * 1000` (20 minutes; configurable per session type via fund/global config in a follow-up if needed).
- If the timer fires while the SDK call is still active, escalate by:
  1. First attempt: `abortController.abort()` (existing path).
  2. After 5s grace: `process.kill(childPid, "SIGKILL")` on the SDK subprocess. PID is captured via the SDK's `onProcessSpawn` callback (verify exact API at implementation time; fall back to `pgrep` of the child process tree if the SDK does not expose it).
- Log session result with `status: "watchdog_killed"` in `session_log.jsonl`.
- Send Telegram alert "Session watchdog killed — `<fund>` `<session-type>` exceeded 20min hard ceiling".

**Files touched:** `src/services/session.service.ts`, `src/types.ts` (add `"watchdog_killed"` to `sessionLogV2Schema.status` enum).

### 5a.3 — MCP server crash recovery

**Today:** if an MCP server (broker-local, market-data, etc.) crashes mid-query (EPIPE/ECONNREFUSED on stdio transport), the SDK propagates the error and the session fails.

**Change:**
- In `runAgentQuery`, catch errors with transport-level error codes (`EPIPE`, `ECONNREFUSED`, `ECONNRESET`, `ENOENT` from stdio launch) using `withRetry` (maxAttempts=2, baseDelay=1000ms).
- Application-level errors (tool returned an error response) are NOT retried — only transport failures.
- `buildMcpServers` already respawns subprocesses per query, so the retry naturally launches a fresh MCP server.

**Files touched:** `src/agent.ts`.

### 5a.4 — Telegram + FMP retries con backoff

**FMP retries** (`src/services/market.service.ts`):
- Wrap each FMP call in `withRetry` (maxAttempts=3, baseDelay=1000ms, max=8000ms).
- `shouldRetry`: HTTP 429, 5xx, network timeout. NOT 4xx (auth errors).
- After exhausting retries → fallback to Yahoo Finance (existing path).

**Telegram retries** (`src/services/gateway.service.ts` + `src/mcp/telegram-notify.ts`):
- Wrap sends in `withRetry` (maxAttempts=3, baseDelay=500ms, max=4000ms).
- `shouldRetry`: HTTP 429, 5xx, network timeout. NOT 4xx (chat invalid, auth wrong) — those are config errors that retries cannot fix.

**Files touched:** `src/services/market.service.ts`, `src/services/gateway.service.ts`, `src/mcp/telegram-notify.ts`.

## Phase 5b — Integration test suite

New directory `tests/integration/`. Vitest config update: `test.poolOptions.threads.singleThread: true` for integration suite to avoid filesystem race conditions. New `pnpm test:integration` script runs only `tests/integration/`. `pnpm test` runs both unit + integration. CI workflow gains a step running integration on every PR (in addition to existing unit tests).

### 5b.1 — `run-fund-session.test.ts`

**Setup:**
- Seed an ephemeral fund using `seed.ts` from the eval harness (already exists, reused).
- Mock `query()` from `@anthropic-ai/claude-agent-sdk` with `vi.mock()` to emit a deterministic message stream: assistant text → tool_use stub (e.g., place_order with valid verdicts pre-set) → result message with cost/turns.
- Mock FMP via fetch interceptor for static prices.
- Telegram MCP server stubbed to write to a file instead of sending.

**Asserts (one large test, single run):**
1. `<state_snapshot>` envelope generated and prefixed to the first prompt.
2. `state/handoffs/<ts>_<type>.md` archived before the run starts.
3. Post-run: `session-handoff.md` updated, `session_log.jsonl` has the new entry, `daily_cap_state.json` absent (cap not breached).
4. PreToolUse hook honors verdict gate (happy path with verdicts pre-set: `place_order` succeeds).
5. `cost_usd > 0`, `num_turns > 0` recorded.

**Targets:** $0 (all mocked); < 5 sec.

### 5b.2 — `daemon-tick.test.ts`

**Setup:**
- Spawn daemon as a subprocess targeting an isolated `~/.fundx-test-<ulid>/` workspace.
- Workspace seeded with global config containing `daemon.tick_interval_ms: 1000` (new optional field). The daemon reads this from config; no env vars or CLI flags.
- Same mock SDK as 5b.1 (loaded by the subprocess via the test's mock setup).

**Asserts:**
1. Daemon starts: `daemon.pid` and `daemon.heartbeat` written.
2. After 2s: cron tick fired, `session_log.jsonl` has ≥1 entry.
3. Heartbeat refreshes every 60s (verify mtime updates between samples).
4. SIGTERM to daemon → ordered cleanup (PIDs unlinked).

**Targets:** $0; ~5–10 sec (2 ticks + cleanup).

### 5b.3 — `self-healing.test.ts`

Four tests, one per Phase 5a primitive:

| Test | Failure injected | Verification |
|---|---|---|
| Auth refresh | Mock SDK throws `401 invalid_token` on first call, succeeds on second | `runAgentQuery` returns success, `daemon.needs-restart` NOT written |
| Watchdog | Mock SDK with generator that never yields | After `WATCHDOG_HARD_MS` (override to 500ms for test via injected option), session returns `status: "watchdog_killed"` |
| MCP retry | Mock query throws `EPIPE` on first call, succeeds on second | `withRetry` retried, success on attempt 2 |
| Telegram/FMP backoff | Mock fetch returns 503 twice then 200 | Call ends success, 3 attempts logged via `onRetry` callback |

**Targets:** $0; < 5 sec total.

## Phase 5c — Heartbeat doc + cap defaults

### Heartbeat smoke procedure

Add a new section to `docs/operations.md`:

```markdown
## Heartbeat smoke test (manual)

When restarting the daemon for any reason, validate the heartbeat alert path:

1. `fundx stop && fundx start`
2. `kill -STOP <pid>` (find pid in `~/.fundx/daemon.pid`)
3. Wait 4 minutes
4. Confirm Telegram alert "Daemon heartbeat stale" arrived
5. `kill -CONT <pid>`
6. Wait 60 seconds
7. Confirm Telegram alert "Daemon heartbeat recovered" arrived
8. Verify `~/.fundx/daemon.heartbeat` mtime is fresh
```

### Cap defaults bump

- `resolveDailyCapUsd` default: $5 → $20 in `src/services/session.service.ts`. Reasoning: the user prioritises continuity/quality over cost control. $20/day still serves as a runaway-budget safety net (e.g., infinite-loop bug) without throttling normal operation.
- `maxBudgetUsd` global default: remains undefined (no per-session cap unless explicitly set). Document in `CLAUDE.md` Configuration section that the user can set this if they want stricter cost control.
- Funds that explicitly set their own cap in `fund_config.yaml` are unaffected (cascade respects fund > global > default).

**Files touched:** `src/services/session.service.ts`, `tests/budget.test.ts`, `CLAUDE.md`, `docs/operations.md`.

## Cross-cutting decisions

| Decision | Resolution |
|---|---|
| Logging of retries | `withRetry.onRetry` writes to stderr with prefix `[retry] <call_site> attempt=N delay=Xms err=<message>` |
| Telegram alert on watchdog kill | Yes — high-signal event, should not happen frequently |
| Self-healing alert frequency | Recovered self-heals (auth/MCP retry succeeded) are NOT alerted (logs sufficient). Only failures that exhaust retries and kill the session alert (status quo, no change) |
| Backwards compat | `dailyCapUsd` default bump only affects funds that did not set explicit cap. Existing funds with their own cap untouched |
| PR strategy | Three separate PRs: 5a → 5b → 5c. Each merges, smoke-tests against `fundx-audit`, then next starts |

## Testing strategy

**Unit tests** (vitest, in `tests/`):
- `tests/retry.test.ts` (NEW) — withRetry: backoff, jitter, shouldRetry predicate, max attempts, onRetry callback
- `tests/auth-reload.test.ts` (NEW) — reloadAuthToken: reads config, propagates to env, idempotent
- `tests/agent-auth-retry.test.ts` (NEW) — runAgentQuery with mock SDK throwing 401 → retries; double 401 → escalates to needs-restart
- `tests/session-watchdog.test.ts` (NEW) — runFundSession with hung SDK → kills after WATCHDOG_HARD_MS
- `tests/agent-mcp-retry.test.ts` (NEW) — runAgentQuery with MCP throwing EPIPE → retries; application error → no retry
- `tests/market-retry.test.ts` (NEW) — FMP 503 → retries → Yahoo fallback after 3 failures
- `tests/gateway-retry.test.ts` (NEW) — Telegram 429 → retries; 401 → no retry

**Integration tests** (vitest, in `tests/integration/`):
- The three from §Phase 5b.

**Modified tests:**
- `tests/budget.test.ts` — update default `dailyCapUsd: 5 → 20`.
- `tests/daemon-integration.test.ts` — adapt if assertions reference cron interval directly.

**Coverage target:** 100% lines on new pure helpers (`retry.service.ts`, `auth.service.ts`); critical branches on `session.service.ts` watchdog and `agent.ts` auth/MCP retry paths.

## Definition of Done

### Phase 5a — Self-healing primitives
- [ ] `withRetry` + 7 unit tests passing
- [ ] `reloadAuthToken` + 3 unit tests passing
- [ ] Auth retry path in `runAgentQuery` with test of double-fail + escalation
- [ ] Watchdog in `runFundSession` with test of hung SDK + Telegram alert
- [ ] MCP transport-error retry in `agent.ts` with test
- [ ] FMP backoff + Yahoo fallback with test
- [ ] Telegram backoff with test (429 retry, 4xx no retry)
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` all green
- [ ] MVP eval suite green post-changes (regression check)

### Phase 5b — Integration test suite
- [ ] `tests/integration/run-fund-session.test.ts` runs in <5s, all asserts green
- [ ] `tests/integration/daemon-tick.test.ts` runs in <10s with real subprocess, JSONL grows, ordered cleanup
- [ ] `tests/integration/self-healing.test.ts` covers all 4 failure modes
- [ ] `pnpm test:integration` script added to `package.json`
- [ ] CI workflow runs integration tests on every PR

### Phase 5c — Heartbeat doc + cap defaults
- [ ] `docs/operations.md` has section "Heartbeat smoke test (manual)"
- [ ] `dailyCapUsd` default $5 → $20 in `resolveDailyCapUsd` + tests updated
- [ ] `CLAUDE.md` documents new default + how to set explicit cap if cost control is desired

### Roll-out
- 5a merge → smoke with `fundx-audit` (1 real session, confirm no regression) → 5b → smoke → 5c
- After 5a and 5b complete: update memory `project_harness_roadmap_complete.md` with new phase status

## References

- `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md` — original roadmap (G1-G7)
- `docs/superpowers/audit-1b/audit-log.md` — Phase 4 carry-overs (live heartbeat smoke deferred)
- `docs/operations.md` — operations runbook (will be extended in 5c)
- Memory `feedback_autonomy_target_l3.md` — L3-target rationale; explicit deferrals
