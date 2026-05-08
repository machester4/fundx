# Phase 4 — Operational Observability (G6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add daily-per-fund USD cap enforcement, append-only session log JSONL, supervisor heartbeat watch with Telegram alerts, and `fundx status` UI extension showing today's USD per fund. Plus an operations runbook.

**Architecture:** All-additive layer on top of existing supervisor + daemon + heartbeat infrastructure. New JSONL is append-only audit trail and source of truth for daily aggregation. Daily cap uses a new resolver alongside Phase 1a's `resolveBudget`. Heartbeat watch lives in the supervisor (separate process from daemon, so it can detect daemon stalls). No agent behaviour change.

**Tech Stack:** TypeScript strict ESM; `fs/promises.appendFile` for atomic JSONL writes; Vitest tests. Existing dependencies: Zod, grammy (Telegram), Ink (status UI).

**Spec:** [`docs/superpowers/specs/2026-05-07-harness-phase-4-design.md`](../specs/2026-05-07-harness-phase-4-design.md)

---

## File Structure

| Path | Type | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | Add `dailyCapUsd?: number` to `fundBudgetConfigSchema`; add `"skipped_daily_cap"` to `sessionLogV2Schema.status` enum |
| `src/paths.ts` | Modify | Add `sessionLogJsonl` + `dailyCapState` paths |
| `src/services/session-history.service.ts` | Create | `appendSessionLogEntry`, `readTodaysSessionUsage`, `pruneSessionLogJsonl` |
| `src/services/session.service.ts` | Modify | Add `resolveDailyCapUsd` pure function; wire JSONL append + cap check into `runFundSession` |
| `src/services/daily-cap.service.ts` | Create | `notifyDailyCapReached` with one-shot per-day dedup |
| `src/services/daemon.service.ts` | Modify | Daily cron tick: prune JSONL + clear `daily_cap_state.json` at midnight UTC |
| `src/services/supervisor.service.ts` | Modify | Add heartbeat watch interval with one-shot + recovery alerts |
| `src/services/status.service.ts` | Modify | Add `getDailyUsagePerFund` |
| `src/components/FundsOverviewPanel.tsx` | Modify | Add "Today" column with threshold colors |
| `src/commands/status.tsx` | Modify | Wire `getDailyUsagePerFund` into `getSystemInfo` |
| `tests/types.test.ts` | Modify | Schema validation for new fields |
| `tests/session-history.test.ts` | Create | 6 tests for JSONL helpers |
| `tests/budget.test.ts` | Modify | Add `resolveDailyCapUsd` cascade tests |
| `tests/daily-cap.test.ts` | Create | 7 integration tests for cap enforcement |
| `tests/supervisor-heartbeat.test.ts` | Create | 7 tests for heartbeat alert logic |
| `tests/status-daily-usage.test.ts` | Create | 6 tests for status service |
| `docs/operations.md` | Create | Operations runbook |
| `docs/superpowers/audit-1b/audit-log.md` | Modify | Phase 4 verification entry |
| `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md` | Modify | Status log entry for Phase 4 |
| `CLAUDE.md` | Modify | One-line mention of daily cap mechanism |

---

## Task 1: Schema additions (types.ts)

**Files:**
- Modify: `/Users/michael/Proyectos/fundx/src/types.ts`
- Modify: `/Users/michael/Proyectos/fundx/tests/types.test.ts`

- [ ] **Step 1: Find the existing schemas**

Run: `grep -nE "fundBudgetConfigSchema|sessionLogV2Schema" /Users/michael/Proyectos/fundx/src/types.ts | head -5`
Expected output approximately:
```
168:export const fundBudgetConfigSchema = z
604:export const sessionLogV2Schema = sessionLogSchema.extend({
```

- [ ] **Step 2: Write failing tests**

Open `/Users/michael/Proyectos/fundx/tests/types.test.ts`. Add the following tests at the end of the file:

```typescript
import { fundBudgetConfigSchema, sessionLogV2Schema } from "../src/types.js";

describe("fundBudgetConfigSchema with dailyCapUsd", () => {
  it("accepts config without dailyCapUsd (back-compat)", () => {
    const out = fundBudgetConfigSchema.parse({});
    expect(out?.dailyCapUsd).toBeUndefined();
  });

  it("accepts config with dailyCapUsd", () => {
    const out = fundBudgetConfigSchema.parse({ dailyCapUsd: 10 });
    expect(out?.dailyCapUsd).toBe(10);
  });

  it("rejects non-positive dailyCapUsd", () => {
    expect(() => fundBudgetConfigSchema.parse({ dailyCapUsd: 0 })).toThrow();
    expect(() => fundBudgetConfigSchema.parse({ dailyCapUsd: -1 })).toThrow();
  });
});

describe("sessionLogV2Schema status enum", () => {
  it("accepts skipped_daily_cap status", () => {
    const out = sessionLogV2Schema.parse({
      fund: "f",
      session_type: "pre_market",
      started_at: "2026-05-07T00:00:00Z",
      trades_executed: 0,
      summary: "skipped",
      status: "skipped_daily_cap",
    });
    expect(out.status).toBe("skipped_daily_cap");
  });
});
```

(If tests/types.test.ts doesn't already import these names, add them to the existing import block.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/michael/Proyectos/fundx && pnpm test -- tests/types.test.ts`
Expected: FAIL — `fundBudgetConfigSchema` doesn't accept `dailyCapUsd`; `status` enum doesn't include `"skipped_daily_cap"`.

- [ ] **Step 4: Add `dailyCapUsd` to fundBudgetConfigSchema**

Find the existing schema in `src/types.ts` (~line 168):

```typescript
export const fundBudgetConfigSchema = z
  .object({
    default: budgetSchema.optional(),
    perSessionType: z.record(z.string(), budgetSchema).optional(),
  })
  .optional();
```

Replace with:

```typescript
export const fundBudgetConfigSchema = z
  .object({
    default: budgetSchema.optional(),
    perSessionType: z.record(z.string(), budgetSchema).optional(),
    /** Daily aggregate USD cap per fund. When the sum of cost_usd across
     *  today's sessions reaches this value, further sessions are skipped
     *  with status "skipped_daily_cap" until 00:00 UTC. */
    dailyCapUsd: z.number().positive().optional(),
  })
  .optional();
```

- [ ] **Step 5: Add `"skipped_daily_cap"` to status enum**

Find `sessionLogV2Schema` (~line 604). The current `status` enum reads:

```typescript
status: z
  .enum(["success", "error_max_turns", "error_max_budget", "error", "timeout"])
  .optional(),
```

Replace with:

```typescript
status: z
  .enum(["success", "error_max_turns", "error_max_budget", "error", "timeout", "skipped_daily_cap"])
  .optional(),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test -- tests/types.test.ts && pnpm typecheck`
Expected: PASS, 0 type errors. (Existing exhaustive switches on `SessionLogV2["status"]` may need a default branch — investigate if typecheck fails, add the branch.)

- [ ] **Step 7: Run full suite to catch regressions**

Run: `pnpm test`
Expected: full suite green.

- [ ] **Step 8: Commit**

```bash
cd /Users/michael/Proyectos/fundx
git add src/types.ts tests/types.test.ts
git commit -m "feat(types): add dailyCapUsd budget field + skipped_daily_cap status

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Paths additions (paths.ts)

**Files:**
- Modify: `/Users/michael/Proyectos/fundx/src/paths.ts`

This task has no dedicated tests — paths are constants consumed by later tasks.

- [ ] **Step 1: Add the new paths**

In `/Users/michael/Proyectos/fundx/src/paths.ts`, find the per-fund `state:` block (around lines 118-135). After the existing `handoffsDir: join(root, "state", "handoffs"),` line, add:

```typescript
      sessionLogJsonl: join(root, "state", "session_log.jsonl"),
      dailyCapState: join(root, "state", "daily_cap_state.json"),
```

The full state block becomes:

```typescript
    state: {
      dir: join(root, "state"),
      portfolio: join(root, "state", "portfolio.json"),
      tracker: join(root, "state", "objective_tracker.json"),
      journal: join(root, "state", "trade_journal.sqlite"),
      sessionLog: join(root, "state", "session_log.json"),
      activeSession: join(root, "state", "active_session.json"),
      chatHistory: join(root, "state", "chat_history.json"),
      sessionHistory: join(root, "state", "session_history.json"),
      lock: join(root, "state", ".lock"),
      pendingSessions: join(root, "state", "pending_sessions.json"),
      sessionCounts: join(root, "state", "session_counts.json"),
      sessionHandoff: join(root, "state", "session-handoff.md"),
      dailySnapshot: join(root, "state", "daily_snapshot.json"),
      notifiedMilestones: join(root, "state", "notified_milestones.json"),
      universe: join(root, "state", "universe.json"),
      handoffsDir: join(root, "state", "handoffs"),
      sessionLogJsonl: join(root, "state", "session_log.jsonl"),
      dailyCapState: join(root, "state", "daily_cap_state.json"),
    },
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /Users/michael/Proyectos/fundx && pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/paths.ts
git commit -m "feat(paths): add sessionLogJsonl + dailyCapState per-fund paths

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: session-history.service.ts (new file)

**Files:**
- Create: `/Users/michael/Proyectos/fundx/src/services/session-history.service.ts`
- Create: `/Users/michael/Proyectos/fundx/tests/session-history.test.ts`

This module exports three functions:
- `appendSessionLogEntry(fundName, log)` — appends one JSONL line
- `readTodaysSessionUsage(fundName)` — streams JSONL filtered by today UTC, returns aggregate
- `pruneSessionLogJsonl(fundName, retentionDays = 90)` — removes lines older than retention

- [ ] **Step 1: Write failing tests**

Create `/Users/michael/Proyectos/fundx/tests/session-history.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionLogEntry,
  readTodaysSessionUsage,
  pruneSessionLogJsonl,
} from "../src/services/session-history.service.js";
import type { SessionLogV2 } from "../src/types.js";

const FUND = "fundx-history-test";
let tmpRoot: string;

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => {
      const root = join(tmpRoot, "funds", name);
      return {
        ...actual.fundPaths(name),
        root,
        state: {
          ...actual.fundPaths(name).state,
          dir: join(root, "state"),
          sessionLogJsonl: join(root, "state", "session_log.jsonl"),
          dailyCapState: join(root, "state", "daily_cap_state.json"),
        },
      };
    },
  };
});

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `fundx-history-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(tmpRoot, "funds", FUND, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const mkLog = (overrides: Partial<SessionLogV2> = {}): SessionLogV2 => ({
  fund: FUND,
  session_type: "pre_market",
  started_at: new Date().toISOString(),
  trades_executed: 0,
  summary: "",
  cost_usd: 0.5,
  status: "success",
  ...overrides,
});

describe("appendSessionLogEntry + readTodaysSessionUsage", () => {
  it("appends a single entry and reads it back as today's usage", async () => {
    const log = mkLog({ cost_usd: 1.23 });
    await appendSessionLogEntry(FUND, log);

    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(1);
    expect(usage.totalUsd).toBeCloseTo(1.23, 2);
    expect(usage.entries).toHaveLength(1);
  });

  it("aggregates multiple appends in order", async () => {
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 0.5 }));
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 0.7 }));
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 1.0 }));

    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(3);
    expect(usage.totalUsd).toBeCloseTo(2.2, 2);
    expect(usage.entries[0].cost_usd).toBe(0.5);
    expect(usage.entries[2].cost_usd).toBe(1.0);
  });

  it("excludes entries from previous days (filter by started_at)", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 0.5, started_at: yesterday }));
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 0.7 }));

    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(1);
    expect(usage.totalUsd).toBeCloseTo(0.7, 2);
  });

  it("returns zero usage when no JSONL file exists", async () => {
    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(0);
    expect(usage.totalUsd).toBe(0);
    expect(usage.entries).toHaveLength(0);
  });

  it("skips malformed lines without crashing", async () => {
    const path = join(tmpRoot, "funds", FUND, "state", "session_log.jsonl");
    const goodLine = JSON.stringify(mkLog({ cost_usd: 1.0 }));
    const badLine = "{ this is not json";
    await writeFile(path, `${goodLine}\n${badLine}\n`, "utf-8");

    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(1);
    expect(usage.totalUsd).toBeCloseTo(1.0, 2);
  });
});

describe("pruneSessionLogJsonl", () => {
  it("removes entries older than retentionDays", async () => {
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    const recent = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    await appendSessionLogEntry(FUND, mkLog({ started_at: old }));
    await appendSessionLogEntry(FUND, mkLog({ started_at: recent }));

    await pruneSessionLogJsonl(FUND, 90);

    const path = join(tmpRoot, "funds", FUND, "state", "session_log.jsonl");
    const content = await readFile(path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).started_at).toBe(recent);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/michael/Proyectos/fundx && pnpm test -- tests/session-history.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `/Users/michael/Proyectos/fundx/src/services/session-history.service.ts`:

```typescript
import { appendFile, readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fundPaths } from "../paths.js";
import { sessionLogV2Schema, type SessionLogV2 } from "../types.js";

export interface DailyUsage {
  totalUsd: number;
  sessionCount: number;
  entries: SessionLogV2[];
}

/** Append one V2 session log record as a JSON Lines entry.
 *  Atomic for line-sized writes via POSIX appendFile semantics. */
export async function appendSessionLogEntry(
  fundName: string,
  log: SessionLogV2,
): Promise<void> {
  const path = fundPaths(fundName).state.sessionLogJsonl;
  await mkdir(dirname(path), { recursive: true });
  const line = JSON.stringify(log) + "\n";
  await appendFile(path, line, "utf-8");
}

/** Read the JSONL filtered by `started_at >= midnight UTC today`.
 *  Returns aggregate cost + session count + raw entries.
 *  Skips malformed lines (logs warning, doesn't crash). */
export async function readTodaysSessionUsage(fundName: string): Promise<DailyUsage> {
  const path = fundPaths(fundName).state.sessionLogJsonl;
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { totalUsd: 0, sessionCount: 0, entries: [] };
    }
    throw err;
  }

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const entries: SessionLogV2[] = [];
  let totalUsd = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: SessionLogV2;
    try {
      parsed = sessionLogV2Schema.parse(JSON.parse(trimmed));
    } catch (err) {
      console.warn(
        `[session-history] skipping malformed line in ${path}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    const entryMs = new Date(parsed.started_at).getTime();
    if (entryMs >= todayMs) {
      entries.push(parsed);
      totalUsd += parsed.cost_usd ?? 0;
    }
  }

  return { totalUsd, sessionCount: entries.length, entries };
}

/** Remove JSONL lines whose started_at is older than retentionDays.
 *  Atomic rewrite via tmp + rename. */
export async function pruneSessionLogJsonl(
  fundName: string,
  retentionDays = 90,
): Promise<void> {
  const path = fundPaths(fundName).state.sessionLogJsonl;
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 3600 * 1000;
  const kept: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { started_at?: string };
      const entryMs = parsed.started_at ? new Date(parsed.started_at).getTime() : NaN;
      if (!Number.isNaN(entryMs) && entryMs >= cutoffMs) {
        kept.push(trimmed);
      }
    } catch {
      // skip malformed
    }
  }

  const tmp = path + ".tmp";
  await writeFile(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf-8");
  await rename(tmp, path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/session-history.test.ts && pnpm typecheck`
Expected: 6 tests pass, 0 type errors.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/services/session-history.service.ts tests/session-history.test.ts
git commit -m "feat(session-history): JSONL append + today-filter + prune

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: resolveDailyCapUsd cascade

**Files:**
- Modify: `/Users/michael/Proyectos/fundx/src/services/session.service.ts`
- Modify: `/Users/michael/Proyectos/fundx/tests/budget.test.ts`

- [ ] **Step 1: Write failing tests**

In `/Users/michael/Proyectos/fundx/tests/budget.test.ts`, add at the end:

```typescript
import { resolveDailyCapUsd } from "../src/services/session.service.js";

describe("resolveDailyCapUsd cascade", () => {
  const baseFund = (overrides: object = {}) => ({
    fund: { name: "f", display_name: "f", description: "", created: "2026-01-01", status: "active" as const },
    capital: { initial: 1000, currency: "USD" },
    objective: { type: "growth" as const, target_multiple: 2 },
    risk: { profile: "moderate" as const, max_drawdown_pct: 10, max_position_pct: 25, max_leverage: 1, stop_loss_pct: 5, max_daily_loss_pct: 5, correlation_limit: 0.8, custom_rules: [] },
    universe: { preset: "sp500" as const, include_tickers: [], exclude_tickers: [], exclude_sectors: [] },
    schedule: { timezone: "UTC", trading_days: [], sessions: { pre_market: { time: "09:00", enabled: true, focus: "", max_duration_minutes: 15 }, mid_session: { time: "13:00", enabled: true, focus: "", max_duration_minutes: 15 }, post_market: { time: "18:00", enabled: true, focus: "", max_duration_minutes: 15 } }, special_sessions: [] },
    broker: { mode: "paper" as const, provider: "alpaca" as const, sync_enabled: false },
    notifications: { telegram: { enabled: false, trade_alerts: true, stop_loss_alerts: true, daily_digest: true, weekly_digest: true, milestone_alerts: true, drawdown_alerts: true }, quiet_hours: { enabled: true, start: "23:00", end: "07:00", allow_critical: true } },
    claude: { model: "sonnet", personality: "", decision_framework: "" },
    ...overrides,
  });

  const baseGlobal = (overrides: object = {}) => ({
    default_model: "sonnet",
    timezone: "UTC",
    broker: {},
    telegram: { enabled: false },
    market_data: { provider: "fmp" as const },
    ...overrides,
  });

  it("uses fund.budget.dailyCapUsd when set", () => {
    const fund = baseFund({ budget: { dailyCapUsd: 12 } });
    const global = baseGlobal({ budget: { dailyCapUsd: 8 } });
    expect(resolveDailyCapUsd(fund as never, global as never)).toBe(12);
  });

  it("falls back to global.budget.dailyCapUsd", () => {
    const fund = baseFund({ budget: {} });
    const global = baseGlobal({ budget: { dailyCapUsd: 8 } });
    expect(resolveDailyCapUsd(fund as never, global as never)).toBe(8);
  });

  it("falls back to default of 5 when neither is set", () => {
    const fund = baseFund();
    const global = baseGlobal();
    expect(resolveDailyCapUsd(fund as never, global as never)).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/budget.test.ts`
Expected: FAIL — `resolveDailyCapUsd` not exported.

- [ ] **Step 3: Implement `resolveDailyCapUsd`**

In `/Users/michael/Proyectos/fundx/src/services/session.service.ts`, find the line `const FALLBACK_DEFAULT: Budget = { maxTurns: 50, maxUsd: 5 };` (around line 32). Add immediately after it:

```typescript
/** Default daily-per-fund USD cap, used when neither fund nor global config sets one. */
const DEFAULT_DAILY_CAP_USD = 5;

/** Resolve the daily-per-fund USD cap through a 3-level cascade.
 *  Most-specific override wins:
 *    1. fund.budget.dailyCapUsd
 *    2. global.budget.dailyCapUsd
 *    3. DEFAULT_DAILY_CAP_USD
 *  Pure function — no I/O. Tested in tests/budget.test.ts. */
export function resolveDailyCapUsd(
  fund: FundConfig,
  global: GlobalConfig,
): number {
  return (
    fund.budget?.dailyCapUsd ??
    global.budget?.dailyCapUsd ??
    DEFAULT_DAILY_CAP_USD
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/budget.test.ts && pnpm typecheck`
Expected: PASS, 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/session.service.ts tests/budget.test.ts
git commit -m "feat(session): resolveDailyCapUsd cascade (fund > global > default \$5)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: daily-cap.service.ts (Telegram alert + dedup)

**Files:**
- Create: `/Users/michael/Proyectos/fundx/src/services/daily-cap.service.ts`
- Create: `/Users/michael/Proyectos/fundx/tests/daily-cap-notify.test.ts`

This task only handles the alert + dedup logic. The pre-session enforcement is wired in Task 6.

- [ ] **Step 1: Write failing tests**

Create `/Users/michael/Proyectos/fundx/tests/daily-cap-notify.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FUND = "fundx-cap-test";
let tmpRoot: string;

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => {
      const root = join(tmpRoot, "funds", name);
      return {
        ...actual.fundPaths(name),
        root,
        state: {
          ...actual.fundPaths(name).state,
          dir: join(root, "state"),
          dailyCapState: join(root, "state", "daily_cap_state.json"),
        },
      };
    },
  };
});

const sendMock = vi.fn();
vi.mock("../src/services/daemon.service.js", () => ({
  notifyDaemonEvent: (...args: unknown[]) => sendMock(...args),
}));

import { notifyDailyCapReached } from "../src/services/daily-cap.service.js";

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `fundx-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(tmpRoot, "funds", FUND, "state"), { recursive: true });
  sendMock.mockReset();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("notifyDailyCapReached", () => {
  it("sends a Telegram alert on first call of the day", async () => {
    await notifyDailyCapReached(FUND, 5, { totalUsd: 5.32, sessionCount: 7, entries: [] });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toContain("Daily cap");
    expect(sendMock.mock.calls[0][1]).toContain("5.32");
  });

  it("does not re-send if already alerted today", async () => {
    await notifyDailyCapReached(FUND, 5, { totalUsd: 5.32, sessionCount: 7, entries: [] });
    await notifyDailyCapReached(FUND, 5, { totalUsd: 6.10, sessionCount: 8, entries: [] });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("re-sends when the alerted_for_date is from a previous day", async () => {
    const path = join(tmpRoot, "funds", FUND, "state", "daily_cap_state.json");
    await writeFile(path, JSON.stringify({ alerted_for_date: "2020-01-01" }), "utf-8");

    await notifyDailyCapReached(FUND, 5, { totalUsd: 5.32, sessionCount: 7, entries: [] });
    expect(sendMock).toHaveBeenCalledTimes(1);

    const stateAfter = JSON.parse(await readFile(path, "utf-8"));
    const today = new Date().toISOString().split("T")[0];
    expect(stateAfter.alerted_for_date).toBe(today);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/daily-cap-notify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `/Users/michael/Proyectos/fundx/src/services/daily-cap.service.ts`:

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fundPaths } from "../paths.js";
import { notifyDaemonEvent } from "./daemon.service.js";
import type { DailyUsage } from "./session-history.service.js";

interface DailyCapState {
  alerted_for_date?: string;
}

function todayUtcDateString(): string {
  return new Date().toISOString().split("T")[0]!;
}

async function readDailyCapState(fundName: string): Promise<DailyCapState> {
  const path = fundPaths(fundName).state.dailyCapState;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as DailyCapState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

async function writeDailyCapState(fundName: string, state: DailyCapState): Promise<void> {
  const path = fundPaths(fundName).state.dailyCapState;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Send a one-shot per-day Telegram alert when a fund reaches its daily cap.
 *  If already alerted today (per fund), this is a no-op. */
export async function notifyDailyCapReached(
  fundName: string,
  capUsd: number,
  usage: DailyUsage,
): Promise<void> {
  const today = todayUtcDateString();
  const state = await readDailyCapState(fundName);
  if (state.alerted_for_date === today) return;

  const subject = `Daily cap reached — ${fundName}`;
  const body = `Fund ${fundName} reached daily cap $${capUsd} ($${usage.totalUsd.toFixed(2)} used in ${usage.sessionCount} sessions). Sessions will resume at 00:00 UTC tomorrow.`;
  await notifyDaemonEvent(subject, body);

  await writeDailyCapState(fundName, { alerted_for_date: today });
}

/** Clear the alerted_for_date so a fresh alert can fire on the next cap hit.
 *  Called by the daily cron tick at midnight UTC. */
export async function clearDailyCapAlertState(fundName: string): Promise<void> {
  await writeDailyCapState(fundName, {});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/daily-cap-notify.test.ts && pnpm typecheck`
Expected: 3 tests pass, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/daily-cap.service.ts tests/daily-cap-notify.test.ts
git commit -m "feat(daily-cap): notifyDailyCapReached with one-shot per-day dedup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire JSONL append + daily cap check into runFundSession

**Files:**
- Modify: `/Users/michael/Proyectos/fundx/src/services/session.service.ts`
- Create: `/Users/michael/Proyectos/fundx/tests/daily-cap.test.ts`

This is the integration task. The JSONL append fires at session end (after `writeSessionLog`). The cap check fires at session start (before SDK invocation). Both share `fundPaths(fundName).state` paths.

- [ ] **Step 1: Write failing tests for the integration**

Create `/Users/michael/Proyectos/fundx/tests/daily-cap.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FUND = "fundx-cap-integration";
let tmpRoot: string;

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => {
      const root = join(tmpRoot, "funds", name);
      return {
        ...actual.fundPaths(name),
        root,
        state: {
          ...actual.fundPaths(name).state,
          dir: join(root, "state"),
          sessionLogJsonl: join(root, "state", "session_log.jsonl"),
          dailyCapState: join(root, "state", "daily_cap_state.json"),
        },
      };
    },
  };
});

const notifyMock = vi.fn();
vi.mock("../src/services/daemon.service.js", () => ({
  notifyDaemonEvent: (...args: unknown[]) => notifyMock(...args),
}));

import { appendSessionLogEntry } from "../src/services/session-history.service.js";
import { checkDailyCap } from "../src/services/session.service.js";
import type { SessionLogV2 } from "../src/types.js";

const mkLog = (cost: number): SessionLogV2 => ({
  fund: FUND,
  session_type: "pre_market",
  started_at: new Date().toISOString(),
  trades_executed: 0,
  summary: "",
  cost_usd: cost,
  status: "success",
});

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `fundx-cap-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(tmpRoot, "funds", FUND, "state"), { recursive: true });
  notifyMock.mockReset();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("checkDailyCap", () => {
  it("returns ok=true when total below cap", async () => {
    await appendSessionLogEntry(FUND, mkLog(2.0));
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(true);
  });

  it("returns ok=false when total at cap", async () => {
    await appendSessionLogEntry(FUND, mkLog(5.0));
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(false);
    expect(result.usage.totalUsd).toBeCloseTo(5.0);
  });

  it("returns ok=false when total above cap", async () => {
    await appendSessionLogEntry(FUND, mkLog(3.0));
    await appendSessionLogEntry(FUND, mkLog(2.5));
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(false);
    expect(result.usage.totalUsd).toBeCloseTo(5.5);
  });

  it("ignores entries from previous days", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await appendSessionLogEntry(FUND, { ...mkLog(10), started_at: yesterday });
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(true);
  });

  it("does not crash on missing JSONL file", async () => {
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(true);
    expect(result.usage.totalUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/daily-cap.test.ts`
Expected: FAIL — `checkDailyCap` not exported.

- [ ] **Step 3: Add `checkDailyCap` helper + wire into `runFundSession`**

In `/Users/michael/Proyectos/fundx/src/services/session.service.ts`, add the imports near the top of the file (after existing imports):

```typescript
import {
  appendSessionLogEntry,
  readTodaysSessionUsage,
  type DailyUsage,
} from "./session-history.service.js";
import { notifyDailyCapReached } from "./daily-cap.service.js";
```

Then add the `checkDailyCap` helper near `resolveDailyCapUsd` (just below it):

```typescript
/** Pure-ish: read today's usage and compare to the cap. Returns allowed=false
 *  when totalUsd >= cap. Caller is responsible for emitting alerts and writing
 *  the skip log. */
export async function checkDailyCap(
  fundName: string,
  cap: number,
): Promise<{ allowed: boolean; usage: DailyUsage }> {
  const usage = await readTodaysSessionUsage(fundName);
  return { allowed: usage.totalUsd < cap, usage };
}
```

Now wire into `runFundSession`. Find the existing `await writeSessionLog(fundName, log);` line (around line 346 — confirm via grep) and the SDK invocation just before it. The pre-session check goes BEFORE the SDK invocation. The JSONL append goes AFTER `writeSessionLog`.

Pre-session check (insert near the top of `runFundSession`, after `const budget = resolveBudget(...)` line ~270):

```typescript
  const dailyCap = resolveDailyCapUsd(config, globalConfig);
  const capCheck = await checkDailyCap(fundName, dailyCap);
  if (!capCheck.allowed) {
    const skipLog: SessionLogV2 = {
      fund: fundName,
      session_type: sessionType,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      trades_executed: 0,
      summary: `Skipped: daily cap $${dailyCap} reached ($${capCheck.usage.totalUsd.toFixed(2)} used in ${capCheck.usage.sessionCount} sessions)`,
      cost_usd: 0,
      status: "skipped_daily_cap",
      budget_resolved: budget,
    };
    await writeSessionLog(fundName, skipLog);
    await appendSessionLogEntry(fundName, skipLog);
    await notifyDailyCapReached(fundName, dailyCap, capCheck.usage);
    return;
  }
```

Post-session JSONL append (right after the existing `await writeSessionLog(fundName, log);`):

```typescript
  await writeSessionLog(fundName, log);
  await appendSessionLogEntry(fundName, log);
```

Note: the exact location of the SDK invocation and the value of the `log` variable depend on the existing structure of `runFundSession`. Read the function carefully before making changes — the `SessionLogV2` payload built in the existing code is what gets appended.

- [ ] **Step 4: Run unit tests for checkDailyCap**

Run: `pnpm test -- tests/daily-cap.test.ts`
Expected: 5 tests pass.

- [ ] **Step 5: Run full suite**

Run: `pnpm test && pnpm typecheck`
Expected: full suite green, 0 type errors. The existing `runFundSession` test (if any) should still pass — the cap check is a no-op when JSONL is empty (which it is in mocked tests).

- [ ] **Step 6: Commit**

```bash
git add src/services/session.service.ts tests/daily-cap.test.ts
git commit -m "feat(session): wire daily cap pre-check + JSONL append into runFundSession

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Daily cron prune in daemon.service.ts

**Files:**
- Modify: `/Users/michael/Proyectos/fundx/src/services/daemon.service.ts`

The daemon already has cron schedules for sessions and (from Phase 5) auto-reports. Add a once-per-day tick at midnight UTC that calls `pruneSessionLogJsonl` and `clearDailyCapAlertState` for every fund.

- [ ] **Step 1: Find existing cron schedule registration**

Run: `grep -nE "cron\.schedule|node-cron|0 0 \* \* \*" /Users/michael/Proyectos/fundx/src/services/daemon.service.ts | head -10`

Note the line where existing schedules are registered.

- [ ] **Step 2: Add the daily cleanup schedule**

In `/Users/michael/Proyectos/fundx/src/services/daemon.service.ts`, add the imports near the top:

```typescript
import { pruneSessionLogJsonl } from "./session-history.service.js";
import { clearDailyCapAlertState } from "./daily-cap.service.js";
```

Find where existing `cron.schedule(...)` calls live. Add a new midnight UTC schedule (cron expression `"0 0 * * *"` interpreted as UTC):

```typescript
  // Phase 4: daily JSONL prune + reset cap-alert dedup at 00:00 UTC
  cron.schedule(
    "0 0 * * *",
    async () => {
      const fundNames = await listFundNames();
      for (const fundName of fundNames) {
        try {
          await pruneSessionLogJsonl(fundName, 90);
          await clearDailyCapAlertState(fundName);
        } catch (err) {
          await log(
            `[daily-cleanup] failed for fund ${fundName}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    },
    { timezone: "UTC" },
  );
```

(Adapt to whatever pattern the file already uses — `listFundNames` may need to be imported from `./fund.service.js` if not already in scope.)

- [ ] **Step 3: Verify typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 4: Run full suite**

Run: `pnpm test`
Expected: full suite green. Daemon tests don't exercise the new cron handler directly (cron is hard to unit-test in isolation), but the imports must compile.

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon.service.ts
git commit -m "feat(daemon): daily cron tick — prune JSONL + clear cap-alert state at 00:00 UTC

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Heartbeat watch in supervisor.service.ts

**Files:**
- Modify: `/Users/michael/Proyectos/fundx/src/services/supervisor.service.ts`
- Create: `/Users/michael/Proyectos/fundx/tests/supervisor-heartbeat.test.ts`

This is the supervisor extension. The watch logic is extracted into a pure helper `evaluateHeartbeatStaleness` so it's unit-testable without spawning a real supervisor.

- [ ] **Step 1: Write failing tests**

Create `/Users/michael/Proyectos/fundx/tests/supervisor-heartbeat.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { evaluateHeartbeatStaleness } from "../src/services/supervisor.service.js";

const NOW = 1_000_000_000_000;

describe("evaluateHeartbeatStaleness", () => {
  it("returns notStale when heartbeat is fresh (< 3 min old)", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: NOW - 60_000,  // 1 min old
      heartbeatExists: true,
      daemonLaunchedAt: NOW - 600_000,
      daemonRunning: true,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(false);
    expect(result.shouldRecover).toBe(false);
  });

  it("returns shouldAlert when heartbeat is stale (> 3 min) and not previously alerted", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: NOW - 4 * 60_000,  // 4 min old
      heartbeatExists: true,
      daemonLaunchedAt: NOW - 600_000,
      daemonRunning: true,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(true);
    expect(result.shouldRecover).toBe(false);
    expect(result.ageMs).toBe(4 * 60_000);
  });

  it("does not re-alert when already alerted", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: NOW - 4 * 60_000,
      heartbeatExists: true,
      daemonLaunchedAt: NOW - 600_000,
      daemonRunning: true,
      previouslyAlerted: true,
    });
    expect(result.shouldAlert).toBe(false);
    expect(result.shouldRecover).toBe(false);
  });

  it("returns shouldRecover when stale flag was set but heartbeat is now fresh", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: NOW - 60_000,
      heartbeatExists: true,
      daemonLaunchedAt: NOW - 600_000,
      daemonRunning: true,
      previouslyAlerted: true,
    });
    expect(result.shouldAlert).toBe(false);
    expect(result.shouldRecover).toBe(true);
  });

  it("does not alert when heartbeat missing but daemon recently launched (grace period)", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: 0,
      heartbeatExists: false,
      daemonLaunchedAt: NOW - 60_000,  // launched 1 min ago
      daemonRunning: true,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(false);
  });

  it("alerts when heartbeat missing and daemon running > 3 min", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: 0,
      heartbeatExists: false,
      daemonLaunchedAt: NOW - 4 * 60_000,
      daemonRunning: true,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(true);
  });

  it("does not alert when daemon is not running", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: 0,
      heartbeatExists: false,
      daemonLaunchedAt: NOW - 4 * 60_000,
      daemonRunning: false,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/supervisor-heartbeat.test.ts`
Expected: FAIL — `evaluateHeartbeatStaleness` not exported.

- [ ] **Step 3: Add the pure helper + wire into startSupervisor**

In `/Users/michael/Proyectos/fundx/src/services/supervisor.service.ts`, add the import for `stat` and `existsSync` (if not already present):

```typescript
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DAEMON_HEARTBEAT } from "../paths.js";
```

(Some of these may already be imported — check first; do not duplicate.)

Add the pure helper near the top of the file (after `getBackoffDelay`):

```typescript
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

export interface HeartbeatEvalInput {
  now: number;
  heartbeatMtimeMs: number;
  heartbeatExists: boolean;
  daemonLaunchedAt: number;
  daemonRunning: boolean;
  previouslyAlerted: boolean;
}

export interface HeartbeatEvalResult {
  shouldAlert: boolean;
  shouldRecover: boolean;
  stale: boolean;
  ageMs: number;
}

/** Pure: decide whether to alert / recover based on heartbeat freshness. */
export function evaluateHeartbeatStaleness(input: HeartbeatEvalInput): HeartbeatEvalResult {
  if (!input.daemonRunning) {
    return { shouldAlert: false, shouldRecover: false, stale: false, ageMs: 0 };
  }

  let stale = false;
  let ageMs = 0;
  if (input.heartbeatExists) {
    ageMs = input.now - input.heartbeatMtimeMs;
    stale = ageMs > HEARTBEAT_STALE_MS;
  } else {
    const sinceLaunchMs = input.now - input.daemonLaunchedAt;
    stale = sinceLaunchMs > HEARTBEAT_STALE_MS;
    ageMs = sinceLaunchMs;
  }

  const shouldAlert = stale && !input.previouslyAlerted;
  const shouldRecover = !stale && input.previouslyAlerted;
  return { shouldAlert, shouldRecover, stale, ageMs };
}
```

Now wire it into `startSupervisor()`. Inside the function, after `launchDaemon()` is defined and the function is called, add the heartbeat check loop. Find the existing `restartCheckInterval` block (around line 109) and add the new interval immediately after it:

```typescript
  // Phase 4: heartbeat freshness watch
  let heartbeatAlerted = false;
  let daemonLaunchedAt = Date.now();

  // Update daemonLaunchedAt every time we (re-)launch the daemon. The existing
  // launchDaemon function is closure-scoped; wrap it via a helper or update the
  // callsite. Simplest: capture the timestamp inside launchDaemon's body.
  // (See Step 4 — adjust launchDaemon to set daemonLaunchedAt.)

  const heartbeatCheckInterval = setInterval(async () => {
    if (stopping) return;
    let mtimeMs = 0;
    let exists = false;
    if (existsSync(DAEMON_HEARTBEAT)) {
      try {
        const s = await stat(DAEMON_HEARTBEAT);
        mtimeMs = s.mtimeMs;
        exists = true;
      } catch {
        // read error → treat as missing
      }
    }

    const result = evaluateHeartbeatStaleness({
      now: Date.now(),
      heartbeatMtimeMs: mtimeMs,
      heartbeatExists: exists,
      daemonLaunchedAt,
      daemonRunning: currentChild !== null,
      previouslyAlerted: heartbeatAlerted,
    });

    if (result.shouldAlert) {
      try {
        const { notifyDaemonEvent } = await import("./daemon.service.js");
        await notifyDaemonEvent(
          "Daemon heartbeat stale",
          `Heartbeat ${Math.round(result.ageMs / 1000)}s old. Sessions may be missed.`,
        );
        heartbeatAlerted = true;
      } catch {
        /* best effort */
      }
    } else if (result.shouldRecover) {
      try {
        const { notifyDaemonEvent } = await import("./daemon.service.js");
        await notifyDaemonEvent(
          "Daemon heartbeat recovered",
          "Heartbeat fresh again after stale period.",
        );
        heartbeatAlerted = false;
      } catch {
        /* best effort */
      }
    }
  }, 60_000);

  process.on("SIGTERM", () => clearInterval(heartbeatCheckInterval));
  process.on("SIGINT", () => clearInterval(heartbeatCheckInterval));
```

- [ ] **Step 4: Update launchDaemon to set daemonLaunchedAt**

Inside `launchDaemon` (the inner function), at the start of its body, set:

```typescript
  function launchDaemon() {
    daemonLaunchedAt = Date.now();
    const child = fork(process.argv[1]!, ["--_daemon-mode"], { stdio: "inherit" });
    // ... rest unchanged
```

Hoist the `daemonLaunchedAt` declaration OUTSIDE `launchDaemon` (in `startSupervisor` body) so it's shared across re-launches. Also keep it in scope for the heartbeat interval callback.

- [ ] **Step 5: Run unit tests for the helper**

Run: `pnpm test -- tests/supervisor-heartbeat.test.ts`
Expected: 7 tests pass.

- [ ] **Step 6: Run full suite**

Run: `pnpm test && pnpm typecheck`
Expected: full suite green, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/services/supervisor.service.ts tests/supervisor-heartbeat.test.ts
git commit -m "feat(supervisor): heartbeat watch — alert on >3min stale + recovery message

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: getDailyUsagePerFund in status.service.ts

**Files:**
- Modify: `/Users/michael/Proyectos/fundx/src/services/status.service.ts`
- Create: `/Users/michael/Proyectos/fundx/tests/status-daily-usage.test.ts`

- [ ] **Step 1: Write failing tests**

Create `/Users/michael/Proyectos/fundx/tests/status-daily-usage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    workspacePaths: () => ({ ...actual.workspacePaths(), root: tmpRoot, fundsDir: join(tmpRoot, "funds") }),
    fundPaths: (name: string) => {
      const root = join(tmpRoot, "funds", name);
      return {
        ...actual.fundPaths(name),
        root,
        state: {
          ...actual.fundPaths(name).state,
          dir: join(root, "state"),
          sessionLogJsonl: join(root, "state", "session_log.jsonl"),
        },
      };
    },
  };
});

vi.mock("../src/services/fund.service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/fund.service.js")>("../src/services/fund.service.js");
  return {
    ...actual,
    listFundNames: vi.fn(),
    loadFundConfig: vi.fn(),
  };
});

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn(),
}));

import { getDailyUsagePerFund } from "../src/services/status.service.js";
import { listFundNames, loadFundConfig } from "../src/services/fund.service.js";
import { loadGlobalConfig } from "../src/config.js";

const mockedListFundNames = vi.mocked(listFundNames);
const mockedLoadFundConfig = vi.mocked(loadFundConfig);
const mockedLoadGlobalConfig = vi.mocked(loadGlobalConfig);

const FUND_A = "fundx-A";
const FUND_B = "fundx-B";

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `fundx-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(tmpRoot, "funds", FUND_A, "state"), { recursive: true });
  await mkdir(join(tmpRoot, "funds", FUND_B, "state"), { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const FUND_CONFIG_NO_BUDGET = { budget: undefined } as never;
const FUND_CONFIG_CAP_10 = { budget: { dailyCapUsd: 10 } } as never;

describe("getDailyUsagePerFund", () => {
  it("returns zero usage for a fund with no JSONL file", async () => {
    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    const usage = map.get(FUND_A);
    expect(usage?.totalUsd).toBe(0);
    expect(usage?.cap).toBe(5);
    expect(usage?.pct).toBe(0);
    expect(usage?.capped).toBe(false);
  });

  it("aggregates today's cost_usd from JSONL", async () => {
    const today = new Date().toISOString();
    const jsonl = [
      JSON.stringify({ fund: FUND_A, session_type: "pre_market", started_at: today, trades_executed: 0, summary: "", cost_usd: 1.0 }),
      JSON.stringify({ fund: FUND_A, session_type: "mid_session", started_at: today, trades_executed: 0, summary: "", cost_usd: 1.34 }),
    ].join("\n") + "\n";
    await writeFile(join(tmpRoot, "funds", FUND_A, "state", "session_log.jsonl"), jsonl, "utf-8");

    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.totalUsd).toBeCloseTo(2.34, 2);
    expect(map.get(FUND_A)?.sessionCount).toBe(2);
    expect(map.get(FUND_A)?.pct).toBeCloseTo(46.8, 1);
  });

  it("reports capped=true when total >= cap", async () => {
    const today = new Date().toISOString();
    const jsonl = JSON.stringify({ fund: FUND_A, session_type: "pre_market", started_at: today, trades_executed: 0, summary: "", cost_usd: 5.12 }) + "\n";
    await writeFile(join(tmpRoot, "funds", FUND_A, "state", "session_log.jsonl"), jsonl, "utf-8");

    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.capped).toBe(true);
    expect(map.get(FUND_A)?.pct).toBeGreaterThan(100);
  });

  it("returns independent counters per fund", async () => {
    const today = new Date().toISOString();
    await writeFile(
      join(tmpRoot, "funds", FUND_A, "state", "session_log.jsonl"),
      JSON.stringify({ fund: FUND_A, session_type: "pre_market", started_at: today, trades_executed: 0, summary: "", cost_usd: 2.0 }) + "\n",
      "utf-8",
    );
    await writeFile(
      join(tmpRoot, "funds", FUND_B, "state", "session_log.jsonl"),
      JSON.stringify({ fund: FUND_B, session_type: "pre_market", started_at: today, trades_executed: 0, summary: "", cost_usd: 4.0 }) + "\n",
      "utf-8",
    );

    mockedListFundNames.mockResolvedValue([FUND_A, FUND_B]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.totalUsd).toBeCloseTo(2.0, 2);
    expect(map.get(FUND_B)?.totalUsd).toBeCloseTo(4.0, 2);
  });

  it("uses fund.budget.dailyCapUsd when set (cascade)", async () => {
    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_CAP_10);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.cap).toBe(10);
  });

  it("falls back to global cap when fund cap unset", async () => {
    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({ budget: { dailyCapUsd: 8 } } as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.cap).toBe(8);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/status-daily-usage.test.ts`
Expected: FAIL — `getDailyUsagePerFund` not exported.

- [ ] **Step 3: Implement `getDailyUsagePerFund`**

In `/Users/michael/Proyectos/fundx/src/services/status.service.ts`, add the imports near the top (after existing imports):

```typescript
import { readTodaysSessionUsage } from "./session-history.service.js";
import { resolveDailyCapUsd } from "./session.service.js";
import { listFundNames, loadFundConfig } from "./fund.service.js";
import { loadGlobalConfig } from "../config.js";
```

(Some of these may already be imported — check first; do not duplicate.)

Add the new exported function:

```typescript
export interface FundDailyUsage {
  totalUsd: number;
  sessionCount: number;
  cap: number;
  pct: number;       // (totalUsd / cap) * 100
  capped: boolean;   // pct >= 100
}

/** Per-fund map of today's USD usage + cap + threshold percentage.
 *  Used by `fundx status` and the dashboard. */
export async function getDailyUsagePerFund(): Promise<Map<string, FundDailyUsage>> {
  const result = new Map<string, FundDailyUsage>();
  const fundNames = await listFundNames();
  const globalConfig = await loadGlobalConfig();

  for (const name of fundNames) {
    const fundConfig = await loadFundConfig(name);
    const cap = resolveDailyCapUsd(fundConfig, globalConfig);
    const usage = await readTodaysSessionUsage(name);
    const pct = (usage.totalUsd / cap) * 100;
    result.set(name, {
      totalUsd: usage.totalUsd,
      sessionCount: usage.sessionCount,
      cap,
      pct,
      capped: pct >= 100,
    });
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/status-daily-usage.test.ts && pnpm typecheck`
Expected: 6 tests pass, 0 type errors.

- [ ] **Step 5: Run full suite**

Run: `pnpm test`
Expected: full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/services/status.service.ts tests/status-daily-usage.test.ts
git commit -m "feat(status): getDailyUsagePerFund — today's USD + cap % per fund

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Status UI — add "Today" column

**Files:**
- Modify: `/Users/michael/Proyectos/fundx/src/components/FundsOverviewPanel.tsx`
- Modify: `/Users/michael/Proyectos/fundx/src/commands/status.tsx`

This task has no dedicated tests — the rendering is visual. We rely on Task 9's service tests + a manual smoke test in Task 12.

- [ ] **Step 1: Find current FundsOverviewPanel structure**

Run: `head -80 /Users/michael/Proyectos/fundx/src/components/FundsOverviewPanel.tsx`

Note the component's prop interface and current row rendering.

- [ ] **Step 2: Extend the prop interface to accept daily usage**

In `/Users/michael/Proyectos/fundx/src/components/FundsOverviewPanel.tsx`, add to the props interface (likely near the top):

```typescript
import type { FundDailyUsage } from "../services/status.service.js";

interface FundsOverviewPanelProps {
  // ... existing props ...
  dailyUsage?: Map<string, FundDailyUsage>;
}
```

In the per-fund row renderer, add a new cell. The exact placement depends on the existing layout — append after the existing "Status / Value / P&L" cells. Use Ink `<Box>` and `<Text>` components.

```tsx
{props.dailyUsage && (() => {
  const usage = props.dailyUsage.get(fund.name);
  if (!usage) return null;
  const pctRounded = Math.round(usage.pct);
  let color: "redBright" | "yellow" | "white" | "gray" = "gray";
  if (usage.capped) color = "redBright";
  else if (usage.pct >= 80) color = "yellow";
  else if (usage.pct >= 50) color = "white";
  const display = usage.capped
    ? `CAPPED ($${usage.totalUsd.toFixed(2)}/$${usage.cap})`
    : `today: $${usage.totalUsd.toFixed(2)}/$${usage.cap} (${pctRounded}%)`;
  return <Text color={color}>{usage.capped ? `🔴 ${display}` : display}</Text>;
})()}
```

- [ ] **Step 3: Wire `getDailyUsagePerFund` into `getSystemInfo` in status.tsx**

In `/Users/michael/Proyectos/fundx/src/commands/status.tsx`, add the import:

```typescript
import { getDailyUsagePerFund, type FundDailyUsage } from "../services/status.service.js";
```

Extend `SystemInfo`:

```typescript
interface SystemInfo {
  // ... existing fields ...
  dailyUsage: Map<string, FundDailyUsage>;
}
```

Inside `getSystemInfo`, add at the end (before the `return`):

```typescript
  const dailyUsage = await getDailyUsagePerFund();
```

Add `dailyUsage` to the returned object:

```typescript
  return {
    // ... existing fields ...
    dailyUsage,
  };
```

Pass to `FundsOverviewPanel`:

```tsx
<FundsOverviewPanel
  funds={...}
  // ... existing props ...
  dailyUsage={info.dailyUsage}
/>
```

- [ ] **Step 4: Verify build**

Run: `cd /Users/michael/Proyectos/fundx && pnpm build`
Expected: build succeeds, no type errors.

- [ ] **Step 5: Run full suite**

Run: `pnpm test && pnpm typecheck`
Expected: full suite green, 0 type errors. UI changes don't break tests.

- [ ] **Step 6: Manual visual sanity check**

Run: `pnpm dev -- status`
Expected: status command runs without error; if any funds exist, the new "Today" cell appears (likely showing $0/$5 (0%) since no JSONL entries exist yet).

- [ ] **Step 7: Commit**

```bash
git add src/components/FundsOverviewPanel.tsx src/commands/status.tsx
git commit -m "feat(status-ui): add today's USD/cap column to FundsOverviewPanel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Operations runbook (`docs/operations.md`)

**Files:**
- Create: `/Users/michael/Proyectos/fundx/docs/operations.md`

This task is content-only.

- [ ] **Step 1: Create the runbook**

Create `/Users/michael/Proyectos/fundx/docs/operations.md` with this exact content:

```markdown
# FundX Operations Runbook

This runbook covers day-to-day operation of a FundX deployment: starting and
stopping services, where to read logs, and how to interpret each Telegram
alert.

## Starting / stopping

| Command | Effect |
|---|---|
| `fundx start` | Launch supervisor (forks daemon). Daemon runs cron schedules + Telegram gateway. |
| `fundx stop` | Clean shutdown. Supervisor signals daemon (SIGTERM), waits for graceful exit. |
| `fundx status` | Snapshot: daemon + supervisor liveness, heartbeat freshness, today's USD per fund. |

## Where to read logs

| Path | Contents |
|---|---|
| `~/.fundx/daemon.log` | Daemon stdout/stderr (rotated by user) |
| `~/.fundx/funds/<name>/state/session_log.jsonl` | Append-only per-session metadata (V2 schema) |
| `~/.fundx/funds/<name>/state/session_log.json` | Last session's metadata (single record) |
| `~/.fundx/funds/<name>/analysis/` | Claude's analysis archives |
| `~/.fundx/funds/<name>/state/handoffs/` | Archived session handoffs (Phase 3a) |

## Telegram alerts — what each means + what to do

| Alert | Cause | Action |
|---|---|---|
| Daemon crashed | Crash exit; supervisor restarting with backoff | None — wait for next alert. If 5 within 10 min → "Max restarts exceeded". |
| Max restarts exceeded | Supervisor gave up after 5 crashes in 10 min | `fundx stop && fundx start`. Read last 100 lines of `daemon.log` to identify the crash cause. |
| Daemon heartbeat stale | Daemon's event loop blocked > 3 min | Check `top` / `ps` for the daemon process. If stuck → restart via `fundx stop && fundx start`. |
| Daemon heartbeat recovered | Heartbeat fresh again after stale period | None — informational. |
| Daily cap reached | A fund hit its daily aggregate USD cap | Sessions skip until 00:00 UTC. To override: edit `fund.budget.dailyCapUsd` in `~/.fundx/funds/<name>/fund_config.yaml`. |
| Budget killed (per-session) | Per-session cap (Phase 1a) hit | Review the session's `summary` in `session_log.json`. Consider raising the per-session cap if it's recurring. |
| Auth restart needed | OAuth token expired | Daemon will be restarted with current token from your `claude` CLI session. Usually self-heals. |

## Common operations

### Raise a fund's daily cap temporarily

Edit `~/.fundx/funds/<name>/fund_config.yaml`:

```yaml
budget:
  dailyCapUsd: 10  # default 5
```

No restart needed — the next session reads the updated config.

### Reset today's daily counter manually (rare)

The counter is computed live from `session_log.jsonl` filtered by today's UTC
date. To force-reset before midnight UTC:

```bash
truncate -s 0 ~/.fundx/funds/<name>/state/session_log.jsonl
```

(This loses today's session metadata — use only if necessary.)

### Check yesterday's spend for a fund

```bash
jq -r 'select(.started_at < "2026-05-08T00:00:00Z") | "\(.started_at) \(.cost_usd)"' \
  ~/.fundx/funds/<name>/state/session_log.jsonl
```

(Substitute the appropriate UTC midnight ISO string.)

### Inspect why the most recent session was skipped

```bash
jq 'select(.status == "skipped_daily_cap") | .summary' \
  ~/.fundx/funds/<name>/state/session_log.jsonl | tail -5
```

### Force-clear the cap-alert dedup state

If you raised the cap mid-day and want a fresh alert next time it's hit:

```bash
echo '{}' > ~/.fundx/funds/<name>/state/daily_cap_state.json
```

## When to escalate (manual debug needed)

- **Daemon crash loop** ("Max restarts exceeded"): something is crashing on
  startup. Read `daemon.log`. Common causes: corrupted state file, missing
  API key, port already bound.
- **All funds frozen at daily cap before noon**: caps are set too low for
  current activity. Raise the global cap in `~/.fundx/config.yaml`.
- **Heartbeat stale > 30 min and no recovery**: daemon process likely
  deadlocked. `kill -KILL <pid>` to force-restart via supervisor.
- **JSONL file growing unexpectedly large**: daily cron prune may not be
  running. Check daemon.log for cron errors. Manual prune:
  `node -e "import('./dist/services/session-history.service.js').then(m => m.pruneSessionLogJsonl('<fund>', 90))"`
```

- [ ] **Step 2: Commit**

```bash
git add docs/operations.md
git commit -m "docs: add operations runbook (alerts, common ops, escalation)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: Smoke verification

**Files:**
- Manual: real test fund, simulated cap exceedance
- Modify: `/Users/michael/Proyectos/fundx/docs/superpowers/audit-1b/audit-log.md`
- Modify: `/Users/michael/Proyectos/fundx/docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md`
- Modify: `/Users/michael/Proyectos/fundx/CLAUDE.md`

This task verifies the full pipeline end-to-end with a real test fund. Since we don't want to spend $5+ on real sessions just to hit the cap, we'll prepopulate the JSONL with synthetic entries to simulate a near-capped state.

- [ ] **Step 1: Pick a test fund**

Use the existing `fundx-audit` test fund. Verify it exists:

```bash
ls ~/.fundx/funds/fundx-audit/
```

Expected: fund directory exists with `fund_config.yaml`, `state/`, etc.

- [ ] **Step 2: Verify build is current**

```bash
cd /Users/michael/Proyectos/fundx && pnpm build
```
Expected: build succeeds.

- [ ] **Step 3: Set a low daily cap on the test fund**

Edit `~/.fundx/funds/fundx-audit/fund_config.yaml`. Add to the `budget:` section (or create it):

```yaml
budget:
  dailyCapUsd: 1  # tiny cap for smoke test
```

- [ ] **Step 4: Pre-populate the JSONL with a near-cap entry**

```bash
TODAY_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"fund\":\"fundx-audit\",\"session_type\":\"pre_market\",\"started_at\":\"$TODAY_ISO\",\"trades_executed\":0,\"summary\":\"smoke\",\"cost_usd\":0.95,\"status\":\"success\"}" \
  >> ~/.fundx/funds/fundx-audit/state/session_log.jsonl
```

- [ ] **Step 5: Verify status command shows >80% cap**

```bash
fundx status
```

Expected: `fundx-audit` row shows `today: $0.95/$1 (95% ⚠️)` in YELLOW.

- [ ] **Step 6: Trigger one session that should be SKIPPED**

```bash
fundx session run --fund fundx-audit --session-type mid_session
```

Expected:
- Session is skipped (no SDK invocation)
- `session_log.json` shows `status: "skipped_daily_cap"` and the summary mentions the cap
- `session_log.jsonl` has a new line with `cost_usd: 0` and the same status
- Telegram alert "Daily cap reached" fires (if Telegram is configured for this fund)

Verify:
```bash
jq '.status, .summary' ~/.fundx/funds/fundx-audit/state/session_log.json
tail -1 ~/.fundx/funds/fundx-audit/state/session_log.jsonl | jq '.status, .cost_usd'
cat ~/.fundx/funds/fundx-audit/state/daily_cap_state.json
```

Expected: status is "skipped_daily_cap"; jsonl tail cost_usd is 0; daily_cap_state has today's date.

- [ ] **Step 7: Trigger a SECOND skipped session (verify dedup)**

```bash
fundx session run --fund fundx-audit --session-type post_market
```

Expected: skipped again, but NO new Telegram alert (dedup).

- [ ] **Step 8: Verify supervisor heartbeat alert fires**

While the daemon is running, simulate a stall:

```bash
DAEMON_PID=$(cat ~/.fundx/daemon.pid)
kill -STOP $DAEMON_PID
# wait 4 minutes (heartbeat threshold is 3 min)
sleep 240
```

Expected (within 1 min of the 4-min mark): Telegram alert "Daemon heartbeat stale" fires.

```bash
kill -CONT $DAEMON_PID
sleep 90
```

Expected (within 1 min): Telegram alert "Daemon heartbeat recovered" fires.

- [ ] **Step 9: Reset the test fund**

Restore `fundx-audit/fund_config.yaml` budget section to its original value (or remove if it didn't have one):

```yaml
# Remove or restore the budget block
```

Truncate the JSONL test entries:

```bash
truncate -s 0 ~/.fundx/funds/fundx-audit/state/session_log.jsonl
echo '{}' > ~/.fundx/funds/fundx-audit/state/daily_cap_state.json
```

- [ ] **Step 10: Update audit log**

Append to `/Users/michael/Proyectos/fundx/docs/superpowers/audit-1b/audit-log.md`:

```markdown

---

## Phase 4 verification — 2026-05-09

| Test | Result | Cost | Notes |
|---|---|---:|---|
| Smoke 1: fund near cap → next session skipped + alert | <FILL: ✅ PASS / ❌ FAIL> | <$X.XX> | Pre-populated JSONL with cost_usd=0.95 against cap=$1; mid_session skipped with status="skipped_daily_cap"; Telegram alert "Daily cap reached" fired. |
| Smoke 2: second skipped session same day → dedup (no new alert) | <FILL> | $0 | post_market also skipped; daily_cap_state shows today's date; no second Telegram message. |
| Smoke 3: heartbeat stall via SIGSTOP > 3 min → stale alert | <FILL> | $0 | kill -STOP daemon for 4 min; supervisor's heartbeat watch fired "Daemon heartbeat stale". |
| Smoke 4: SIGCONT → recovery alert | <FILL> | $0 | kill -CONT; "Daemon heartbeat recovered" fired within 1 min. |
| MVP eval suite | <FILL: ✅ 8/8 PASS> | <$X.XX> | No regressions from Phase 4 changes (operational layer only). |
| **Phase 4 cumulative** | | <$XX.XX> | All 4 mechanisms confirmed end-to-end. |

### Coverage summary

End-to-end verification of Phase 4 G6:

- **Append-only JSONL** ✅ — every session writes a line; today's filter works.
- **Daily cap enforcement** ✅ — sessions skipped + alert fires + dedup works.
- **Heartbeat watch** ✅ — both stale and recovery alerts confirmed via SIGSTOP/SIGCONT.
- **Status UI** ✅ — `fundx status` shows today's USD with threshold colors.
- **Runbook** ✅ — `docs/operations.md` reviewed.
```

(Fill in actual costs and results from your runs.)

- [ ] **Step 11: Update roadmap status log**

In `/Users/michael/Proyectos/fundx/docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md`, append a new row to the status log table:

```markdown
| 2026-05-09 | Phase 4 complete (G6 operational observability): daily-per-fund USD cap enforcement, append-only `session_log.jsonl` audit trail, supervisor heartbeat watch (3 min threshold) with one-shot + recovery alerts, `fundx status` extension showing today's USD per fund with threshold colors, `docs/operations.md` runbook. New components: `src/services/session-history.service.ts` (6 unit tests), `src/services/daily-cap.service.ts` (3 unit tests), `evaluateHeartbeatStaleness` pure helper in supervisor (7 unit tests). Schema additions: `fundBudgetConfigSchema.dailyCapUsd?` (cascade fund > global > default $5), `sessionLogV2Schema.status` enum + `"skipped_daily_cap"`. Daily cron tick at 00:00 UTC prunes JSONL (90-day retention) + clears alert dedup state. No agent behaviour change. Total cost ~$X.XX (smoke + MVP eval). Roadmap complete: G1-G7 closed (G2 Phase 1a, G7 Phase 1b, G1+G3 Phase 2, G4 Phase 3a, G5 Phase 3b/3b.1/3b.2, G6 Phase 4). Phase 1c (75% soft warning) remains deferred. See [phase-4 spec](./2026-05-07-harness-phase-4-design.md). |
```

(Fill in `$X.XX` with the actual smoke + MVP eval cost from Step 10.)

- [ ] **Step 12: Update CLAUDE.md**

In `/Users/michael/Proyectos/fundx/CLAUDE.md`, find the "Budgets" line in the Configuration section. Add a sentence about the daily cap:

```markdown
- Daily-per-fund cap: `fund.budget.dailyCapUsd` → `global.budget.dailyCapUsd` → default $5/day. Sessions exceeding the cap are skipped with status `skipped_daily_cap` until 00:00 UTC. See `docs/operations.md` for the operations runbook.
```

- [ ] **Step 13: Final test sweep**

```bash
cd /Users/michael/Proyectos/fundx
pnpm test && pnpm typecheck && pnpm build
```

Expected: full suite green, 0 errors, build succeeds.

- [ ] **Step 14: Commit**

```bash
git add docs/superpowers/audit-1b/audit-log.md docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md CLAUDE.md
git commit -m "audit(phase-4): smoke tests + MVP eval verification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Checklist (before marking phase complete)

After all 12 tasks complete:

- [ ] `pnpm test` is green (full suite, ~810 tests).
- [ ] `pnpm typecheck` is clean.
- [ ] `pnpm build` succeeds.
- [ ] `git log --oneline -15` shows ~12 commits with descriptive messages.
- [ ] Smoke tests confirm: cap-skip + dedup + heartbeat stall + heartbeat recovery.
- [ ] `fundx status` shows daily USD per fund (verified visually).
- [ ] `docs/operations.md` reviewed.
- [ ] Roadmap status log has Phase 4 completion entry.
- [ ] CLAUDE.md mentions daily cap mechanism.
- [ ] Test fund (`fundx-audit`) state restored to baseline (no leftover budget overrides, JSONL truncated, dedup state cleared).

If any item is not true, the phase is **not** done.
