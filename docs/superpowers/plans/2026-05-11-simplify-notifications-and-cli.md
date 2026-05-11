# Simplify Notifications and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Telegram entirely, replace with OS-native notifications for 5 critical events, and cut CLI from ~50 commands to 13.

**Architecture:** New `notify.service.ts` becomes the single fanout point using `node-notifier`. The agent stops emitting notifications — daemon/services observe events and emit. A journal watcher in the daemon detects new trades and surfaces them. Schema migrates with `.strip()` so legacy config keys are silently dropped.

**Tech Stack:** TypeScript (Node 20+), Zod, Vitest, tsup, node-notifier.

**Reference spec:** `docs/superpowers/specs/2026-05-11-simplify-notifications-and-cli-design.md`

---

## Phase A — New notify.service (TDD, additive only)

### Task A1: Add node-notifier dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install node-notifier and types**

Run:
```
pnpm add node-notifier
pnpm add -D @types/node-notifier
```
Expected: `node-notifier` appears under `dependencies` in package.json; `@types/node-notifier` under `devDependencies`.

- [ ] **Step 2: Commit**

```
git add package.json pnpm-lock.yaml
git commit -m "feat(notify): add node-notifier dependency"
```

---

### Task A2: Write failing test for notify.service

**Files:**
- Create: `tests/notify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node-notifier", () => ({
  default: { notify: vi.fn() },
}));

import notifier from "node-notifier";
import {
  notifyTrade,
  notifyStopLoss,
  notifyDailyCap,
  notifySupervisorStale,
  notifyHandoffMissing,
  __setQuietHoursForTest,
} from "../src/services/notify.service.js";

const notifySpy = notifier.notify as unknown as ReturnType<typeof vi.fn>;

describe("notify.service", () => {
  beforeEach(() => {
    notifySpy.mockReset();
    __setQuietHoursForTest(null);
  });

  it("notifyTrade emits an OS notification with fund/side/qty/price", () => {
    notifyTrade("alpha", "buy", "AAPL", 10, 180.5);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    const call = notifySpy.mock.calls[0][0];
    expect(call.title).toMatch(/alpha/i);
    expect(call.message).toMatch(/AAPL/);
    expect(call.message).toMatch(/10/);
    expect(call.message).toMatch(/180\.5/);
  });

  it("notifyStopLoss bypasses quiet hours (priority=high)", () => {
    __setQuietHoursForTest({ now: "23:30", start: "22:00", end: "07:00" });
    notifyStopLoss("alpha", "AAPL", 175.0, "sold 10 @ 174.50");
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("notifyDailyCap is suppressed inside quiet hours", () => {
    __setQuietHoursForTest({ now: "23:30", start: "22:00", end: "07:00" });
    notifyDailyCap("alpha", 20, 21.5);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("notifySupervisorStale bypasses quiet hours", () => {
    __setQuietHoursForTest({ now: "01:00", start: "22:00", end: "07:00" });
    notifySupervisorStale("alpha", new Date("2026-05-11T00:00:00Z"));
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("notifyHandoffMissing emits with session-type detail", () => {
    notifyHandoffMissing("alpha", "pre_market");
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0].message).toMatch(/pre_market/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/notify.test.ts`
Expected: FAIL with "Cannot find module ../src/services/notify.service.js" (or similar).

---

### Task A3: Implement notify.service

**Files:**
- Create: `src/services/notify.service.ts`

- [ ] **Step 1: Write the minimal implementation**

```ts
import notifier from "node-notifier";
import { loadGlobalConfig } from "../config.js";

export type NotifyPriority = "normal" | "high";

interface QuietHoursOverride {
  now: string;
  start: string;
  end: string;
}

let testOverride: QuietHoursOverride | null = null;

export function __setQuietHoursForTest(override: QuietHoursOverride | null): void {
  testOverride = override;
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function inQuietHours(now: string, start: string, end: string): boolean {
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

async function shouldSuppress(priority: NotifyPriority): Promise<boolean> {
  if (priority === "high") return false;
  if (testOverride) {
    return inQuietHours(testOverride.now, testOverride.start, testOverride.end);
  }
  try {
    const cfg = await loadGlobalConfig();
    const qh = cfg.notifications?.quiet_hours;
    if (!qh || !qh.enabled) return false;
    return inQuietHours(nowHHMM(), qh.start, qh.end);
  } catch {
    return false;
  }
}

function emit(title: string, message: string, priority: NotifyPriority): void {
  void (async () => {
    if (await shouldSuppress(priority)) return;
    notifier.notify({
      title,
      message,
      sound: priority === "high",
      timeout: priority === "high" ? 15 : 8,
    });
  })();
}

export function notifyTrade(
  fund: string,
  side: "buy" | "sell",
  ticker: string,
  qty: number,
  price: number,
): void {
  emit(
    `FundX · ${fund}`,
    `${side.toUpperCase()} ${qty} ${ticker} @ $${price.toFixed(2)}`,
    "normal",
  );
}

export function notifyStopLoss(
  fund: string,
  ticker: string,
  trigger: number,
  action: string,
): void {
  emit(
    `FundX · ${fund} · STOP-LOSS`,
    `${ticker} @ $${trigger.toFixed(2)} — ${action}`,
    "high",
  );
}

export function notifyDailyCap(fund: string, capUsd: number, spentUsd: number): void {
  emit(
    `FundX · ${fund} · daily cap`,
    `Spent $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} cap — sessions paused until 00:00 UTC.`,
    "normal",
  );
}

export function notifySupervisorStale(fund: string, lastHeartbeatAt: Date): void {
  const minutes = Math.round((Date.now() - lastHeartbeatAt.getTime()) / 60000);
  emit(
    `FundX · ${fund} · supervisor stale`,
    `No heartbeat for ${minutes} min. Daemon may be stuck.`,
    "high",
  );
}

export function notifyHandoffMissing(fund: string, sessionType: string): void {
  emit(
    `FundX · ${fund} · handoff missing`,
    `Session ${sessionType} reported success but did not write a fresh handoff.`,
    "normal",
  );
}

export function notifyGeneric(title: string, message: string): void {
  emit(`FundX · ${title}`, message, "normal");
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run tests/notify.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

```
git add src/services/notify.service.ts tests/notify.test.ts
git commit -m "feat(notify): add notify.service with quiet-hours and 5 event types"
```

---

### Task A4: Verify notifications config schema supports new shape

**Files:**
- Modify: `src/types.ts` if needed

- [ ] **Step 1: Verify quiet_hours is already in the schema**

Run: `rg -n "quiet_hours" src/types.ts`
Expected: shows `enabled`, `start`, `end` keys present inside the existing `notifications` block.

No changes required — the schema rewrite happens in Task C3 (after Telegram fields are removed).

---

## Phase B — Wire notify.service to existing call sites (Telegram still alive)

This phase wires the new module behind the existing fanout functions so OS notifications fire **in addition to** Telegram. This lets us verify the new path works before deleting anything.

### Task B1: Make notifyDaemonEvent emit OS notifications

**Files:**
- Modify: `src/services/daemon.service.ts:405-420`

- [ ] **Step 1: Patch notifyDaemonEvent body**

Replace the current body of `notifyDaemonEvent` (lines 405–420) with:

```ts
export async function notifyDaemonEvent(event: string, details: string): Promise<void> {
  const now = Date.now();
  const lastSent = lastAlertByType.get(event) ?? 0;
  if (now - lastSent < ALERT_DEDUP_MS) return;

  lastAlertByType.set(event, now);
  await log(`[ALERT] ${event}: ${details}`);

  try {
    const { notifySupervisorStale, notifyDailyCap, notifyHandoffMissing, notifyGeneric } =
      await import("./notify.service.js");
    const lower = event.toLowerCase();
    if (lower.includes("stale") || lower.includes("supervisor")) {
      notifySupervisorStale(extractFund(event) ?? "daemon", new Date());
    } else if (lower.includes("daily cap")) {
      notifyDailyCap(extractFund(event) ?? "daemon", 0, 0);
    } else if (lower.includes("handoff")) {
      notifyHandoffMissing(extractFund(event) ?? "daemon", "unknown");
    } else {
      notifyGeneric(event, details);
    }
  } catch (err) {
    await log(`[ALERT] notify.service failed: ${err}`);
  }

  try {
    const { sendTelegramNotification } = await import("./gateway.service.js");
    await sendTelegramNotification(`<b>[Daemon]</b> ${event}\n${details}`);
  } catch {
    // Telegram not available — already logged
  }
}

function extractFund(event: string): string | null {
  const m = event.match(/[:\s]([a-z0-9-]+)\b/i);
  return m ? m[1] : null;
}
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run tests/notify.test.ts`
Expected: PASS (still 5 tests).

- [ ] **Step 3: Commit**

```
git add src/services/daemon.service.ts
git commit -m "feat(notify): wire notifyDaemonEvent to OS notifications (legacy Telegram kept)"
```

---

### Task B2: Make notifySession emit OS notifications

**Files:**
- Modify: `src/services/session.service.ts:265-275`

- [ ] **Step 1: Patch notifySession**

Find the current `notifySession` function (around line 265). Replace its body with:

```ts
async function notifySession(message: string): Promise<void> {
  try {
    const { notifyGeneric } = await import("./notify.service.js");
    notifyGeneric("session", message.replace(/<[^>]+>/g, ""));
  } catch { /* best-effort */ }

  try {
    const { sendTelegramNotification } = await import("./gateway.service.js");
    await sendTelegramNotification(message);
  } catch { /* best-effort */ }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add src/services/session.service.ts
git commit -m "feat(notify): wire notifySession to OS notifications"
```

---

### Task B3: Add stop-loss OS notification

**Files:**
- Modify: `src/stoploss.ts`

- [ ] **Step 1: Locate the stop-loss execution site**

Run: `rg -n "stop_loss|stopLoss" src/stoploss.ts | head -20`

- [ ] **Step 2: Add notifyStopLoss after a successful stop-loss fill**

At the top of `src/stoploss.ts`, add:
```ts
import { notifyStopLoss } from "./services/notify.service.js";
```

Then, immediately after the journal insert for a stop-loss fill (the place where the sell completes successfully), add:

```ts
notifyStopLoss(fundName, symbol, triggerPrice, `sold ${qty} @ $${execPrice.toFixed(2)}`);
```

Use whatever variable names actually exist for fund, symbol, trigger, qty, and exec price at that point. If the trigger price is stored on the position rather than passed locally, read it from the position record before emitting.

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run`
Expected: All tests pass (notify is best-effort and mocked in tests).

- [ ] **Step 4: Commit**

```
git add src/stoploss.ts
git commit -m "feat(notify): emit OS notification on stop-loss execution"
```

---

### Task B4: Add trade-execution journal watcher in the daemon

**Files:**
- Create: `src/services/trade-watcher.service.ts`
- Create: `tests/trade-watcher.test.ts`
- Modify: `src/services/daemon.service.ts` — register watcher in `startDaemon`

- [ ] **Step 1: Write failing test**

Create `tests/trade-watcher.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

vi.mock("../src/services/notify.service.js", () => ({
  notifyTrade: vi.fn(),
}));

import { notifyTrade } from "../src/services/notify.service.js";
import {
  tickTradeWatcher,
  __resetWatcherStateForTest,
} from "../src/services/trade-watcher.service.js";

describe("trade-watcher", () => {
  let dir: string;
  let journalPath: string;
  let cursorPath: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fundx-watcher-"));
    journalPath = path.join(dir, "trade_journal.sqlite");
    cursorPath = path.join(dir, "last_notify_cursor.json");
    db = new Database(journalPath);
    db.exec(`
      CREATE TABLE trades (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        fund TEXT,
        symbol TEXT,
        side TEXT,
        quantity REAL,
        price REAL,
        order_type TEXT
      );
    `);
    __resetWatcherStateForTest();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("emits a notification for a new trade row", async () => {
    db.prepare(
      `INSERT INTO trades (timestamp, fund, symbol, side, quantity, price, order_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("2026-05-11T10:00:00Z", "alpha", "AAPL", "buy", 10, 180.5, "market");

    await tickTradeWatcher("alpha", journalPath, cursorPath);
    expect(notifyTrade).toHaveBeenCalledTimes(1);
    expect(notifyTrade).toHaveBeenCalledWith("alpha", "buy", "AAPL", 10, 180.5);
  });

  it("does not re-notify the same trade after restart", async () => {
    db.prepare(
      `INSERT INTO trades (timestamp, fund, symbol, side, quantity, price, order_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("2026-05-11T10:00:00Z", "alpha", "AAPL", "buy", 10, 180.5, "market");

    await tickTradeWatcher("alpha", journalPath, cursorPath);
    __resetWatcherStateForTest();
    await tickTradeWatcher("alpha", journalPath, cursorPath);
    expect(notifyTrade).toHaveBeenCalledTimes(1);
  });

  it("skips stop_loss order_types (handled by stoploss.ts)", async () => {
    db.prepare(
      `INSERT INTO trades (timestamp, fund, symbol, side, quantity, price, order_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("2026-05-11T10:00:00Z", "alpha", "AAPL", "sell", 10, 175.0, "stop");

    await tickTradeWatcher("alpha", journalPath, cursorPath);
    expect(notifyTrade).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

Run: `pnpm vitest run tests/trade-watcher.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement trade-watcher.service**

Create `src/services/trade-watcher.service.ts`:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { notifyTrade } from "./notify.service.js";

interface CursorState {
  last_trade_id: number;
}

const inMemoryCursor = new Map<string, number>();

export function __resetWatcherStateForTest(): void {
  inMemoryCursor.clear();
}

async function loadCursor(cursorPath: string, fund: string): Promise<number> {
  if (inMemoryCursor.has(fund)) return inMemoryCursor.get(fund)!;
  if (!existsSync(cursorPath)) return 0;
  try {
    const raw = await readFile(cursorPath, "utf8");
    const parsed = JSON.parse(raw) as CursorState;
    inMemoryCursor.set(fund, parsed.last_trade_id ?? 0);
    return parsed.last_trade_id ?? 0;
  } catch {
    return 0;
  }
}

async function saveCursor(cursorPath: string, fund: string, lastId: number): Promise<void> {
  inMemoryCursor.set(fund, lastId);
  const state: CursorState = { last_trade_id: lastId };
  await writeFile(cursorPath, JSON.stringify(state), "utf8");
}

export async function tickTradeWatcher(
  fund: string,
  journalPath: string,
  cursorPath: string,
): Promise<void> {
  if (!existsSync(journalPath)) return;
  const cursor = await loadCursor(cursorPath, fund);
  const db = new Database(journalPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, fund, symbol, side, quantity, price, order_type
         FROM trades WHERE id > ? ORDER BY id ASC`,
      )
      .all(cursor) as Array<{
        id: number;
        fund: string;
        symbol: string;
        side: "buy" | "sell";
        quantity: number;
        price: number;
        order_type: string;
      }>;

    let maxId = cursor;
    for (const r of rows) {
      const isStop = r.order_type === "stop" || r.order_type === "stop_limit" || r.order_type === "trailing_stop";
      if (!isStop) {
        notifyTrade(fund, r.side, r.symbol, r.quantity, r.price);
      }
      maxId = Math.max(maxId, r.id);
    }

    if (maxId > cursor) {
      await saveCursor(cursorPath, fund, maxId);
    }
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm vitest run tests/trade-watcher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the watcher into the daemon tick**

Open `src/services/daemon.service.ts`. Find the function that starts the daemon (search for `startDaemon` or the cron scheduler init). Add at the top of the file:

```ts
import { tickTradeWatcher } from "./trade-watcher.service.js";
import { listFundNames } from "./fund.service.js";
```

Then add a helper function:

```ts
async function tickAllWatchers(): Promise<void> {
  const names = await listFundNames();
  for (const name of names) {
    try {
      const { fundJournalPath, fundStatePath } = await import("../paths.js");
      const journal = fundJournalPath(name);
      const cursor = `${fundStatePath(name)}/last_notify_cursor.json`;
      await tickTradeWatcher(name, journal, cursor);
    } catch (err) {
      await log(`[trade-watcher] ${name} tick failed: ${err}`);
    }
  }
}
```

If `fundJournalPath` or `fundStatePath` don't exist as named exports, find the correct helpers in `src/paths.ts`:
```
rg -n "tradeJournal|journalPath|statePath|fundDir" src/paths.ts
```
and adapt the snippet to use whatever helpers `paths.ts` already exposes.

Inside `startDaemon`, after the existing scheduler setup, add:

```ts
const watcherInterval = setInterval(() => {
  void tickAllWatchers();
}, 5000);
```

Store `watcherInterval` and call `clearInterval(watcherInterval)` in the shutdown path next to other cleanups.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```
git add src/services/trade-watcher.service.ts tests/trade-watcher.test.ts src/services/daemon.service.ts
git commit -m "feat(notify): journal watcher emits OS notifications for new trades"
```

---

## Phase C — Remove Telegram code

At this point, OS notifications fire for trades, stop-loss, daily-cap, supervisor, handoff, and the generic daemon-event path. Telegram still fires in parallel. Now we delete Telegram.

### Task C1: Delete telegram-notify MCP and broker-local-notify

**Files:**
- Delete: `src/mcp/telegram-notify.ts`
- Delete: `src/mcp/broker-local-notify.ts`
- Delete: `tests/telegram-notify.test.ts`
- Modify: `src/mcp/broker-local.ts`
- Modify: `src/paths.ts:96`
- Modify: `src/agent.ts:120-180`
- Modify: `src/services/daemon.service.ts:29` (import) plus any callers of `isInQuietHoursEnv`

- [ ] **Step 1: Delete the files**

```
rm src/mcp/telegram-notify.ts src/mcp/broker-local-notify.ts tests/telegram-notify.test.ts
```

- [ ] **Step 2: Patch src/mcp/broker-local.ts**

Find the import line:
```ts
} from "./broker-local-notify.js";
```
Remove the entire import statement plus every call to symbols it provided. Also remove the env-var block around lines 352–353:
```ts
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
```
and any conditional branch that uses those tokens.

Verify with:
```
rg -in "telegram|broker-local-notify" src/mcp/broker-local.ts
```
Expected: no output.

- [ ] **Step 3: Patch src/paths.ts**

Delete the `telegramNotify` entry at line 96:
```ts
telegramNotify: join(__dirname, "mcp", IS_DEV ? "telegram-notify.ts" : "telegram-notify.js"),
```

- [ ] **Step 4: Patch src/agent.ts**

Delete lines 123–124:
```ts
brokerLocalEnv.TELEGRAM_BOT_TOKEN = globalConfig.telegram.bot_token;
brokerLocalEnv.TELEGRAM_CHAT_ID = globalConfig.telegram.chat_id;
```

Delete the entire conditional block around lines 150–180 that wires `telegram-notify` into the MCP servers map (the block starts with a comment like `// Conditionally add telegram-notify`).

- [ ] **Step 5: Patch src/services/daemon.service.ts**

Delete line 29:
```ts
import { isInQuietHoursEnv } from "../mcp/broker-local-notify.js";
```
Find any usage of `isInQuietHoursEnv` and remove it (`notify.service` handles quiet hours internally).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. If any remaining file imports symbols from the deleted modules, remove those imports and any dependent code.

- [ ] **Step 7: Commit**

```
git add -A
git commit -m "refactor(telegram): delete telegram-notify MCP and broker-local-notify"
```

---

### Task C2: Delete gateway.service and gateway commands

**Files:**
- Delete: `src/services/gateway.service.ts`
- Delete: `src/commands/gateway/`
- Delete: `tests/gateway-retry.test.ts`
- Modify: all files that import `sendTelegramNotification` from `./gateway.service.js`

- [ ] **Step 1: Find all callers**

```
rg -l "sendTelegramNotification|gateway.service" src/ tests/
```

- [ ] **Step 2: Remove the Telegram fallback in notifyDaemonEvent**

Open `src/services/daemon.service.ts`. In `notifyDaemonEvent` (patched in B1), remove the entire trailing try-block that imports `sendTelegramNotification`. Keep only the new OS notification block.

- [ ] **Step 3: Remove the Telegram fallback in notifySession**

Open `src/services/session.service.ts`. In `notifySession` (patched in B2), remove the trailing Telegram try-block. The function should now only call `notifyGeneric`.

- [ ] **Step 4: Remove Telegram fanout in news.service.ts (lines 588–591)**

Delete the entire block:
```ts
try {
  const { sendTelegramNotification } = await import("./gateway.service.js");
  await sendTelegramNotification(msg);
} catch { /* best effort */ }
```

The news_reaction session enqueue (lines 602+) stays — news still triggers sessions, just no longer notifies the user directly.

- [ ] **Step 5: Replace checkSwsTokenExpiry Telegram path (daemon.service.ts:445-465)**

Replace the body of `checkSwsTokenExpiry`:

```ts
async function checkSwsTokenExpiry(): Promise<void> {
  const config = await loadGlobalConfig();
  const expiresAt = config.sws?.token_expires_at;
  if (!expiresAt) return;

  const hoursLeft = (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60);
  const { notifyGeneric } = await import("./notify.service.js");

  if (hoursLeft <= 0) {
    notifyGeneric(
      "SWS token expired",
      "Simply Wall St data is disabled. Run `fundx sws login` to renew.",
    );
  } else if (hoursLeft <= 48) {
    notifyGeneric(
      "SWS token expiring",
      `Token expires in ${Math.round(hoursLeft)} hours. Run \`fundx sws login\` to renew.`,
    );
  }
}
```

- [ ] **Step 6: Delete files**

```
rm src/services/gateway.service.ts
rm -r src/commands/gateway
rm tests/gateway-retry.test.ts
```

- [ ] **Step 7: Remove gateway bootstrap from daemon**

In `src/services/daemon.service.ts`, find any reference to the gateway:
```
rg -n "gateway|startGateway" src/services/daemon.service.ts
```
Remove all matches.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. Fix any remaining unresolved imports.

- [ ] **Step 9: Commit**

```
git add -A
git commit -m "refactor(telegram): delete gateway.service and gateway commands"
```

---

### Task C3: Drop Telegram from types and serviceStatus

**Files:**
- Modify: `src/types.ts:202-224, 291-297, 409-422, 557-562`
- Modify: `src/services/status.service.ts:175, 264-269`
- Modify: `src/components/SystemStatusPanel.tsx`

- [ ] **Step 1: Replace the `notifications` schema in fundConfigSchema (lines 202–224)**

Replace:
```ts
notifications: z
  .object({
    telegram: z.object({...}).default({}),
    quiet_hours: z.object({...}).default({}),
  })
  .default({}),
```
with:
```ts
notifications: z
  .object({
    enabled: z.boolean().default(true),
    quiet_hours: z
      .object({
        enabled: z.boolean().default(true),
        start: z.string().default("23:00"),
        end: z.string().default("07:00"),
        allow_critical: z.boolean().default(true),
      })
      .default({}),
  })
  .default({}),
```

- [ ] **Step 2: Remove `telegram` from globalConfigSchema (lines 291–297)**

Delete the entire `telegram: z.object({...}).default({}),` block from `globalConfigSchema`.

- [ ] **Step 3: Switch global config and fund config to `.strip()`**

At the closing `})` of `globalConfigSchema`, append `.strip()`. Same for `fundConfigSchema`. If either schema already has another modifier (`.passthrough()`, `.strict()`), replace it with `.strip()`.

- [ ] **Step 4: Delete TelegramNotification schemas (lines 409–422)**

Delete the entire block:
```ts
// ── Telegram Notification Schemas ─────────────────────────────
export const notificationPrioritySchema = z.enum(["low", "normal", "critical"]);
export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;
export const telegramNotificationSchema = z.object({...});
export type TelegramNotification = z.infer<typeof telegramNotificationSchema>;
```

- [ ] **Step 5: Remove `telegram` from serviceStatusSchema (line 559)**

Delete the line:
```ts
telegram: z.boolean().default(false),
```

- [ ] **Step 6: Patch src/services/status.service.ts**

Find and delete the function/section that checks Telegram status (around line 175). Update the `Promise.all` block (lines 264–269) to:

```ts
const [daemon, marketStatus] = await Promise.all([
  isDaemonRunning(),
  checkMarketDataStatus(),
]);
return { daemon, marketData: marketStatus.ok, marketDataProvider: marketStatus.provider };
```

Remove any `telegram` property from the return type.

- [ ] **Step 7: Patch src/components/SystemStatusPanel.tsx**

Find references to telegram:
```
rg -n "elegram" src/components/SystemStatusPanel.tsx
```
Delete the JSX row that renders the Telegram status badge.

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. Fix any caller that still reads `status.telegram` or imports `TelegramNotification`.

- [ ] **Step 9: Commit**

```
git add -A
git commit -m "refactor(telegram): drop telegram from types, status, and panel"
```

---

## Phase D — CLI command cleanup

### Task D1: Delete read-view commands

**Files:**
- Delete:
  - `src/commands/ask.tsx`
  - `src/commands/portfolio.tsx`
  - `src/commands/trades.tsx`
  - `src/commands/performance.tsx`
  - `src/commands/logs.tsx`
  - `src/commands/correlation.tsx`
  - `src/commands/chart/`
  - `src/commands/news/`
  - `src/commands/screen/`
  - `src/commands/report/`
  - `src/commands/fund/list.tsx`
  - `src/commands/fund/info.tsx`
  - `src/commands/fund/clone.tsx`
  - `src/commands/fund/show-universe.tsx`

- [ ] **Step 1: Delete the files**

```
rm src/commands/ask.tsx \
   src/commands/portfolio.tsx \
   src/commands/trades.tsx \
   src/commands/performance.tsx \
   src/commands/logs.tsx \
   src/commands/correlation.tsx
rm -r src/commands/chart src/commands/news src/commands/screen src/commands/report
rm src/commands/fund/list.tsx \
   src/commands/fund/info.tsx \
   src/commands/fund/clone.tsx \
   src/commands/fund/show-universe.tsx
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. Pastel discovers commands via filesystem; deleted commands have no inbound imports.

- [ ] **Step 3: Commit**

```
git add -A
git commit -m "refactor(cli): remove read-view commands (chat REPL covers them)"
```

---

### Task D2: Delete generator and config commands

**Files:**
- Delete:
  - `src/commands/montecarlo/`
  - `src/commands/special/`
  - `src/commands/template/`

- [ ] **Step 1: Delete the files**

```
rm -r src/commands/montecarlo src/commands/special src/commands/template
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add -A
git commit -m "refactor(cli): remove generator and config commands"
```

---

### Task D3: Verify final CLI surface

- [ ] **Step 1: List remaining commands**

```
find src/commands -type f | sort
```

Expected output (15 files = 13 user-facing commands + `index.tsx` dashboard + `status.tsx`):
```
src/commands/eval.tsx
src/commands/fund/consolidate.tsx
src/commands/fund/create.tsx
src/commands/fund/delete.tsx
src/commands/fund/refresh-universe.tsx
src/commands/fund/upgrade.tsx
src/commands/index.tsx
src/commands/init.tsx
src/commands/session/run.tsx
src/commands/start.tsx
src/commands/status.tsx
src/commands/stop.tsx
src/commands/sws/login.tsx
src/commands/sws/logout.tsx
src/commands/sws/status.tsx
```

If any unexpected file remains, delete it and commit.

---

## Phase E — Prompts and documentation

### Task E1: Purge Telegram from src/skills.ts

**Files:**
- Modify: `src/skills.ts:1469, 1478, 1555`

- [ ] **Step 1: Patch the communication rule (line 1469)**

Replace:
```
Why: Persisted artifacts (analysis, journal, reports, autonomous Telegram alerts)
```
with:
```
Why: Persisted artifacts (analysis, journal, reports) and OS notifications
```

- [ ] **Step 2: Patch line 1478**

Replace:
```
- Telegram autonomous notifications (trade alerts, digests, milestones): English.
```
with:
```
- OS notifications (trades, stop-loss, supervisor alerts): emitted by the system; you do not call any notify tool.
```

- [ ] **Step 3: Patch line 1555**

Find the bullet:
```
- Telegram notification was sent
```
Replace with:
```
- Handoff is fresh (the system surfaces critical events via OS notifications)
```

- [ ] **Step 4: Verify**

Run: `rg -in "telegram" src/skills.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```
git add src/skills.ts
git commit -m "refactor(prompts): purge Telegram from fund rules and skills"
```

---

### Task E2: Purge Telegram from src/template.ts

**Files:**
- Modify: `src/template.ts:67, 181`

- [ ] **Step 1: Patch line 67**

Replace:
```
Mirror the user's language in chat replies. Autonomous Telegram alerts, analysis files, journal entries, and reports stay in English. See the communication rule for details.
```
with:
```
Mirror the user's language in chat replies. Analysis files, journal entries, and reports stay in English. See the communication rule for details.
```

- [ ] **Step 2: Patch line 181 (Communicate phase)**

Replace:
```
7. **Communicate** — Send a Telegram notification in English for any trade or significant insight (autonomous notifications stay English; chat replies follow the user's language — see communication rule).
```
with:
```
7. **Communicate** — Critical events (trade executions, stop-loss, daily cap, supervisor stalls, missing handoffs) are notified by the system automatically via the OS notification center. Your responsibility is leaving a complete handoff so context survives across sessions.
```

- [ ] **Step 3: Remove any MCP listing line for telegram-notify**

```
rg -n "telegram-notify|telegram_notify" src/template.ts
```
Delete every match. If the template enumerates fund MCPs, remove that line entirely.

- [ ] **Step 4: Verify**

Run: `rg -in "telegram" src/template.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```
git add src/template.ts
git commit -m "refactor(prompts): purge Telegram from per-fund CLAUDE.md template"
```

---

### Task E3: Update workspace CLAUDE.md and init wizard

**Files:**
- Modify: `src/services/init.service.ts`

- [ ] **Step 1: Find the Telegram wizard step**

```
rg -n "elegram" src/services/init.service.ts
```

- [ ] **Step 2: Remove the wizard step**

Delete the block that prompts for `bot_token` and `chat_id` and writes a `telegram: {...}` field to the global config. The init wizard's remaining prompts: workspace path confirmation, FMP API key (optional), default model, default budget, default quiet hours.

- [ ] **Step 3: Update the workspace CLAUDE.md template inside init.service.ts**

Locate the string that becomes `~/.fundx/CLAUDE.md`. Remove every mention of Telegram, the gateway, or `fundx gateway`. Update the CLI command catalog to list only the 13 final commands:

```
fundx init
fundx fund create <name>
fundx fund delete <name>
fundx fund upgrade [--all|--name <n>]
fundx fund consolidate <name>
fundx fund refresh-universe <name>
fundx start
fundx stop
fundx status
fundx session run <fund>
fundx sws login | logout | status
fundx eval
```

- [ ] **Step 4: Verify**

Run: `rg -in "telegram|gateway" src/services/init.service.ts`
Expected: no output.

- [ ] **Step 5: Commit**

```
git add src/services/init.service.ts
git commit -m "refactor(init): remove Telegram wizard step and gateway references"
```

---

### Task E4: Update root CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Patch sections**

Open `CLAUDE.md`. Apply:

- **Tech Stack table**: remove the `grammy` row.
- **Source Structure**: remove `gateway/` from `src/commands/`, remove `telegram-notify.ts` and `broker-local-notify.ts` from `src/mcp/`, remove `gateway.service.ts` from `src/services/`.
- **High-Level Flow**: drop the "Telegram Gateway" component from the diagram.
- **Phase 3 — Telegram**: change header to `### Phase 3 — Telegram — REMOVED (2026-05-11, see specs)` and leave the historical checklist intact as a record.
- **Architecture / Core Concepts**: drop the "Telegram Gateway" bullet.

- [ ] **Step 2: Add reference to the new spec under "Important Notes for AI Assistants"**

Append the bullet:
```
- Telegram was removed in May 2026. The user interface is the dashboard chat REPL (`fundx status`) plus OS notifications via `src/services/notify.service.ts`. See `docs/superpowers/specs/2026-05-11-simplify-notifications-and-cli-design.md`.
```

- [ ] **Step 3: Commit**

```
git add CLAUDE.md
git commit -m "docs(claude-md): reflect Telegram removal and CLI simplification"
```

---

## Phase F — Migration, regression tests, and verification

### Task F1: Regression test — no "telegram" residue in prompts

**Files:**
- Create: `tests/no-telegram-residue.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { BUILTIN_SKILLS, WORKSPACE_SKILL, FUND_RULES } from "../src/skills.js";

describe("no telegram residue", () => {
  it("BUILTIN_SKILLS contain no 'telegram' references", () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.content.toLowerCase()).not.toContain("telegram");
    }
  });

  it("WORKSPACE_SKILL contains no 'telegram' references", () => {
    expect(WORKSPACE_SKILL.content.toLowerCase()).not.toContain("telegram");
  });

  it("FUND_RULES contain no 'telegram' references", () => {
    for (const r of FUND_RULES) {
      expect(r.content.toLowerCase()).not.toContain("telegram");
    }
  });
});
```

- [ ] **Step 2: Run test**

Run: `pnpm vitest run tests/no-telegram-residue.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```
git add tests/no-telegram-residue.test.ts
git commit -m "test(notify): regression guard against telegram residue in prompts"
```

---

### Task F2: Clean Telegram references from existing tests

**Files:**
- Modify: every file returned by `rg -l "telegram" tests/` (excluding the one created in F1; the ones deleted in C1 and C2 are already gone)

- [ ] **Step 1: List affected tests**

```
rg -l "telegram" tests/
```

- [ ] **Step 2: For each file, choose:**

- If the file's purpose was Telegram-specific (`gateway-retry.test.ts`, `telegram-notify.test.ts` — already deleted) → no action.
- If a test fixture has `auth: { telegram: {...} }` or `notifications: { telegram: {...} }` keys → remove those keys (schema's `.strip()` would also tolerate them, but cleaning avoids confusion).
- If a test asserts a Telegram call was made → remove the assertion.

Go file by file with `rg -n "telegram" <file>` and clean each match.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add -A tests/
git commit -m "test(telegram): drop telegram references from existing tests"
```

---

### Task F3: Remove grammy from package.json

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Inspect package.json**

```
grep -E "grammy|@grammyjs" package.json
```

- [ ] **Step 2: Remove**

```
pnpm remove grammy
```
For each `@grammyjs/*` package listed by the grep:
```
pnpm remove @grammyjs/<name>
```

- [ ] **Step 3: Typecheck and test**

```
pnpm typecheck
pnpm test
```
Expected: both pass.

- [ ] **Step 4: Commit**

```
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): remove grammy"
```

---

### Task F4: End-to-end smoke verification

- [ ] **Step 1: Build**

```
pnpm build
```
Expected: clean build, no errors.

- [ ] **Step 2: Stop daemon, upgrade fund files, restart**

```
fundx stop || true
fundx fund upgrade --all
fundx start
```
Expected: daemon starts; `fundx status` shows no Telegram row in SystemStatusPanel.

- [ ] **Step 3: Force a session on the smoke fund**

```
fundx session run fundx-audit
```
Expected: if the session executes any trade, an OS notification appears (macOS notification center / Linux notify-osd).

- [ ] **Step 4: Run the MVP eval suite**

```
pnpm dev -- eval --filter mvp-
```
Expected: all 8 cases pass.

- [ ] **Step 5: Inspect rendered fund files for residue**

```
grep -ri "telegram" ~/.fundx/funds/fundx-audit/ || echo "clean"
```
Expected: "clean".

- [ ] **Step 6: If any residual fix was required during smoke, commit**

```
git add -A
git commit -m "fix: address smoke-test issues from telegram removal"
```

---

## Spec coverage summary

- Section 1 (Notifications SO) → Tasks A1–A4, B1–B4
- Section 2 (Telegram removal) → Tasks C1–C3, F3
- Section 3 (CLI recortado) → Tasks D1–D3
- Section 4 (Skills/rules/template) → Tasks E1–E4
- Section 5 (Migration) → Task C3 step 3 (schema `.strip()`), Task F4 (smoke)

Total: 6 phases → 22 tasks → roughly 70 atomic steps.
