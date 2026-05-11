# L3 Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase harness reliability and autonomy under L3 supervision via three sub-phases: self-healing primitives (5a), integration test suite (5b), heartbeat doc + cap defaults bump (5c).

**Architecture:** Pure helpers (`withRetry`, `reloadAuthToken`) compose at call sites that own the failure-domain knowledge. Watchdog lives in `runFundSession`. Integration tests live in a new `tests/integration/` directory with single-thread vitest config to avoid filesystem race conditions. Each sub-phase is a separate PR — merge, smoke against `fundx-audit`, then start the next.

**Tech Stack:** TypeScript (strict, ESM), Node 20+, vitest, @anthropic-ai/claude-agent-sdk, node-cron, grammy.

**Spec:** `docs/superpowers/specs/2026-05-10-l3-reliability-design.md`

---

## File Structure

```
src/
  services/
    auth.service.ts          (NEW) — reloadAuthToken()
    retry.service.ts         (NEW) — withRetry()
    session.service.ts       (modify) — watchdog wall-clock
    market.service.ts        (modify) — wrap FMP fetches in withRetry
    gateway.service.ts       (modify) — wrap Telegram sends in withRetry
    daemon.service.ts        (modify) — read tick_interval_ms from global config
    index.ts                 (modify) — barrel exports for new services
  agent.ts                   (modify) — auth retry + MCP transport retry
  mcp/
    telegram-notify.ts       (modify) — wrap telegramRequest in withRetry
  types.ts                   (modify) — add "watchdog_killed" status; add daemon.tick_interval_ms

tests/
  retry.test.ts              (NEW)
  auth-reload.test.ts        (NEW)
  agent-auth-retry.test.ts   (NEW)
  session-watchdog.test.ts   (NEW)
  agent-mcp-retry.test.ts    (NEW)
  market-retry.test.ts       (NEW)
  gateway-retry.test.ts      (NEW)
  budget.test.ts             (modify) — update dailyCap default $5 → $20
  integration/               (NEW dir)
    run-fund-session.test.ts (NEW)
    daemon-tick.test.ts      (NEW)
    self-healing.test.ts     (NEW)

vitest.config.ts             (NEW) — projects config (unit + integration)
package.json                 (modify) — add test:integration script
docs/operations.md           (modify) — add Heartbeat smoke section
CLAUDE.md                    (modify) — document new dailyCapUsd default
```

---

# PHASE 5a — Self-Healing Primitives

## Task 5a.1: `withRetry` helper

**Files:**
- Create: `src/services/retry.service.ts`
- Test: `tests/retry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/retry.test.ts
import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/services/retry.service.js";

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: false, shouldRetry: () => true });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success when shouldRetry returns true", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10, jitter: false, shouldRetry: () => true });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when shouldRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10, jitter: false, shouldRetry: () => false }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows after exhausting maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("never gives up"));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: false, shouldRetry: () => true }),
    ).rejects.toThrow("never gives up");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses exponential backoff capped at maxDelayMs", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockRejectedValueOnce(new Error("c"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    await withRetry(fn, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250, jitter: false, shouldRetry: () => true, onRetry });
    // attempt 1 → 100ms, attempt 2 → 200ms, attempt 3 → 250ms (capped)
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), 100);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), 200);
    expect(onRetry).toHaveBeenNthCalledWith(3, 3, expect.any(Error), 250);
  });

  it("applies jitter within ±25% when enabled", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    await withRetry(fn, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 5000, jitter: true, shouldRetry: () => true, onRetry });
    const delay = onRetry.mock.calls[0][2];
    expect(delay).toBeGreaterThanOrEqual(750);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it("calls onRetry before each retry, not on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const onRetry = vi.fn();
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: false, shouldRetry: () => true, onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/retry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `withRetry`**

```typescript
// src/services/retry.service.ts
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  shouldRetry: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
}

const DEFAULT_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitter: true,
};

function computeDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: boolean): number {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  if (!jitter) return exp;
  const factor = 0.75 + Math.random() * 0.5;
  return Math.round(exp * factor);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> & Pick<RetryOptions, "shouldRetry">,
): Promise<T> {
  const merged: RetryOptions = { ...DEFAULT_OPTIONS, ...opts };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= merged.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt === merged.maxAttempts;
      if (isLast || !merged.shouldRetry(err)) throw err;
      const delay = computeDelay(attempt, merged.baseDelayMs, merged.maxDelayMs, merged.jitter);
      merged.onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: Add to services barrel**

Modify `src/services/index.ts`: add `export * from "./retry.service.js";`

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/retry.test.ts`
Expected: PASS (7/7).

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/services/retry.service.ts src/services/index.ts tests/retry.test.ts
git commit -m "feat(retry): add withRetry helper with exponential backoff + jitter"
```

---

## Task 5a.2: `reloadAuthToken` helper

**Files:**
- Create: `src/services/auth.service.ts`
- Test: `tests/auth-reload.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/auth-reload.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reloadAuthToken } from "../src/services/auth.service.js";
import * as configMod from "../src/config.js";

describe("reloadAuthToken", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalEnv;
    vi.restoreAllMocks();
  });

  it("propagates the token from config to process.env", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.spyOn(configMod, "loadGlobalConfig").mockResolvedValue({
      claude_code_oauth_token: "fresh-token-123",
    } as never);
    await reloadAuthToken();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fresh-token-123");
  });

  it("returns false when config has no token", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.spyOn(configMod, "loadGlobalConfig").mockResolvedValue({} as never);
    const ok = await reloadAuthToken();
    expect(ok).toBe(false);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("returns true when token is propagated", async () => {
    vi.spyOn(configMod, "loadGlobalConfig").mockResolvedValue({
      claude_code_oauth_token: "abc",
    } as never);
    const ok = await reloadAuthToken();
    expect(ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/auth-reload.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `reloadAuthToken`**

```typescript
// src/services/auth.service.ts
import { loadGlobalConfig } from "../config.js";

/** Re-read CLAUDE_CODE_OAUTH_TOKEN from the global config and propagate to process.env.
 *  Returns true if a token was found and propagated; false if no token in config.
 *  Used by runAgentQuery's auth-error retry path to recover without daemon restart. */
export async function reloadAuthToken(): Promise<boolean> {
  const cfg = await loadGlobalConfig();
  const token = (cfg as { claude_code_oauth_token?: string }).claude_code_oauth_token;
  if (!token) return false;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return true;
}
```

- [ ] **Step 4: Add to services barrel**

Modify `src/services/index.ts`: add `export * from "./auth.service.js";`

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm test tests/auth-reload.test.ts && pnpm typecheck`
Expected: PASS (3/3); 0 type errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/auth.service.ts src/services/index.ts tests/auth-reload.test.ts
git commit -m "feat(auth): add reloadAuthToken helper for in-place token refresh"
```

---

## Task 5a.3: Auth retry in `runAgentQuery`

**Files:**
- Modify: `src/agent.ts` (catch block around `for await`, ~line 316–326)
- Test: `tests/agent-auth-retry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent-auth-retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DAEMON_NEEDS_RESTART } from "../src/paths.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@anthropic-ai/claude-agent-sdk");
  return { ...actual, query: vi.fn() };
});

vi.mock("../src/services/auth.service.js", () => ({
  reloadAuthToken: vi.fn().mockResolvedValue(true),
}));

const mocked = await import("@anthropic-ai/claude-agent-sdk");
const { query } = mocked as unknown as { query: ReturnType<typeof vi.fn> };

import { runAgentQuery } from "../src/agent.js";
import { reloadAuthToken } from "../src/services/auth.service.js";
// Note: This test requires a fund fixture; see tests/integration/run-fund-session.test.ts
// for the real seed pattern. For unit-level coverage, point at an existing scratch fund.

describe("runAgentQuery auth retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (existsSync(DAEMON_NEEDS_RESTART)) void unlink(DAEMON_NEEDS_RESTART).catch(() => {});
  });

  afterEach(async () => {
    if (existsSync(DAEMON_NEEDS_RESTART)) await unlink(DAEMON_NEEDS_RESTART).catch(() => {});
  });

  function makeQueryStream(messages: unknown[], throwAtStart?: Error): AsyncGenerator<unknown> {
    return (async function* () {
      if (throwAtStart) throw throwAtStart;
      for (const m of messages) yield m;
    })();
  }

  it("retries once on auth error, succeeds with fresh token", async () => {
    const successMessages = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, num_turns: 1, modelUsage: {}, session_id: "sess-1" },
    ];
    const authError = Object.assign(new Error("invalid_token"), { status: 401 });

    query
      .mockReturnValueOnce(makeQueryStream([], authError))
      .mockReturnValueOnce(makeQueryStream(successMessages));

    const result = await runAgentQuery({ fundName: "fundx-audit", prompt: "test" });
    expect(result.status).toBe("success");
    expect(reloadAuthToken).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(existsSync(DAEMON_NEEDS_RESTART)).toBe(false);
  });

  it("after double auth-fail, writes daemon.needs-restart and surfaces error", async () => {
    const authError = Object.assign(new Error("expired_token"), { status: 401 });
    query
      .mockReturnValueOnce(makeQueryStream([], authError))
      .mockReturnValueOnce(makeQueryStream([], authError));

    const result = await runAgentQuery({ fundName: "fundx-audit", prompt: "test" });
    expect(result.status).toBe("error");
    expect(query).toHaveBeenCalledTimes(2);
    expect(existsSync(DAEMON_NEEDS_RESTART)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/agent-auth-retry.test.ts`
Expected: FAIL — `daemon.needs-restart` is never written by current code.

- [ ] **Step 3: Add helper functions in `src/agent.ts`**

Insert near the top of `src/agent.ts` (after imports):

```typescript
import { writeFile } from "node:fs/promises";
import { DAEMON_NEEDS_RESTART } from "./paths.js";
import { reloadAuthToken } from "./services/auth.service.js";

const AUTH_ERROR_PATTERN = /(invalid_token|expired_token|401|unauthorized)/i;

function isAuthError(err: unknown): boolean {
  if (err instanceof Error) {
    if (AUTH_ERROR_PATTERN.test(err.message)) return true;
    const status = (err as { status?: number }).status;
    if (status === 401) return true;
  }
  return false;
}

async function flagDaemonRestart(reason: string): Promise<void> {
  try {
    await writeFile(DAEMON_NEEDS_RESTART, reason, "utf-8");
  } catch (err) {
    console.warn(`[agent] failed to write daemon.needs-restart: ${err instanceof Error ? err.message : err}`);
  }
}
```

- [ ] **Step 4: Refactor the for-await block to support retry**

Find the current `try { for await (const message of query({...})) {...} } catch (err) {...}` block (`src/agent.ts:238-326`). Wrap it in an attempt loop:

```typescript
  let attemptedAuthRetry = false;
  let queryAttempt = 0;
  authRetryLoop: while (true) {
    queryAttempt++;
    // Reset accumulators on retry
    output = "";
    costUsd = 0;
    numTurns = 0;
    modelUsage = {};
    sessionId = "";
    status = "success";
    error = undefined;
    toolHistory.length = 0;
    activeBlockType = null;
    activeToolName = null;
    activeToolStartedAt = null;

    try {
      for await (const message of query({
        prompt: options.prompt,
        options: {
          model,
          maxTurns: options.maxTurns ?? 50,
          maxBudgetUsd: options.maxBudgetUsd ?? globalConfig.max_budget_usd ?? undefined,
          cwd: paths.root,
          env: childEnv,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["project"],
          mcpServers,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController,
          agents: options.agents,
          ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
          ...(options.hooks ? { hooks: options.hooks } : {}),
        },
      })) {
        // ... (existing onMessage forwarding + stream_event tracking + result capture)
      }
      break authRetryLoop;
    } catch (err) {
      if (err instanceof AbortError || (err instanceof Error && err.name === "AbortError")) {
        status = "timeout";
        error = "Query timed out";
        break authRetryLoop;
      }
      if (isAuthError(err) && !attemptedAuthRetry && costUsd === 0 && numTurns === 0) {
        attemptedAuthRetry = true;
        const ok = await reloadAuthToken();
        if (ok) {
          // Rebuild childEnv with fresh token
          childEnv["CLAUDE_CODE_OAUTH_TOKEN"] = process.env["CLAUDE_CODE_OAUTH_TOKEN"] ?? "";
          continue authRetryLoop;
        }
      }
      if (isAuthError(err)) {
        await flagDaemonRestart(`auth retry exhausted: ${err instanceof Error ? err.message : String(err)}`);
      }
      status = "error";
      error = err instanceof Error ? err.message : String(err);
      break authRetryLoop;
    }
  }
```

(Keep the existing finally `clearTimeout(timeoutId)`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/agent-auth-retry.test.ts`
Expected: PASS (2/2).

- [ ] **Step 6: Run full test suite to verify no regression**

Run: `pnpm test`
Expected: All previous tests still PASS.

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/agent.ts tests/agent-auth-retry.test.ts
git commit -m "feat(agent): in-place auth-token refresh with single retry before daemon restart"
```

---

## Task 5a.4: Watchdog in `runFundSession`

**Files:**
- Modify: `src/types.ts:616` (add `"watchdog_killed"` to status enum)
- Modify: `src/services/session.service.ts` (around `runAgentQuery` call, ~line 346)
- Test: `tests/session-watchdog.test.ts`

- [ ] **Step 1: Add `"watchdog_killed"` status enum**

Modify `src/types.ts:616`. Replace:

```typescript
    .enum(["success", "error_max_turns", "error_max_budget", "error", "timeout", "skipped_daily_cap"])
```

With:

```typescript
    .enum(["success", "error_max_turns", "error_max_budget", "error", "timeout", "skipped_daily_cap", "watchdog_killed"])
```

Same line, also update `AgentQueryResult["status"]` in `src/agent.ts` (search for the union type and add `"watchdog_killed"`).

- [ ] **Step 2: Write the failing test**

```typescript
// tests/session-watchdog.test.ts
import { describe, it, expect, vi } from "vitest";
import { evaluateWatchdog } from "../src/services/session.service.js";

describe("evaluateWatchdog (pure)", () => {
  it("does not fire when query completes in time", () => {
    const r = evaluateWatchdog({ now: 1000, startedAtMs: 0, hardCeilingMs: 2000, queryActive: false });
    expect(r.shouldKill).toBe(false);
  });

  it("does not fire when query active but within ceiling", () => {
    const r = evaluateWatchdog({ now: 1500, startedAtMs: 0, hardCeilingMs: 2000, queryActive: true });
    expect(r.shouldKill).toBe(false);
  });

  it("fires when query active and over ceiling", () => {
    const r = evaluateWatchdog({ now: 2500, startedAtMs: 0, hardCeilingMs: 2000, queryActive: true });
    expect(r.shouldKill).toBe(true);
    expect(r.elapsedMs).toBe(2500);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/session-watchdog.test.ts`
Expected: FAIL — `evaluateWatchdog` not exported.

- [ ] **Step 4: Add `evaluateWatchdog` pure helper to `session.service.ts`**

Insert near the top of `src/services/session.service.ts` (after the existing constants):

```typescript
const WATCHDOG_HARD_MS = 20 * 60 * 1000; // 20 minutes

export interface WatchdogInput {
  now: number;
  startedAtMs: number;
  hardCeilingMs: number;
  queryActive: boolean;
}

export interface WatchdogResult {
  shouldKill: boolean;
  elapsedMs: number;
}

/** Pure: decide whether the wall-clock watchdog should kill the session. */
export function evaluateWatchdog(input: WatchdogInput): WatchdogResult {
  const elapsedMs = input.now - input.startedAtMs;
  return {
    shouldKill: input.queryActive && elapsedMs > input.hardCeilingMs,
    elapsedMs,
  };
}
```

- [ ] **Step 5: Wire watchdog into `runFundSession`**

Modify the `try { result = await runAgentQuery(...) }` block in `runFundSession` (around `src/services/session.service.ts:344-376`). Wrap in a Promise.race + watchdog timer:

```typescript
  let queryActive = true;
  let watchdogFired = false;
  const watchdogPromise = new Promise<never>((_, reject) => {
    const timer = setInterval(() => {
      const r = evaluateWatchdog({
        now: Date.now(),
        startedAtMs,
        hardCeilingMs: WATCHDOG_HARD_MS,
        queryActive,
      });
      if (r.shouldKill) {
        watchdogFired = true;
        clearInterval(timer);
        reject(new Error(`watchdog_killed after ${Math.round(r.elapsedMs / 1000)}s`));
      }
    }, 30_000); // check every 30s
    // Allow the timer to be cleared from outside via the queryActive flag
  });

  let result;
  try {
    result = await Promise.race([
      runAgentQuery({
        fundName,
        prompt,
        model,
        maxTurns: effectiveMaxTurns,
        maxBudgetUsd: effectiveMaxBudgetUsd,
        timeoutMs: timeout,
        agents,
        resumeSessionId: activeSession?.session_id,
        ...buildTrackerHookOptions(verdictTracker, handoffTracker),
      }).finally(() => { queryActive = false; }),
      watchdogPromise,
    ]);

    // ...existing SESSION_EXPIRED retry block unchanged...
  } catch (err) {
    if (watchdogFired) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await notifySession(
        `❌ <b>${displayName}</b> — ${sessionType} <b>WATCHDOG KILLED</b>\n<i>${escapeHtml(errMsg)}</i>`,
      );
      result = {
        output: "",
        cost_usd: 0,
        duration_ms: Date.now() - startedAtMs,
        num_turns: 0,
        usage: {},
        session_id: "",
        status: "watchdog_killed" as const,
        error: errMsg,
        toolHistory: [],
        tokens_in: 0,
        tokens_out: 0,
      };
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      await notifySession(
        `❌ <b>${displayName}</b> — ${sessionType} FAILED\n<i>${escapeHtml(errMsg.slice(0, 400))}</i>`,
      );
      throw err;
    }
  }
```

- [ ] **Step 6: Run unit test + typecheck**

Run: `pnpm test tests/session-watchdog.test.ts && pnpm typecheck`
Expected: PASS (3/3); 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/agent.ts src/services/session.service.ts tests/session-watchdog.test.ts
git commit -m "feat(session): wall-clock watchdog kills sessions exceeding 20min hard ceiling"
```

---

## Task 5a.5: MCP transport-error retry

**Files:**
- Modify: `src/agent.ts` (auth-retry loop, add a parallel branch for MCP transport errors)
- Test: `tests/agent-mcp-retry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agent-mcp-retry.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@anthropic-ai/claude-agent-sdk");
  return { ...actual, query: vi.fn() };
});

const mocked = await import("@anthropic-ai/claude-agent-sdk");
const { query } = mocked as unknown as { query: ReturnType<typeof vi.fn> };

import { runAgentQuery } from "../src/agent.js";

function stream(messages: unknown[], throwAtStart?: Error): AsyncGenerator<unknown> {
  return (async function* () {
    if (throwAtStart) throw throwAtStart;
    for (const m of messages) yield m;
  })();
}

describe("runAgentQuery MCP transport retry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries once on EPIPE before any progress", async () => {
    const ok = [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, num_turns: 1, modelUsage: {}, session_id: "s1" },
    ];
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    query.mockReturnValueOnce(stream([], epipe)).mockReturnValueOnce(stream(ok));

    const result = await runAgentQuery({ fundName: "fundx-audit", prompt: "test" });
    expect(result.status).toBe("success");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on application errors (non-transport)", async () => {
    const appError = new Error("tool execution failed: invalid input");
    query.mockReturnValueOnce(stream([], appError));

    const result = await runAgentQuery({ fundName: "fundx-audit", prompt: "test" });
    expect(result.status).toBe("error");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry MCP error after progress was made", async () => {
    // Stream emits a tool_use, then crashes
    const partialThenCrash = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "tool_use", name: "mcp__broker-local__place_order" } },
      };
      throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    })();
    query.mockReturnValueOnce(partialThenCrash);

    const result = await runAgentQuery({ fundName: "fundx-audit", prompt: "test" });
    expect(result.status).toBe("error");
    expect(query).toHaveBeenCalledTimes(1); // no retry — there was progress
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/agent-mcp-retry.test.ts`
Expected: FAIL — current code does not retry transport errors.

- [ ] **Step 3: Add MCP transport detection + extend retry loop in `src/agent.ts`**

Add helper near `isAuthError`:

```typescript
const TRANSPORT_ERROR_CODES = new Set(["EPIPE", "ECONNREFUSED", "ECONNRESET", "ENOENT"]);

function isMcpTransportError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code && TRANSPORT_ERROR_CODES.has(code)) return true;
  }
  return false;
}
```

In the catch block of the auth-retry loop (Task 5a.3), add a new branch BEFORE the auth-error branch:

```typescript
      let attemptedMcpRetry = false;
      // ... existing attemptedAuthRetry declaration above ...

      // (inside catch block, after AbortError check)
      if (
        isMcpTransportError(err) &&
        !attemptedMcpRetry &&
        costUsd === 0 &&
        numTurns === 0 &&
        toolHistory.length === 0
      ) {
        attemptedMcpRetry = true;
        console.warn(`[agent] MCP transport error (${(err as { code?: string }).code}); retrying once`);
        continue authRetryLoop;
      }
```

Also: declare `attemptedMcpRetry` next to `attemptedAuthRetry` at the top of the loop.

- [ ] **Step 4: Run test + full suite**

Run: `pnpm test tests/agent-mcp-retry.test.ts && pnpm test`
Expected: 3/3 PASS for new test; all other tests still pass.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts tests/agent-mcp-retry.test.ts
git commit -m "feat(agent): retry once on MCP transport errors when no progress made"
```

---

## Task 5a.6: FMP retries with backoff

**Files:**
- Modify: `src/services/market.service.ts` (wrap fetch calls in `withRetry`)
- Test: `tests/market-retry.test.ts`

- [ ] **Step 1: Identify the FMP fetch helper to wrap**

In `src/services/market.service.ts`, find the existing `fetch(`${FMP_BASE}/...)` call sites. Each one currently does a single fetch. We will introduce a private helper `fetchFmpWithRetry(url, init)` that wraps the call.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/market-retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchFmpWithRetry } from "../src/services/market.service.js";

describe("fetchFmpWithRetry", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns response on first 200", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const r = await fetchFmpWithRetry("https://fmp.example/x");
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on 503 and succeeds on third attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const r = await fetchFmpWithRetry("https://fmp.example/x");
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 (rate limit)", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const r = await fetchFmpWithRetry("https://fmp.example/x");
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx (other than 429)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 401 }));
    const r = await fetchFmpWithRetry("https://fmp.example/x");
    expect(r.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("rethrows after 3 failed attempts", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const r = await fetchFmpWithRetry("https://fmp.example/x");
    expect(r.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test tests/market-retry.test.ts`
Expected: FAIL — `fetchFmpWithRetry` not exported.

- [ ] **Step 4: Implement `fetchFmpWithRetry` in `market.service.ts`**

Add near the top (after imports):

```typescript
import { withRetry } from "./retry.service.js";

const RETRYABLE_FMP_STATUSES = new Set([429, 500, 502, 503, 504]);

/** Fetch wrapper with backoff retry for transient FMP failures.
 *  Returns the final Response (even if non-OK after exhausting retries). */
export async function fetchFmpWithRetry(url: string, init?: RequestInit): Promise<Response> {
  return withRetry(
    async () => {
      const resp = await fetch(url, init);
      if (RETRYABLE_FMP_STATUSES.has(resp.status)) {
        const err = new Error(`FMP ${resp.status}`);
        (err as { resp?: Response }).resp = resp;
        throw err;
      }
      return resp;
    },
    {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 8000,
      jitter: true,
      shouldRetry: (err) => err instanceof Error && err.message.startsWith("FMP "),
      onRetry: (attempt, err, delayMs) => {
        console.warn(`[retry] fmp ${url.replace(/[?&]apikey=[^&]+/, "")} attempt=${attempt} delay=${delayMs}ms err=${(err as Error).message}`);
      },
    },
  ).catch((err) => {
    // After exhausting retries, return the last Response so callers can choose fallback
    if (err instanceof Error) {
      const resp = (err as { resp?: Response }).resp;
      if (resp) return resp;
    }
    throw err;
  });
}
```

- [ ] **Step 5: Replace existing FMP `fetch(` calls with `fetchFmpWithRetry(`**

In `src/services/market.service.ts`, replace each `fetch(` that targets `${FMP_BASE}` with `fetchFmpWithRetry(`. Lines (approximate, verify):
- 82, 86, 131, 164, 183 (FMP calls)
- Do NOT change the Yahoo Finance calls (those go through `yahoo-finance2` library, not raw fetch).
- Do NOT change SP500-constituent fetches (lines 442, 466) — those are GitHub raw, separate failure mode.

- [ ] **Step 6: Run test + full suite**

Run: `pnpm test tests/market-retry.test.ts && pnpm test`
Expected: 5/5 PASS for new; all other tests still pass.

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/services/market.service.ts tests/market-retry.test.ts
git commit -m "feat(market): retry FMP fetches on 429/5xx with exponential backoff"
```

---

## Task 5a.7: Telegram retries (gateway + MCP)

**Files:**
- Modify: `src/services/gateway.service.ts:372-380` (sendMessage fetch)
- Modify: `src/mcp/telegram-notify.ts:21-37` (telegramRequest)
- Test: `tests/gateway-retry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/gateway-retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { telegramSendWithRetry } from "../src/services/gateway.service.js";

describe("telegramSendWithRetry", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns ok on first success", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await telegramSendWithRetry("https://api.telegram.org/bot/sendMessage", { chat_id: "x", text: "hi" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on 429", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "rate limit" }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await telegramSendWithRetry("https://api.telegram.org/bot/sendMessage", { chat_id: "x", text: "hi" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx (chat invalid)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }));
    await expect(
      telegramSendWithRetry("https://api.telegram.org/bot/sendMessage", { chat_id: "x", text: "hi" }),
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx and rethrows after exhaustion", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(
      telegramSendWithRetry("https://api.telegram.org/bot/sendMessage", { chat_id: "x", text: "hi" }),
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/gateway-retry.test.ts`
Expected: FAIL — `telegramSendWithRetry` not exported.

- [ ] **Step 3: Implement `telegramSendWithRetry` in `gateway.service.ts`**

Insert near the top of `src/services/gateway.service.ts` (after imports):

```typescript
import { withRetry } from "./retry.service.js";

const RETRYABLE_TG_STATUSES = new Set([429, 500, 502, 503, 504]);

export async function telegramSendWithRetry(
  url: string,
  body: Record<string, unknown>,
): Promise<void> {
  await withRetry(
    async () => {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (RETRYABLE_TG_STATUSES.has(resp.status)) {
        throw new Error(`Telegram ${resp.status}`);
      }
      const data = (await resp.json()) as { ok: boolean; description?: string };
      if (!data.ok) {
        throw new Error(`Telegram non-retryable: ${data.description ?? "unknown"}`);
      }
    },
    {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      jitter: true,
      shouldRetry: (err) => err instanceof Error && err.message.startsWith("Telegram ") && !err.message.includes("non-retryable"),
      onRetry: (attempt, err, delayMs) => {
        console.warn(`[retry] telegram attempt=${attempt} delay=${delayMs}ms err=${(err as Error).message}`);
      },
    },
  );
}
```

- [ ] **Step 4: Replace the existing fetch in `sendNotification` (gateway.service.ts:372-380)**

Replace:

```typescript
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
    });
```

With:

```typescript
    await telegramSendWithRetry(url, { chat_id: chatId, text, parse_mode: parseMode });
```

- [ ] **Step 5: Mirror the retry in `mcp/telegram-notify.ts:telegramRequest`**

Replace the body of `telegramRequest` with:

```typescript
async function telegramRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const token = getBotToken();
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  return withRetry(
    async () => {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      if (RETRYABLE_TG_STATUSES.has(resp.status)) {
        throw new Error(`Telegram ${resp.status}`);
      }
      const data = (await resp.json()) as { ok: boolean; description?: string; result?: unknown };
      if (!data.ok) {
        throw new Error(`Telegram non-retryable: ${data.description ?? "unknown error"}`);
      }
      return data.result;
    },
    {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 4000,
      jitter: true,
      shouldRetry: (err) => err instanceof Error && err.message.startsWith("Telegram ") && !err.message.includes("non-retryable"),
      onRetry: (attempt, err, delayMs) => {
        console.warn(`[retry] telegram-mcp ${method} attempt=${attempt} delay=${delayMs}ms err=${(err as Error).message}`);
      },
    },
  );
}
```

Add at top of `src/mcp/telegram-notify.ts`:

```typescript
import { withRetry } from "../services/retry.service.js";
const RETRYABLE_TG_STATUSES = new Set([429, 500, 502, 503, 504]);
```

- [ ] **Step 6: Run test + full suite**

Run: `pnpm test tests/gateway-retry.test.ts && pnpm test`
Expected: 4/4 PASS for new; all other tests still pass.

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors.

- [ ] **Step 8: Build to verify nothing else breaks**

Run: `pnpm build`
Expected: Success.

- [ ] **Step 9: Commit**

```bash
git add src/services/gateway.service.ts src/mcp/telegram-notify.ts tests/gateway-retry.test.ts
git commit -m "feat(telegram): retry sends on 429/5xx; do not retry 4xx config errors"
```

---

## Task 5a.8: Phase 5a smoke check + MVP eval regression

- [ ] **Step 1: Run a single real session against `fundx-audit`**

Run: `pnpm dev -- session run --fund fundx-audit --type mid_session`
Expected: Session completes successfully. Inspect `~/.fundx/funds/fundx-audit/state/session_log.jsonl` — last entry has `status: "success"`.

- [ ] **Step 2: Run MVP eval suite**

Run: `pnpm dev -- eval --filter mvp-`
Expected: 8/8 PASS at threshold (allow `mvp-portfolio-review-spanish` 2/3 known variance).

- [ ] **Step 3: If smoke + eval green, proceed to Phase 5b. Otherwise, debug and re-commit fixes.**

---

# PHASE 5b — Integration Test Suite

## Task 5b.1: Vitest projects config + scripts

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `vitest.config.ts` with two projects**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/integration/**", "tests/eval/**", "node_modules/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          poolOptions: {
            threads: { singleThread: true },
          },
          testTimeout: 30_000,
        },
      },
    ],
  },
});
```

- [ ] **Step 2: Add scripts to `package.json`**

In the `scripts` block, add:

```json
    "test:unit": "vitest --project unit",
    "test:integration": "vitest --project integration",
```

(Keep `"test": "vitest"` — it runs both.)

- [ ] **Step 3: Verify unit project still works**

Run: `pnpm test:unit`
Expected: All previous unit tests PASS; integration tests not picked up.

- [ ] **Step 4: Verify integration project finds nothing yet**

Run: `pnpm test:integration`
Expected: "No test files found" — fine, we'll add them next.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json
git commit -m "build(test): vitest projects split unit and integration suites"
```

---

## Task 5b.2: Daemon `tick_interval_ms` config support

**Files:**
- Modify: `src/types.ts` (extend global config schema)
- Modify: `src/services/daemon.service.ts:628` (cron.schedule)

- [ ] **Step 1: Extend `daemonConfigSchema` in `src/types.ts`**

Find `daemonConfigSchema` (or the global daemon block — search for `daemon:` shape near `globalConfigSchema`). Add:

```typescript
  // existing fields...
  tick_interval_ms: z.number().int().positive().optional(),
```

If a `daemon` block does not exist on `globalConfigSchema`, create one:

```typescript
export const globalDaemonConfigSchema = z.object({
  tick_interval_ms: z.number().int().positive().optional(),
}).optional();

// then inside globalConfigSchema:
  daemon: globalDaemonConfigSchema,
```

- [ ] **Step 2: Replace `cron.schedule("* * * * *", ...)` with conditional setInterval/cron**

In `src/services/daemon.service.ts:628`, replace:

```typescript
  cron.schedule("* * * * *", async () => {
    // existing tick body
  });
```

With:

```typescript
  const tickIntervalMs = config.daemon?.tick_interval_ms;
  const tickFn = async () => {
    // existing tick body — extract to local function
  };
  if (tickIntervalMs && tickIntervalMs > 0 && tickIntervalMs < 60_000) {
    // Test-only fast tick (config option, never set in production)
    setInterval(tickFn, tickIntervalMs);
  } else {
    cron.schedule("* * * * *", tickFn);
  }
```

(Where `config` refers to the loaded global config in scope.)

- [ ] **Step 3: Verify build + typecheck**

Run: `pnpm build && pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/services/daemon.service.ts
git commit -m "feat(daemon): support tick_interval_ms config override for integration tests"
```

---

## Task 5b.3: Integration test — `run-fund-session.test.ts`

**Files:**
- Create: `tests/integration/run-fund-session.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/run-fund-session.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Mock the SDK BEFORE imports of code that uses it
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@anthropic-ai/claude-agent-sdk");
  return {
    ...actual,
    query: vi.fn(() => (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-int-1" };
      yield {
        type: "result",
        subtype: "success",
        result: "Session reflection complete; handoff written.",
        total_cost_usd: 0.05,
        num_turns: 8,
        modelUsage: { "claude-sonnet-4-6": { inputTokens: 1000, outputTokens: 500 } },
        session_id: "sess-int-1",
      };
    })()),
  };
});

describe("integration: runFundSession (mocked SDK)", () => {
  let workspace: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "fundx-int-"));
    originalHome = process.env.HOME;
    process.env.HOME = workspace;
    process.env.FUNDX_HOME = path.join(workspace, ".fundx");

    // Seed minimal global config + ephemeral fund using existing service helpers
    const { ensureWorkspace } = await import("../../src/services/init.service.js");
    await ensureWorkspace();

    const { createFund } = await import("../../src/services/fund.service.js");
    await createFund({
      name: "int-test-fund",
      display_name: "Integration Test Fund",
      objective: { type: "growth", target_multiple: 2 },
      capital: { initial: 10_000 },
      risk: { profile: "moderate", max_position_pct: 25, max_drawdown_pct: 25 },
      universe: { preset: "sp500" },
      schedule: { sessions: {} },
      broker: { mode: "paper" },
    } as never);
  });

  afterAll(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.FUNDX_HOME;
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it("orient → run → reflect → archive → JSONL append", async () => {
    const { runFundSession } = await import("../../src/services/session.service.js");
    const { fundPaths } = await import("../../src/paths.js");

    await runFundSession({ fundName: "int-test-fund", sessionType: "mid_session" });

    const paths = fundPaths("int-test-fund");

    // 1. session_log.jsonl has new entry
    expect(existsSync(paths.state.sessionLogJsonl)).toBe(true);
    const jsonl = await readFile(paths.state.sessionLogJsonl, "utf-8");
    const lines = jsonl.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.status).toBe("success");
    expect(last.session_type).toBe("mid_session");
    expect(last.cost_usd).toBe(0.05);
    expect(last.num_turns).toBe(8);

    // 2. session-handoff archive directory exists (may or may not have entries — first session does not archive)
    const archiveDir = path.join(paths.state.root, "handoffs");
    if (existsSync(archiveDir)) {
      const entries = await readFile(archiveDir).catch(() => null);
      expect(entries).toBeTruthy();
    }

    // 3. daily_cap_state.json absent (cap not breached)
    expect(existsSync(paths.state.dailyCapState)).toBe(false);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `pnpm test:integration`
Expected: PASS in <5 seconds.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/run-fund-session.test.ts
git commit -m "test(integration): runFundSession e2e with mocked SDK"
```

---

## Task 5b.4: Integration test — `daemon-tick.test.ts`

**Files:**
- Create: `tests/integration/daemon-tick.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/daemon-tick.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";

describe("integration: daemon real subprocess + accelerated cron", () => {
  let workspace: string;
  let daemon: ChildProcess | null = null;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "fundx-daemon-int-"));
    const fundxHome = path.join(workspace, ".fundx");

    // Write minimal global config with fast tick interval
    await writeFile(path.join(fundxHome, "config.yaml"), yaml.dump({
      claude_code_oauth_token: "test-token",
      daemon: { tick_interval_ms: 1000 },
      market_data: { provider: "yfinance" },
    }), { recursive: true } as never).catch(async () => {
      // mkdir if needed
      const { mkdir } = await import("node:fs/promises");
      await mkdir(fundxHome, { recursive: true });
      await writeFile(path.join(fundxHome, "config.yaml"), yaml.dump({
        claude_code_oauth_token: "test-token",
        daemon: { tick_interval_ms: 1000 },
        market_data: { provider: "yfinance" },
      }));
    });
  });

  afterAll(async () => {
    if (daemon && !daemon.killed) {
      daemon.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
    await rm(workspace, { recursive: true, force: true });
  });

  it("daemon writes pid + heartbeat; tick fires; SIGTERM cleans up", async () => {
    const fundxHome = path.join(workspace, ".fundx");
    const env = { ...process.env, HOME: workspace, FUNDX_HOME: fundxHome };

    daemon = spawn("node", ["dist/index.js", "start", "--no-fork"], {
      env,
      stdio: "pipe",
    });

    // Wait for daemon.pid to appear (max 5s)
    const pidPath = path.join(fundxHome, "daemon.pid");
    const heartbeatPath = path.join(fundxHome, "daemon.heartbeat");
    let pidExists = false;
    for (let i = 0; i < 50; i++) {
      if (existsSync(pidPath)) { pidExists = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(pidExists).toBe(true);

    // Wait for heartbeat (max 5s)
    let heartbeatExists = false;
    for (let i = 0; i < 50; i++) {
      if (existsSync(heartbeatPath)) { heartbeatExists = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(heartbeatExists).toBe(true);

    const heartbeatStat1 = await stat(heartbeatPath);

    // Wait 3 seconds — heartbeat should have refreshed at least once with 1s tick
    await new Promise((r) => setTimeout(r, 3000));
    const heartbeatStat2 = await stat(heartbeatPath);
    expect(heartbeatStat2.mtimeMs).toBeGreaterThan(heartbeatStat1.mtimeMs);

    // SIGTERM cleanup
    daemon.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    expect(existsSync(pidPath)).toBe(false);
  }, 20_000);
});
```

- [ ] **Step 2: Build first (the test spawns dist/index.js)**

Run: `pnpm build`
Expected: Success.

- [ ] **Step 3: Run integration test**

Run: `pnpm test:integration tests/integration/daemon-tick.test.ts`
Expected: PASS in ~10s.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/daemon-tick.test.ts
git commit -m "test(integration): daemon subprocess with accelerated cron tick"
```

---

## Task 5b.5: Integration test — `self-healing.test.ts`

**Files:**
- Create: `tests/integration/self-healing.test.ts`

- [ ] **Step 1: Write the integration test (4 scenarios)**

```typescript
// tests/integration/self-healing.test.ts
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@anthropic-ai/claude-agent-sdk");
  return { ...actual, query: vi.fn() };
});

const sdk = await import("@anthropic-ai/claude-agent-sdk");
const { query } = sdk as unknown as { query: ReturnType<typeof vi.fn> };

describe("integration: self-healing primitives", () => {
  let workspace: string;
  let originalHome: string | undefined;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "fundx-heal-"));
    originalHome = process.env.HOME;
    process.env.HOME = workspace;
    process.env.FUNDX_HOME = path.join(workspace, ".fundx");

    const { ensureWorkspace } = await import("../../src/services/init.service.js");
    await ensureWorkspace();

    const { createFund } = await import("../../src/services/fund.service.js");
    await createFund({
      name: "heal-test",
      display_name: "Heal Test",
      objective: { type: "growth", target_multiple: 2 },
      capital: { initial: 10_000 },
      risk: { profile: "moderate", max_position_pct: 25, max_drawdown_pct: 25 },
      universe: { preset: "sp500" },
      schedule: { sessions: {} },
      broker: { mode: "paper" },
    } as never);
  });

  afterAll(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.FUNDX_HOME;
    await rm(workspace, { recursive: true, force: true });
  });

  beforeEach(() => vi.clearAllMocks());

  function stream(messages: unknown[], throwAtStart?: Error) {
    return (async function* () {
      if (throwAtStart) throw throwAtStart;
      for (const m of messages) yield m;
    })();
  }

  const successMessages = [
    { type: "system", subtype: "init", session_id: "s-heal" },
    { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, num_turns: 1, modelUsage: {}, session_id: "s-heal" },
  ];

  it("auth refresh: 401 then success — no daemon.needs-restart written", async () => {
    const { runAgentQuery } = await import("../../src/agent.js");
    const { DAEMON_NEEDS_RESTART } = await import("../../src/paths.js");
    if (existsSync(DAEMON_NEEDS_RESTART)) unlinkSync(DAEMON_NEEDS_RESTART);

    const authError = Object.assign(new Error("invalid_token"), { status: 401 });
    query.mockReturnValueOnce(stream([], authError)).mockReturnValueOnce(stream(successMessages));

    const r = await runAgentQuery({ fundName: "heal-test", prompt: "x" });
    expect(r.status).toBe("success");
    expect(existsSync(DAEMON_NEEDS_RESTART)).toBe(false);
  });

  it("MCP transport retry: EPIPE then success", async () => {
    const { runAgentQuery } = await import("../../src/agent.js");
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    query.mockReturnValueOnce(stream([], epipe)).mockReturnValueOnce(stream(successMessages));
    const r = await runAgentQuery({ fundName: "heal-test", prompt: "x" });
    expect(r.status).toBe("success");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("watchdog: hung query returns watchdog_killed", async () => {
    // Override WATCHDOG_HARD_MS via test seam: spy on evaluateWatchdog instead
    const sessionMod = await import("../../src/services/session.service.js");
    const evalSpy = vi.spyOn(sessionMod, "evaluateWatchdog").mockReturnValue({
      shouldKill: true,
      elapsedMs: 999_999,
    });

    // Mock query as a never-yielding generator
    query.mockReturnValueOnce((async function* () { await new Promise(() => {}); })());

    const { runFundSession } = sessionMod;
    await runFundSession({ fundName: "heal-test", sessionType: "mid_session" });

    const { fundPaths } = await import("../../src/paths.js");
    const { readFile } = await import("node:fs/promises");
    const jsonl = await readFile(fundPaths("heal-test").state.sessionLogJsonl, "utf-8");
    const lines = jsonl.trim().split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.status).toBe("watchdog_killed");

    evalSpy.mockRestore();
  }, 15_000);

  it("Telegram backoff: 503 503 200 — succeeds after retries", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const { telegramSendWithRetry } = await import("../../src/services/gateway.service.js");
    await telegramSendWithRetry("https://api.telegram.org/bot/sendMessage", { chat_id: "x", text: "hi" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    fetchSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `pnpm test:integration tests/integration/self-healing.test.ts`
Expected: 4/4 PASS in <10s.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/self-healing.test.ts
git commit -m "test(integration): self-healing scenarios — auth, mcp, watchdog, telegram"
```

---

## Task 5b.6: CI workflow — run integration on every PR

**Files:**
- Modify: `.github/workflows/<ci.yml>` (or whatever the existing CI workflow is named)

- [ ] **Step 1: Find the existing CI workflow**

Run: `ls .github/workflows/`
Expected: Find the file that runs `pnpm test` on PRs.

- [ ] **Step 2: Add an integration step**

In the workflow, add (after the existing `pnpm test` or `pnpm test:unit` step):

```yaml
      - name: Build
        run: pnpm build
      - name: Integration tests
        run: pnpm test:integration
        timeout-minutes: 5
```

If the existing step uses `pnpm test`, change it to `pnpm test:unit` and add the integration step separately.

- [ ] **Step 3: Verify workflow YAML is valid**

Run: `cat .github/workflows/<filename>` (visually review).
If `actionlint` is installed: `actionlint .github/workflows/<filename>`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/
git commit -m "ci: run integration test suite on every PR"
```

---

## Task 5b.7: Phase 5b smoke check

- [ ] **Step 1: Run unit + integration locally**

Run: `pnpm test`
Expected: All unit + integration tests PASS.

- [ ] **Step 2: Run a real session against fundx-audit**

Run: `pnpm dev -- session run --fund fundx-audit --type mid_session`
Expected: Session completes successfully, no regressions.

- [ ] **Step 3: If green, proceed to Phase 5c.**

---

# PHASE 5c — Heartbeat Doc + Cap Defaults

## Task 5c.1: Bump `dailyCapUsd` default $5 → $20

**Files:**
- Modify: `src/services/session.service.ts:41`
- Modify: `tests/budget.test.ts` (any test that asserts on default value)

- [ ] **Step 1: Update the default constant**

In `src/services/session.service.ts:41`, replace:

```typescript
const DEFAULT_DAILY_CAP_USD = 5;
```

With:

```typescript
const DEFAULT_DAILY_CAP_USD = 20;
```

- [ ] **Step 2: Update the JSDoc on `resolveDailyCapUsd` (lines 43-48)**

Replace `default $5/day` with `default $20/day`.

- [ ] **Step 3: Update tests in `tests/budget.test.ts`**

Search the file for `5` in the context of `dailyCapUsd` defaults. Replace with `20` where the assertion is about the default cascade fallback.

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/budget.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/session.service.ts tests/budget.test.ts
git commit -m "chore(budget): raise dailyCapUsd default \$5 → \$20 per quality-over-cost stance"
```

---

## Task 5c.2: Add Heartbeat smoke section to `docs/operations.md`

**Files:**
- Modify: `docs/operations.md`

- [ ] **Step 1: Append section to `docs/operations.md`**

At the end of the file (or in an appropriate section under "Common Operations"), add:

```markdown
## Heartbeat smoke test (manual)

Validates the supervisor → daemon heartbeat alert path end-to-end. Run after any
daemon restart for an unrelated reason — no need to trigger one solely for this.

**Prereqs:** Daemon running, Telegram gateway connected.

1. `fundx stop && fundx start`
2. Find the daemon PID: `cat ~/.fundx/daemon.pid | jq .pid`
3. `kill -STOP <pid>` to freeze the daemon's event loop
4. Wait 4 minutes (heartbeat goes stale at 3 min; supervisor checks every 60s)
5. Confirm Telegram alert "Daemon heartbeat stale" arrived
6. `kill -CONT <pid>` to resume the daemon
7. Wait 60 seconds
8. Confirm Telegram alert "Daemon heartbeat recovered" arrived
9. Verify `~/.fundx/daemon.heartbeat` mtime is fresh: `stat ~/.fundx/daemon.heartbeat`

**If the alert does not arrive:**
- Check supervisor logs: `tail -200 ~/.fundx/daemon.log | grep heartbeat`
- Check Telegram chat-id is correct in `~/.fundx/config.yaml`
- Check `notifyDaemonEvent` is not being suppressed by quiet hours
```

- [ ] **Step 2: Verify the file renders cleanly (no broken markdown)**

Run: `cat docs/operations.md | head -60`
Visually verify formatting.

- [ ] **Step 3: Commit**

```bash
git add docs/operations.md
git commit -m "docs(operations): add manual heartbeat smoke procedure"
```

---

## Task 5c.3: Update `CLAUDE.md` with new defaults

**Files:**
- Modify: `CLAUDE.md` (Configuration section)

- [ ] **Step 1: Find the Configuration section in `CLAUDE.md`**

Search for the bullet starting with `Daily-per-fund cap (Phase 4):` (around line 245).

- [ ] **Step 2: Update the default value mentioned**

Replace `default $5/day` with `default $20/day (raised from $5 in Phase 5c — quality over cost-control stance; users can lower it via fund.budget.dailyCapUsd or global.budget.dailyCapUsd)`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document raised dailyCapUsd default and override path"
```

---

## Task 5c.4: Phase 5c verification + roadmap memory update

- [ ] **Step 1: Run full test suite one last time**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: All PASS, 0 errors.

- [ ] **Step 2: Run MVP eval to confirm no regression**

Run: `pnpm dev -- eval --filter mvp-`
Expected: 8/8 PASS at threshold (allow `mvp-portfolio-review-spanish` 2/3 known variance).

- [ ] **Step 3: Update memory file**

Edit `~/.claude/projects/-Users-michael-Proyectos-fundx/memory/project_harness_roadmap_complete.md` to note Phase 5a/5b/5c are complete with the date 2026-05-10. Specifically:
- Add a bullet "Phase 5a (self-healing primitives) closed"
- Add a bullet "Phase 5b (integration test suite) closed"
- Add a bullet "Phase 5c (heartbeat doc + cap defaults) closed"
- Update the "Why" section if needed

- [ ] **Step 4: Final commit on the docs branch**

```bash
git add docs/superpowers/audit-1b/audit-log.md  # if you added a Phase 5 verification entry
git commit -m "docs(audit): add Phase 5a/5b/5c verification entries"
```

(If no audit log update needed, skip this step.)

---

# Definition of Done

Phase 5a:
- [ ] All 7 unit test files added; all pass
- [ ] `withRetry`, `reloadAuthToken` exported from `services/index.ts`
- [ ] `runAgentQuery` retries auth + MCP transport once each, distinct branches
- [ ] `runFundSession` watchdog kills sessions > 20 min hard ceiling with Telegram alert
- [ ] FMP fetches retry on 429/5xx; do not retry 4xx (other than 429)
- [ ] Telegram sends retry on 429/5xx; do not retry 4xx
- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` all green
- [ ] MVP eval passes at threshold

Phase 5b:
- [ ] `vitest.config.ts` exists with unit/integration projects
- [ ] `pnpm test:unit` and `pnpm test:integration` work
- [ ] `tests/integration/run-fund-session.test.ts` passes <5s
- [ ] `tests/integration/daemon-tick.test.ts` passes <15s with real subprocess
- [ ] `tests/integration/self-healing.test.ts` passes <15s
- [ ] CI runs integration on every PR

Phase 5c:
- [ ] `dailyCapUsd` default = 20 in `resolveDailyCapUsd` and tests
- [ ] `docs/operations.md` has "Heartbeat smoke test (manual)" section
- [ ] `CLAUDE.md` Configuration section reflects new default
- [ ] Memory file `project_harness_roadmap_complete.md` updated with Phase 5 closure

---

## Self-review notes

- **Spec coverage:** Every spec section maps to at least one task. Phase 5a §5a.1-5a.4 → Tasks 5a.1-5a.7. Phase 5b §5b.1-5b.3 → Tasks 5b.3-5b.5 (with infra in 5b.1-5b.2). Phase 5c → Tasks 5c.1-5c.3.
- **Type consistency:** `withRetry`, `evaluateWatchdog`, `reloadAuthToken`, `fetchFmpWithRetry`, `telegramSendWithRetry` all referenced consistently across tasks.
- **Placeholder scan:** No TBDs. The CI workflow task references `<filename>` because the actual file name needs verification at execution time — this is acceptable since `ls .github/workflows/` is part of the task.
- **Smoke checkpoints:** After each phase (5a.8, 5b.7, 5c.4), an MVP eval + manual smoke against `fundx-audit` confirms no regression before proceeding.
