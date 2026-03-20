# Daemon Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FundX daemon resilient to crashes with auto-restart, per-fund locking, missed session catch-up, log rotation, and Telegram alerting.

**Architecture:** A lightweight supervisor process forks the daemon and restarts it on crash with exponential backoff. The daemon itself gains heartbeat monitoring, per-fund mutex locks, catch-up detection on startup, log rotation, and Telegram notifications for critical events. All changes are backward-compatible with the existing cron-based scheduling model.

**Tech Stack:** TypeScript, Node.js `child_process.fork()`, `node-cron`, `grammy` (Telegram), Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-03-20-daemon-resilience-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/lock.ts` | Per-fund file-based mutex (`acquireFundLock`, `releaseFundLock`, `isLockStale`) + `withTimeout` utility |
| `src/services/supervisor.service.ts` | Supervisor process: fork daemon, restart on crash, backoff, max-restart limit, Telegram alerts |
| `tests/lock.test.ts` | Unit tests for lock module |
| `tests/supervisor.test.ts` | Unit tests for supervisor module |

### Modified files

| File | Changes |
|------|---------|
| `src/types.ts` | Add `SessionHistory` schema, `DaemonPidInfo` schema |
| `src/paths.ts` | Add `SUPERVISOR_PID`, `DAEMON_HEARTBEAT`, `fundLockFile()`, `fundSessionHistoryFile()`, log rotation constants |
| `src/state.ts` | Add `readSessionHistory()`, `writeSessionHistory()` |
| `src/services/session.service.ts` | Write `session_history.json` after each session |
| `src/services/daemon.service.ts` | PID JSON format, heartbeat, backpressure, lock-gated cron loop, catch-up, log rotation, notifications, remove `forkDaemon()` |
| `src/services/status.service.ts` | Replace inline `getDaemonStatus()` with import from `daemon.service.ts` |
| `src/services/chat.service.ts` | Replace inline `getDaemonStatus()` with import from `daemon.service.ts` |
| `src/index.tsx` | Add `--_supervisor-mode` entry point |
| `src/commands/start.tsx` | Call `forkSupervisor()` instead of `startDaemon()` |
| `src/commands/stop.tsx` | Call `stopSupervisor()` instead of `stopDaemon()` |
| `tests/daemon-integration.test.ts` | Update for refactored daemon (backpressure, locks, heartbeat) |

---

## Task 1: Types and Path Constants

**Files:**
- Modify: `src/types.ts` (append at end of file)
- Modify: `src/paths.ts:17-20,57-80` (add constants and helpers)
- Test: `tests/paths.test.ts`

- [ ] **Step 1: Add schemas to `src/types.ts`**

Append at end of file:

```typescript
// ── Daemon Resilience Schemas ────────────────────────────────

export const sessionHistorySchema = z.record(z.string(), z.string());
export type SessionHistory = z.infer<typeof sessionHistorySchema>;

export const daemonPidInfoSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  version: z.string(),
});
export type DaemonPidInfo = z.infer<typeof daemonPidInfoSchema>;
```

- [ ] **Step 2: Add path constants to `src/paths.ts`**

Add after `DAEMON_LOG` (line 20):

```typescript
/** Supervisor PID file */
export const SUPERVISOR_PID = join(WORKSPACE, "supervisor.pid");

/** Daemon heartbeat file */
export const DAEMON_HEARTBEAT = join(WORKSPACE, "daemon.heartbeat");

/** Max daemon log size before rotation (5 MB) */
export const DAEMON_LOG_MAX_SIZE = 5 * 1024 * 1024;

/** Max number of rotated log files to keep */
export const DAEMON_LOG_MAX_FILES = 3;
```

Add inside `fundPaths()` return object, in the `state` block after `chatHistory`:

```typescript
sessionHistory: join(root, "state", "session_history.json"),
lock: join(root, "state", ".lock"),
```

- [ ] **Step 3: Run existing tests to verify no regressions**

Run: `pnpm test -- tests/paths.test.ts tests/types.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/paths.ts
git commit -m "feat(resilience): add daemon PID, session history, and lock path constants"
```

---

## Task 2: Fund Lock Module

**Files:**
- Create: `src/lock.ts`
- Test: `tests/lock.test.ts`

- [ ] **Step 1: Install memfs for virtual filesystem testing**

Run: `pnpm add -D memfs`

- [ ] **Step 2: Write failing tests for `acquireFundLock`, `releaseFundLock`, `isLockStale`, and `withTimeout`**

Create `tests/lock.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { vol } from "memfs";

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("../src/paths.js", () => ({
  fundPaths: (name: string) => ({
    state: {
      lock: `/mock/.fundx/funds/${name}/state/.lock`,
    },
  }),
}));

import { acquireFundLock, releaseFundLock, isLockStale, withTimeout } from "../src/lock.js";

beforeEach(() => {
  vol.reset();
  vol.mkdirSync("/mock/.fundx/funds/test-fund/state", { recursive: true });
});

describe("acquireFundLock", () => {
  it("acquires lock when no lock file exists", async () => {
    const acquired = await acquireFundLock("test-fund", "pre_market");
    expect(acquired).toBe(true);
  });

  it("returns false when lock already held by live process", async () => {
    await acquireFundLock("test-fund", "pre_market");
    const second = await acquireFundLock("test-fund", "mid_session");
    expect(second).toBe(false);
  });
});

describe("releaseFundLock", () => {
  it("removes the lock file", async () => {
    await acquireFundLock("test-fund", "pre_market");
    await releaseFundLock("test-fund");
    const reacquired = await acquireFundLock("test-fund", "pre_market");
    expect(reacquired).toBe(true);
  });

  it("does not throw if lock does not exist", async () => {
    await expect(releaseFundLock("test-fund")).resolves.not.toThrow();
  });
});

describe("isLockStale", () => {
  it("returns false when no lock exists", async () => {
    expect(await isLockStale("test-fund")).toBe(false);
  });

  it("returns true when lock is older than 25 minutes", async () => {
    await acquireFundLock("test-fund", "pre_market");
    // Manually overwrite lock with old timestamp
    const oldTime = new Date(Date.now() - 26 * 60 * 1000).toISOString();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      "/mock/.fundx/funds/test-fund/state/.lock",
      JSON.stringify({ pid: process.pid, session: "pre_market", since: oldTime }),
    );
    expect(await isLockStale("test-fund")).toBe(true);
  });
});

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });

  it("rejects when promise exceeds timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50)).rejects.toThrow("timed out");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- tests/lock.test.ts`
Expected: FAIL — module `../src/lock.js` not found

- [ ] **Step 4: Implement `src/lock.ts`**

```typescript
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fundPaths } from "./paths.js";

interface LockInfo {
  pid: number;
  session: string;
  since: string;
}

const STALE_THRESHOLD_MS = 25 * 60 * 1000; // 25 minutes

export async function acquireFundLock(fundName: string, sessionType: string): Promise<boolean> {
  const lockFile = fundPaths(fundName).state.lock;

  if (existsSync(lockFile)) {
    if (await isLockStale(fundName)) {
      await unlink(lockFile).catch(() => {});
    } else {
      return false;
    }
  }

  await mkdir(dirname(lockFile), { recursive: true });
  const info: LockInfo = { pid: process.pid, session: sessionType, since: new Date().toISOString() };
  await writeFile(lockFile, JSON.stringify(info), "utf-8");
  return true;
}

export async function releaseFundLock(fundName: string): Promise<void> {
  const lockFile = fundPaths(fundName).state.lock;
  await unlink(lockFile).catch(() => {});
}

export async function isLockStale(fundName: string): Promise<boolean> {
  const lockFile = fundPaths(fundName).state.lock;
  if (!existsSync(lockFile)) return false;

  try {
    const raw = await readFile(lockFile, "utf-8");
    const info: LockInfo = JSON.parse(raw);

    // Check if owning process is dead
    try {
      process.kill(info.pid, 0);
    } catch {
      return true; // process dead -> stale
    }

    // Check age threshold
    const age = Date.now() - new Date(info.since).getTime();
    return age > STALE_THRESHOLD_MS;
  } catch {
    return true; // unreadable -> treat as stale
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- tests/lock.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lock.ts tests/lock.test.ts
git commit -m "feat(resilience): add per-fund file-based mutex and withTimeout utility"
```

---

## Task 3: Session History State

**Files:**
- Modify: `src/state.ts:14-15,148` (add imports and functions)
- Test: `tests/state.test.ts`

- [ ] **Step 1: Add `readSessionHistory` and `writeSessionHistory` to `src/state.ts`**

Add to imports at top:

```typescript
import { type SessionHistory, sessionHistorySchema } from "./types.js";
```

Append before `// ── Initialize state for a new fund`:

```typescript
// ── Session History ───────────────────────────────────────────

export async function readSessionHistory(fundName: string): Promise<SessionHistory> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.sessionHistory);
    return sessionHistorySchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export async function writeSessionHistory(fundName: string, history: SessionHistory): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.sessionHistory, history);
}
```

- [ ] **Step 2: Run existing state tests + verify no regressions**

Run: `pnpm test -- tests/state.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/state.ts
git commit -m "feat(resilience): add session history read/write to state module"
```

---

## Task 4: Session Service — Write Session History

**Files:**
- Modify: `src/services/session.service.ts:2,105` (add import and write call)
- Test: `tests/session.test.ts`

- [ ] **Step 1: Add session history write to `session.service.ts`**

Add to imports (line 2):

```typescript
import { writeSessionLog, readActiveSession, writeActiveSession, readSessionHistory, writeSessionHistory } from "../state.js";
```

After `await writeSessionLog(fundName, log);` (line 105), add:

```typescript
  // Update per-session-type history for catch-up detection
  try {
    const history = await readSessionHistory(fundName);
    history[sessionType] = new Date().toISOString();
    await writeSessionHistory(fundName, history);
  } catch {
    // Non-critical -- catch-up will still work from session_log.json fallback
  }
```

- [ ] **Step 2: Run existing session tests**

Run: `pnpm test -- tests/session.test.ts`
Expected: PASS (mock of state.ts will absorb the new calls)

- [ ] **Step 3: Commit**

```bash
git add src/services/session.service.ts
git commit -m "feat(resilience): write session history after each session for catch-up tracking"
```

---

## Task 5: Daemon — Robust PID and Heartbeat

**Files:**
- Modify: `src/services/daemon.service.ts:1-55,80-86,197-217`
- Test: `tests/daemon-integration.test.ts`

- [ ] **Step 1: Update imports in `daemon.service.ts`**

Replace line 1-5 with:

```typescript
import { writeFile, readFile, appendFile, unlink, stat, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import cron from "node-cron";
import {
  DAEMON_PID, DAEMON_LOG, DAEMON_HEARTBEAT, SUPERVISOR_PID,
  DAEMON_LOG_MAX_SIZE, DAEMON_LOG_MAX_FILES,
} from "../paths.js";
```

Note: Uses `execFileSync` instead of `execSync` to avoid shell injection. The `ps` command is called with arguments as an array.

- [ ] **Step 2: Replace `isDaemonRunning()` with robust version**

Replace the existing `isDaemonRunning()` (lines 34-44) with:

```typescript
/** Check if daemon is already running (robust: validates PID is fundx + heartbeat freshness) */
export async function isDaemonRunning(): Promise<boolean> {
  if (!existsSync(DAEMON_PID)) return false;
  try {
    const raw = await readFile(DAEMON_PID, "utf-8");
    let pid: number;
    try {
      const info = JSON.parse(raw);
      pid = info.pid;
    } catch {
      // Legacy plain-text PID file
      pid = parseInt(raw, 10);
    }
    if (!pid || isNaN(pid)) {
      await unlink(DAEMON_PID).catch(() => {});
      return false;
    }

    // Check process exists
    process.kill(pid, 0);

    // Verify process is actually fundx (Unix-only, best-effort)
    try {
      const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" }).trim();
      if (!cmd.includes("fundx") && !cmd.includes("daemon")) {
        await unlink(DAEMON_PID).catch(() => {});
        return false;
      }
    } catch {
      // ps failed -- trust kill(0) result
    }

    // Check heartbeat freshness (if heartbeat file exists)
    if (existsSync(DAEMON_HEARTBEAT)) {
      try {
        const hb = JSON.parse(await readFile(DAEMON_HEARTBEAT, "utf-8"));
        const age = Date.now() - new Date(hb.timestamp).getTime();
        if (age > 3 * 60 * 1000) {
          // Heartbeat stale -- daemon is hung
          await unlink(DAEMON_PID).catch(() => {});
          return false;
        }
      } catch { /* ignore corrupt heartbeat */ }
    }

    return true;
  } catch {
    await unlink(DAEMON_PID).catch(() => {});
    return false;
  }
}

/** Get daemon PID (for status display) */
export async function getDaemonPid(): Promise<number | null> {
  if (!existsSync(DAEMON_PID)) return null;
  try {
    const raw = await readFile(DAEMON_PID, "utf-8");
    try {
      return JSON.parse(raw).pid;
    } catch {
      return parseInt(raw, 10) || null;
    }
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Update `startDaemon()` to write JSON PID and heartbeat**

Replace the beginning of `startDaemon()` (up to `await startGateway();`) with:

```typescript
export async function startDaemon(): Promise<void> {
  if (await isDaemonRunning()) {
    throw new Error("Daemon is already running.");
  }

  // Write JSON PID file
  const pidInfo = { pid: process.pid, startedAt: new Date().toISOString(), version: "0.1.0" };
  await writeFile(DAEMON_PID, JSON.stringify(pidInfo), "utf-8");
  await updateHeartbeat(0);
  await log(`Daemon started (PID ${process.pid})`);

  // Defensive: stop any lingering gateway before starting fresh
  await stopGateway().catch(() => {});
  await startGateway();

  await rotateLogIfNeeded();
```

Add heartbeat update function near the top (after the `log` function):

```typescript
/** Update the heartbeat file */
async function updateHeartbeat(fundsChecked: number): Promise<void> {
  const hb = { timestamp: new Date().toISOString(), fundsChecked };
  await writeFile(DAEMON_HEARTBEAT, JSON.stringify(hb), "utf-8").catch(() => {});
}
```

- [ ] **Step 4: Update cleanup to remove heartbeat**

Replace `cleanup()`:

```typescript
async function cleanup() {
  await stopGateway();
  await unlink(DAEMON_PID).catch(() => {});
  await unlink(DAEMON_HEARTBEAT).catch(() => {});
  await log("Daemon stopped.");
  process.exit(0);
}
```

- [ ] **Step 5: Update `stopDaemon` to read JSON PID and support supervisor**

Replace `stopDaemon()`:

```typescript
export async function stopSupervisor(): Promise<{ stopped: boolean; pid?: number }> {
  // Try supervisor PID first, fall back to daemon PID
  const pidFile = existsSync(SUPERVISOR_PID) ? SUPERVISOR_PID : DAEMON_PID;
  if (!existsSync(pidFile)) return { stopped: false };

  try {
    const raw = await readFile(pidFile, "utf-8");
    let pid: number;
    try {
      pid = JSON.parse(raw).pid;
    } catch {
      pid = parseInt(raw, 10);
    }
    process.kill(pid, "SIGTERM");
    return { stopped: true, pid };
  } catch {
    await unlink(pidFile).catch(() => {});
    return { stopped: false };
  }
}

// Backward compat alias
export const stopDaemon = stopSupervisor;
```

- [ ] **Step 6: Run daemon integration tests**

Run: `pnpm test -- tests/daemon-integration.test.ts`
Expected: PASS (existing tests should still work -- `isDaemonRunning` mock returns false, `writeFile` is mocked)

- [ ] **Step 7: Commit**

```bash
git add src/services/daemon.service.ts
git commit -m "feat(resilience): robust PID validation, heartbeat, and JSON PID format"
```

---

## Task 6: Daemon — Log Rotation and Notifications

**Files:**
- Modify: `src/services/daemon.service.ts`

- [ ] **Step 1: Add log rotation function**

Add after `updateHeartbeat`:

```typescript
/** Rotate daemon.log if it exceeds max size */
async function rotateLogIfNeeded(): Promise<void> {
  try {
    const stats = await stat(DAEMON_LOG).catch(() => null);
    if (!stats || stats.size < DAEMON_LOG_MAX_SIZE) return;

    // Shift existing rotated files
    for (let i = DAEMON_LOG_MAX_FILES; i >= 1; i--) {
      const src = i === 1 ? DAEMON_LOG : `${DAEMON_LOG}.${i - 1}`;
      const dst = `${DAEMON_LOG}.${i}`;
      await rename(src, dst).catch(() => {});
    }

    // Truncate current log
    await writeFile(DAEMON_LOG, "", "utf-8");
  } catch {
    // Non-critical
  }
}
```

- [ ] **Step 2: Add Telegram notification function**

Add after `rotateLogIfNeeded`:

```typescript
/** Send daemon event notification via Telegram (best-effort with dedup) */
const lastAlertByType = new Map<string, number>();
const ALERT_DEDUP_MS = 30 * 60 * 1000; // 30 minutes

export async function notifyDaemonEvent(event: string, details: string): Promise<void> {
  const now = Date.now();
  const lastSent = lastAlertByType.get(event) ?? 0;
  if (now - lastSent < ALERT_DEDUP_MS) return;

  lastAlertByType.set(event, now);
  await log(`[ALERT] ${event}: ${details}`);

  try {
    const { sendTelegramNotification } = await import("./gateway.service.js");
    await sendTelegramNotification(`<b>[FundX Daemon]</b> ${event}\n${details}`);
  } catch {
    // Telegram is best-effort -- already logged above
  }
}
```

- [ ] **Step 3: Add error tracking**

Add after notification function:

```typescript
/** Track consecutive errors per fund+type for alerting */
const errorCounts = new Map<string, number>();

async function trackError(fundName: string, errorType: string, error: unknown): Promise<void> {
  const key = `${fundName}:${errorType}`;
  const count = (errorCounts.get(key) ?? 0) + 1;
  errorCounts.set(key, count);
  const msg = error instanceof Error ? error.message : String(error);
  await log(`${errorType} error (${fundName}): ${msg}`);

  if (count >= 3) {
    await notifyDaemonEvent("Repeated failures", `${errorType} for '${fundName}' -- ${count} consecutive errors`);
  }
}

function clearError(fundName: string, errorType: string): void {
  errorCounts.delete(`${fundName}:${errorType}`);
}
```

- [ ] **Step 4: Run daemon integration tests**

Run: `pnpm test -- tests/daemon-integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon.service.ts
git commit -m "feat(resilience): add log rotation, Telegram notifications, and error tracking"
```

---

## Task 7: Daemon — Refactor Cron Loop (Backpressure + Locks)

**Files:**
- Modify: `src/services/daemon.service.ts:90-184`

This is the biggest change. Replace the entire cron callback with the new lock-gated, async-safe version.

- [ ] **Step 1: Add lock import to daemon.service.ts**

Add to imports:

```typescript
import { acquireFundLock, releaseFundLock, withTimeout } from "../lock.js";
```

- [ ] **Step 2: Replace the cron callback**

Replace the `cron.schedule("* * * * *", async () => { ... });` block (lines 90-184) with:

```typescript
  let isProcessing = false;

  cron.schedule("* * * * *", async () => {
    if (isProcessing) {
      await log("Previous tick still processing, skipping");
      return;
    }
    isProcessing = true;

    try {
      const names = await listFundNames();
      const now = new Date();
      await updateHeartbeat(names.length);

      await Promise.allSettled(names.map(async (name) => {
        try {
          const config = await loadFundConfig(name);
          if (config.fund.status !== "active") return;

          const tz = config.schedule.timezone || "UTC";
          const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            hour: "2-digit",
            minute: "2-digit",
            weekday: "short",
            hour12: false,
          }).formatToParts(now);
          const currentTime = `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
          const days: Record<string, string> = { Sun: "SUN", Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT" };
          const currentDay = days[parts.find((p) => p.type === "weekday")!.value] ?? "SUN";

          if (!config.schedule.trading_days.includes(currentDay as never)) return;

          // -- Scheduled sessions --
          for (const [sessionType, session] of Object.entries(config.schedule.sessions)) {
            if (!session.enabled || session.time !== currentTime) continue;

            if (!(await acquireFundLock(name, sessionType))) {
              await log(`Skipping ${sessionType} for '${name}': another operation is running`);
              await notifyDaemonEvent("Session lock conflict", `Skipped ${sessionType} for '${name}'`);
              continue;
            }
            try {
              await log(`Running ${sessionType} for '${name}'...`);
              const timeoutMs = (session.max_duration_minutes ?? 20) * 60 * 1000;
              await withTimeout(runFundSession(name, sessionType), timeoutMs);
              clearError(name, "session");
            } catch (err) {
              await trackError(name, "session", err);
            } finally {
              await releaseFundLock(name);
            }
          }

          // -- Special sessions --
          const specialMatches = checkSpecialSessions(config);
          for (const special of specialMatches) {
            if (special.time !== currentTime) continue;
            const specialType = `special_${special.trigger.replace(/\s+/g, "_").toLowerCase()}`;

            if (!(await acquireFundLock(name, specialType))) {
              await log(`Skipping special session for '${name}': another operation is running`);
              continue;
            }
            try {
              await log(`Running special session for '${name}': ${special.trigger}...`);
              await withTimeout(runFundSession(name, specialType, { focus: special.focus }), 20 * 60 * 1000);
            } catch (err) {
              await trackError(name, "special_session", err);
            } finally {
              await releaseFundLock(name);
            }
          }

          // -- Reports --
          if (currentTime === DAILY_REPORT_TIME) {
            generateDailyReport(name).catch(async (err) => {
              await log(`Daily report error (${name}): ${err}`);
            });
          }
          if (currentDay === "FRI" && currentTime === WEEKLY_REPORT_TIME) {
            generateWeeklyReport(name).catch(async (err) => {
              await log(`Weekly report error (${name}): ${err}`);
            });
          }
          const dayOfMonth = parseInt(
            new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(now),
            10,
          );
          if (dayOfMonth === 1 && currentTime === MONTHLY_REPORT_TIME) {
            generateMonthlyReport(name).catch(async (err) => {
              await log(`Monthly report error (${name}): ${err}`);
            });
          }

          // -- Portfolio sync (independent schedule) --
          if (currentTime === PORTFOLIO_SYNC_TIME) {
            if (await acquireFundLock(name, "sync")) {
              try {
                await syncPortfolio(name);
                clearError(name, "sync");
              } catch (err) {
                await trackError(name, "sync", err);
              } finally {
                await releaseFundLock(name);
              }
            }
          }

          // -- Stop-loss checks (independent schedule: every 5 min during market hours) --
          const hour = parseInt(parts.find((p) => p.type === "hour")!.value, 10);
          const minute = parseInt(parts.find((p) => p.type === "minute")!.value, 10);
          const duringMarket =
            (hour > MARKET_OPEN_HOUR || (hour === MARKET_OPEN_HOUR && minute >= MARKET_OPEN_MINUTE)) &&
            hour < MARKET_CLOSE_HOUR;

          if (duringMarket && minute % STOPLOSS_CHECK_INTERVAL_MINUTES === 0) {
            if (await acquireFundLock(name, "stoploss")) {
              try {
                const triggered = await checkStopLosses(name);
                if (triggered.length > 0) {
                  await log(`Stop-loss triggered for '${name}': ${triggered.map((t) => t.symbol).join(", ")}`);
                  await executeStopLosses(name, triggered);
                }
                clearError(name, "stoploss");
              } catch (err) {
                await trackError(name, "stoploss", err);
                await notifyDaemonEvent("Stop-loss failure", `Check failed for '${name}': ${err}`);
              } finally {
                await releaseFundLock(name);
              }
            }
          }
        } catch (err) {
          await log(`Error checking fund '${name}': ${err}`);
        }
      }));
    } catch (err) {
      await log(`Cron tick error: ${err}`);
    } finally {
      isProcessing = false;
    }
  });
```

- [ ] **Step 3: Remove `forkDaemon()` from daemon.service.ts**

Delete the `forkDaemon()` function (lines 47-55 originally). It will be replaced by `forkSupervisor()` in the supervisor module.

- [ ] **Step 4: Update daemon integration tests**

The existing tests in `tests/daemon-integration.test.ts` capture the cron callback via `capturedCronCallback`. The new code still registers a `* * * * *` callback so the capture still works. However, we need to:

1. Add mock for `../src/lock.js`:

```typescript
vi.mock("../src/lock.js", () => ({
  acquireFundLock: vi.fn().mockResolvedValue(true),
  releaseFundLock: vi.fn().mockResolvedValue(undefined),
  withTimeout: vi.fn((promise: Promise<unknown>) => promise),
}));
```

2. Add `readSessionHistory` and `writeSessionHistory` to the existing `../src/state.js` mock:

```typescript
vi.mock("../src/state.js", () => ({
  readPortfolio: vi.fn().mockResolvedValue({
    last_updated: "2026-01-01",
    cash: 50000,
    total_value: 50000,
    positions: [],
  }),
  writePortfolio: vi.fn().mockResolvedValue(undefined),
  readSessionHistory: vi.fn().mockResolvedValue({}),
  writeSessionHistory: vi.fn().mockResolvedValue(undefined),
}));
```

3. Import lock mocks for assertions:

```typescript
import { acquireFundLock, releaseFundLock } from "../src/lock.js";
```

- [ ] **Step 5: Run tests**

Run: `pnpm test -- tests/daemon-integration.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/daemon.service.ts tests/daemon-integration.test.ts
git commit -m "feat(resilience): refactor cron loop with backpressure, fund locks, and async safety"
```

---

## Task 8: Daemon — Missed Session Catch-up

**Files:**
- Modify: `src/services/daemon.service.ts`

- [ ] **Step 1: Add catch-up import**

Add to daemon imports:

```typescript
import { readSessionHistory } from "../state.js";
```

- [ ] **Step 2: Add `checkMissedSessions()` function**

Add before `startDaemon()`:

```typescript
const CATCHUP_TOLERANCE_MS = 60 * 60 * 1000; // 60 minutes

async function checkMissedSessions(): Promise<void> {
  const names = await listFundNames();
  const now = new Date();
  const missedSummary: string[] = [];
  const catchupTasks: Array<{ fund: string; sessionType: string; scheduledTime: string }> = [];

  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      if (config.fund.status !== "active") continue;

      const history = await readSessionHistory(name);
      const tz = config.schedule.timezone || "UTC";
      const missed: string[] = [];
      let mostRecent: { type: string; scheduledAt: Date } | null = null;

      for (const [sessionType, session] of Object.entries(config.schedule.sessions)) {
        if (!session.enabled) continue;
        const lastRun = history[sessionType];
        if (!lastRun) {
          missed.push(sessionType);
          continue;
        }

        // Calculate when this session should have last run (today at session.time in fund tz)
        const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now); // YYYY-MM-DD
        const scheduledAt = new Date(`${todayStr}T${session.time}:00`);

        // Adjust for timezone
        const tzOffset = getTimezoneOffsetMs(tz, scheduledAt);
        const scheduledUtc = new Date(scheduledAt.getTime() - tzOffset);

        if (scheduledUtc < now && new Date(lastRun) < scheduledUtc) {
          missed.push(sessionType);
          if (!mostRecent || scheduledUtc > mostRecent.scheduledAt) {
            mostRecent = { type: sessionType, scheduledAt: scheduledUtc };
          }
        }
      }

      if (missed.length > 0) {
        missedSummary.push(`${name} (${missed.join(", ")})`);
      }

      // Only catch up the most recent missed session within tolerance
      if (mostRecent && now.getTime() - mostRecent.scheduledAt.getTime() < CATCHUP_TOLERANCE_MS) {
        catchupTasks.push({
          fund: name,
          sessionType: mostRecent.type,
          scheduledTime: mostRecent.scheduledAt.toISOString(),
        });
      }
    } catch (err) {
      await log(`Catch-up check error for '${name}': ${err}`);
    }
  }

  if (missedSummary.length > 0) {
    const catchupInfo = catchupTasks.map((t) => `${t.fund}/${t.sessionType}`).join(", ");
    const msg = `Missed sessions: ${missedSummary.join("; ")}. ${catchupTasks.length > 0 ? `Catching up: ${catchupInfo}` : "All outside tolerance window."}`;
    await log(msg);
    await notifyDaemonEvent("Daemon recovered", msg);
  } else {
    await log("No missed sessions detected.");
  }

  // Execute catch-up sessions
  for (const task of catchupTasks) {
    const catchupType = `catchup_${task.sessionType}`;
    if (!(await acquireFundLock(task.fund, catchupType))) {
      await log(`Catch-up skipped for '${task.fund}': fund is locked`);
      continue;
    }
    try {
      await log(`Catch-up: running missed ${task.sessionType} for '${task.fund}' (scheduled ${task.scheduledTime})`);
      await runFundSession(task.fund, catchupType, {
        focus: `CATCH-UP SESSION: This is a retroactive ${task.sessionType} session. The originally scheduled time was ${task.scheduledTime}. Adapt your analysis to the current market context.`,
      });
    } catch (err) {
      await log(`Catch-up error (${task.fund}/${catchupType}): ${err}`);
    } finally {
      await releaseFundLock(task.fund);
    }
  }
}

function getTimezoneOffsetMs(tz: string, date: Date): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: tz });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}
```

- [ ] **Step 3: Call `checkMissedSessions()` in `startDaemon()`**

Add after `await rotateLogIfNeeded();` and before the cron schedule:

```typescript
  // Check for missed sessions after crash/restart
  await checkMissedSessions();
```

- [ ] **Step 4: Add catch-up specific tests to `tests/daemon-integration.test.ts`**

Add a new describe block for catch-up testing. **Important:** The `makeFundConfig` helper must be hoisted to the file's top-level scope (before all describe blocks) so it's accessible from both the existing "daemon cron callback" tests and this new block. Also add `sendTelegramNotification` to the gateway mock:

```typescript
// Add to the existing gateway mock:
vi.mock("../src/services/gateway.service.js", () => ({
  startGateway: vi.fn().mockResolvedValue(undefined),
  stopGateway: vi.fn().mockResolvedValue(undefined),
  sendTelegramNotification: vi.fn().mockResolvedValue(undefined),
}));

// Add stat to the fs/promises mock:
// stat: vi.fn().mockResolvedValue(null),
```

Then add the new describe block:

```typescript
import { readSessionHistory } from "../src/state.js";
import { runFundSession } from "../src/services/session.service.js";

describe("daemon catch-up on startup", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedCronCallback = null;
    capturedCronCallbacks.clear();
    exitSpy.mockImplementation((() => {}) as never);
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("does not run catch-up when session history is current", async () => {
    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
    vi.mocked(readSessionHistory).mockResolvedValue({
      pre_market: new Date().toISOString(), // ran just now
    });

    await startDaemon();
    expect(runFundSession).not.toHaveBeenCalledWith(
      "test-fund",
      expect.stringContaining("catchup"),
      expect.anything(),
    );
  });

  it("runs catch-up for most recent missed session within tolerance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T09:45:00Z")); // 45 min after pre_market
    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
    vi.mocked(readSessionHistory).mockResolvedValue({
      pre_market: "2026-02-22T09:00:00Z", // yesterday
    });

    await startDaemon();
    expect(runFundSession).toHaveBeenCalledWith(
      "test-fund",
      "catchup_pre_market",
      expect.objectContaining({ focus: expect.stringContaining("CATCH-UP") }),
    );
    vi.useRealTimers();
  });

  it("does NOT run catch-up when missed session is outside tolerance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T12:00:00Z")); // 3 hours after pre_market
    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
    vi.mocked(readSessionHistory).mockResolvedValue({
      pre_market: "2026-02-22T09:00:00Z",
    });

    await startDaemon();
    expect(runFundSession).not.toHaveBeenCalledWith(
      "test-fund",
      expect.stringContaining("catchup"),
      expect.anything(),
    );
    vi.useRealTimers();
  });

  it("handles fund with no session history (first run)", async () => {
    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
    vi.mocked(readSessionHistory).mockResolvedValue({});

    // Should not crash, should note missed sessions but not catch up (no lastRun)
    await expect(startDaemon()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm test -- tests/daemon-integration.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/daemon.service.ts tests/daemon-integration.test.ts
git commit -m "feat(resilience): add missed session catch-up on daemon startup"
```

---

## Task 9: Consolidate getDaemonStatus

**Files:**
- Modify: `src/services/status.service.ts:11,94-100`
- Modify: `src/services/chat.service.ts:22,161-167`

- [ ] **Step 1: Update `status.service.ts`**

Replace the local `getDaemonStatus()` function with an import from `daemon.service.ts`:

Add to imports:
```typescript
import { isDaemonRunning, getDaemonPid } from "./daemon.service.js";
```

Replace the local `getDaemonStatus()`:
```typescript
async function getDaemonStatus(): Promise<{ running: boolean; pid?: number }> {
  const running = await isDaemonRunning();
  const pid = running ? (await getDaemonPid()) ?? undefined : undefined;
  return { running, pid };
}
```

Remove the `DAEMON_PID` import if it's no longer used elsewhere in the file.

- [ ] **Step 2: Update `chat.service.ts`**

Same pattern -- replace the local `getDaemonStatus()` with an import from `daemon.service.ts`:

Add to imports:
```typescript
import { isDaemonRunning, getDaemonPid } from "./daemon.service.js";
```

Replace the local `getDaemonStatus()`:
```typescript
export async function getDaemonStatus(): Promise<{ running: boolean; pid?: number }> {
  const running = await isDaemonRunning();
  const pid = running ? (await getDaemonPid()) ?? undefined : undefined;
  return { running, pid };
}
```

Remove the `DAEMON_PID` import if it's no longer used elsewhere in the file.

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/status.service.ts src/services/chat.service.ts
git commit -m "refactor(resilience): consolidate getDaemonStatus to use robust isDaemonRunning"
```

---

## Task 10: Supervisor Service

**Files:**
- Create: `src/services/supervisor.service.ts`
- Test: `tests/supervisor.test.ts`

- [ ] **Step 1: Write tests for supervisor**

Create `tests/supervisor.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("node:child_process", () => ({
  fork: vi.fn().mockReturnValue({
    pid: 12345,
    on: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
  }),
  spawn: vi.fn().mockReturnValue({
    pid: 99999,
    unref: vi.fn(),
  }),
}));

vi.mock("../src/services/daemon.service.js", () => ({
  isDaemonRunning: vi.fn().mockResolvedValue(false),
  notifyDaemonEvent: vi.fn().mockResolvedValue(undefined),
}));

import { getBackoffDelay, shouldGiveUp } from "../src/services/supervisor.service.js";

describe("supervisor", () => {
  it("calculates exponential backoff", () => {
    expect(getBackoffDelay(0)).toBe(2000);
    expect(getBackoffDelay(1)).toBe(4000);
    expect(getBackoffDelay(2)).toBe(8000);
    expect(getBackoffDelay(3)).toBe(16000);
    expect(getBackoffDelay(4)).toBe(32000);
  });

  it("gives up after 5 restarts in 10 minutes", () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 5 }, (_, i) => now - (5 - i) * 60 * 1000);
    expect(shouldGiveUp(timestamps, now)).toBe(true);
  });

  it("does not give up with fewer than 5 restarts", () => {
    const now = Date.now();
    const timestamps = [now - 60000, now - 30000];
    expect(shouldGiveUp(timestamps, now)).toBe(false);
  });

  it("does not give up when restarts are spread over > 10 minutes", () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 5 }, (_, i) => now - (20 - i * 3) * 60 * 1000);
    expect(shouldGiveUp(timestamps, now)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/supervisor.test.ts`
Expected: FAIL -- module not found

- [ ] **Step 3: Implement `src/services/supervisor.service.ts`**

**Note:** The supervisor calls `notifyDaemonEvent` from `daemon.service.ts`, which uses `sendTelegramNotification` from `gateway.service.ts`. That function creates an ad-hoc API call using the bot token from global config — it does NOT require a running gateway bot instance. Verify `sendTelegramNotification` works standalone (it does: it reads config and calls the Telegram API directly).

```typescript
import { fork, spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { SUPERVISOR_PID } from "../paths.js";

const MAX_RESTARTS = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/** Calculate exponential backoff delay for restart attempt N */
export function getBackoffDelay(attempt: number): number {
  return Math.min(2000 * Math.pow(2, attempt), 32000);
}

/** Check if we should give up restarting (5 failures in 10 min window) */
export function shouldGiveUp(restartTimestamps: number[], now: number): boolean {
  const recent = restartTimestamps.filter((t) => now - t < WINDOW_MS);
  return recent.length >= MAX_RESTARTS;
}

/**
 * Start the supervisor process (blocking -- runs until stopped).
 * Forks the daemon as a child and restarts it on crash.
 */
export async function startSupervisor(): Promise<void> {
  await writeFile(SUPERVISOR_PID, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf-8");

  const restartTimestamps: number[] = [];
  let attempt = 0;
  let stopping = false;
  let currentChild: ReturnType<typeof fork> | null = null;

  // Signal handlers registered ONCE at supervisor scope (not per-launch)
  async function handleShutdown() {
    stopping = true;
    if (currentChild) currentChild.kill("SIGTERM");
    setTimeout(async () => {
      await unlink(SUPERVISOR_PID).catch(() => {});
      process.exit(0);
    }, 5000);
  }
  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);

  function launchDaemon() {
    const child = fork(process.argv[1]!, ["--_daemon-mode"], {
      stdio: "inherit",
    });
    currentChild = child;

    child.on("exit", async (code) => {
      if (stopping) return;
      currentChild = null;

      const now = Date.now();
      restartTimestamps.push(now);

      if (shouldGiveUp(restartTimestamps, now)) {
        try {
          const { notifyDaemonEvent } = await import("./daemon.service.js");
          await notifyDaemonEvent("Max restarts exceeded", `Daemon crashed ${MAX_RESTARTS} times in 10 min. Giving up. Manual restart needed.`);
        } catch { /* best effort */ }
        await unlink(SUPERVISOR_PID).catch(() => {});
        process.exit(1);
      }

      const delay = getBackoffDelay(attempt);
      attempt++;

      try {
        const { notifyDaemonEvent } = await import("./daemon.service.js");
        await notifyDaemonEvent("Daemon crashed", `Exit code ${code}. Restarting in ${delay / 1000}s (attempt ${attempt}/${MAX_RESTARTS})`);
      } catch { /* best effort */ }

      setTimeout(() => {
        launchDaemon();
      }, delay);
    });

    // Reset attempt counter on successful run (child alive for > 60s)
    setTimeout(() => {
      if (!stopping) attempt = 0;
    }, 60000);
  }

  launchDaemon();
}

/**
 * Fork a detached supervisor process (non-blocking -- returns immediately).
 * Used by `fundx start` and the dashboard.
 */
export async function forkSupervisor(): Promise<void> {
  if (existsSync(SUPERVISOR_PID)) {
    try {
      const raw = JSON.parse(await readFile(SUPERVISOR_PID, "utf-8"));
      process.kill(raw.pid, 0);
      return; // Already running
    } catch {
      await unlink(SUPERVISOR_PID).catch(() => {});
    }
  }

  const { isDaemonRunning } = await import("./daemon.service.js");
  if (await isDaemonRunning()) return; // Daemon running without supervisor (legacy)

  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, "--_supervisor-mode"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- tests/supervisor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/supervisor.service.ts tests/supervisor.test.ts
git commit -m "feat(resilience): add supervisor process with exponential backoff restart"
```

---

## Task 11: Entry Points (index.tsx, start.tsx, stop.tsx, commands/index.tsx)

**Files:**
- Modify: `src/index.tsx`
- Modify: `src/commands/start.tsx`
- Modify: `src/commands/stop.tsx`
- Modify: `src/commands/index.tsx`

- [ ] **Step 1: Update `src/index.tsx` with supervisor mode**

Replace contents:

```typescript
#!/usr/bin/env node

// Internal supervisor runner mode -- spawned as a detached background process by forkSupervisor()
if (process.argv.includes("--_supervisor-mode")) {
  const { startSupervisor } = await import("./services/supervisor.service.js");
  await startSupervisor();
// Internal daemon runner mode -- spawned by supervisor via fork()
} else if (process.argv.includes("--_daemon-mode")) {
  const { startDaemon } = await import("./services/daemon.service.js");
  await startDaemon();
} else {
  const { default: Pastel } = await import("pastel");
  const app = new Pastel({
    importMeta: import.meta,
    name: "fundx",
    version: "0.1.0",
    description: "FundX -- Autonomous AI Fund Manager powered by the Claude Agent SDK",
  });
  await app.run();
}
```

- [ ] **Step 2: Update `src/commands/start.tsx`**

Replace the import:

```typescript
// Old:
import { startDaemon } from "../services/daemon.service.js";
// New:
import { forkSupervisor } from "../services/supervisor.service.js";
```

Replace the `startDaemon()` call with `forkSupervisor()` and update success message:

```typescript
await forkSupervisor();
```

```typescript
return <Text color="green">Daemon started (via supervisor).</Text>;
```

- [ ] **Step 3: Update `src/commands/stop.tsx`**

Replace the import:

```typescript
// Old:
import { stopDaemon } from "../services/daemon.service.js";
// New:
import { stopSupervisor } from "../services/daemon.service.js";
```

Replace the `stopDaemon()` call with `stopSupervisor()`.

- [ ] **Step 4: Update `src/commands/index.tsx` -- replace `forkDaemon` with `forkSupervisor`**

Find the import of `forkDaemon` and replace:

```typescript
// Old:
import { forkDaemon } from "../services/daemon.service.js";
// New:
import { forkSupervisor } from "../services/supervisor.service.js";
```

Find all calls to `forkDaemon()` and replace with `forkSupervisor()`.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/index.tsx src/commands/start.tsx src/commands/stop.tsx src/commands/index.tsx
git commit -m "feat(resilience): wire supervisor into CLI entry points"
```

---

## Task 12: Final Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 4: Manual smoke test**

```bash
pnpm dev -- start
# Verify: supervisor PID file created at ~/.fundx/supervisor.pid
# Verify: daemon PID file created at ~/.fundx/daemon.pid (JSON format)
# Verify: heartbeat file at ~/.fundx/daemon.heartbeat
cat ~/.fundx/supervisor.pid
cat ~/.fundx/daemon.pid
cat ~/.fundx/daemon.heartbeat

pnpm dev -- status
# Verify: daemon shows as running

pnpm dev -- stop
# Verify: both PID files cleaned up
```

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(resilience): integration test fixes"
```
