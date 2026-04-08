# Programmatic Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 6 notification types fire programmatically from the code that executes the event, not from Claude.

**Architecture:** Trade/stop-loss alerts fire from `broker-local.ts` MCP server via direct Telegram HTTP API call. Daily/weekly digests fire from `daemon.service.ts` after report generation. Milestone/drawdown alerts fire from the daemon's 5-minute stop-loss check loop. New state files track daily snapshots and notified milestones.

**Tech Stack:** TypeScript, Telegram Bot API (HTTP fetch), Vitest

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/paths.ts` | Modify | Add `dailySnapshot` and `notifiedMilestones` paths |
| `src/types.ts` | Modify | Add `DailySnapshot` and `NotifiedMilestones` schemas |
| `src/state.ts` | Modify | Add read/write for daily snapshot and notified milestones |
| `src/mcp/broker-local.ts` | Modify | Add `sendTelegram()`, quiet hours check, trade/stop-loss notifications after `place_order` |
| `src/services/daemon.service.ts` | Modify | Add digest notifications after reports, milestone/drawdown checks in 5-min loop, daily snapshot write |
| `tests/paths.test.ts` | Modify | Test new paths |
| `tests/state.test.ts` | Modify | Test new state read/write |
| `tests/types.test.ts` | Modify | Test new schemas |
| `tests/broker-local-notify.test.ts` | Create | Test trade notification logic |
| `tests/daemon-integration.test.ts` | Modify | Test digest, milestone, drawdown notification logic |

---

### Task 1: Add new paths and schemas

**Files:**
- Modify: `src/paths.ts:82-94`
- Modify: `src/types.ts`
- Test: `tests/paths.test.ts`, `tests/types.test.ts`

- [ ] **Step 1: Write failing tests for paths**

Add to `tests/paths.test.ts`:

```typescript
it("includes dailySnapshot in state paths", () => {
  const paths = fundPaths("test-fund");
  expect(paths.state.dailySnapshot).toBe(
    join(FUNDS_DIR, "test-fund", "state", "daily_snapshot.json"),
  );
});

it("includes notifiedMilestones in state paths", () => {
  const paths = fundPaths("test-fund");
  expect(paths.state.notifiedMilestones).toBe(
    join(FUNDS_DIR, "test-fund", "state", "notified_milestones.json"),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/paths.test.ts --reporter=verbose`
Expected: FAIL — properties don't exist.

- [ ] **Step 3: Add paths**

In `src/paths.ts`, inside the `state` object in `fundPaths()`, after `sessionHandoff`, add:

```typescript
      dailySnapshot: join(root, "state", "daily_snapshot.json"),
      notifiedMilestones: join(root, "state", "notified_milestones.json"),
```

- [ ] **Step 4: Run path tests to verify they pass**

Run: `pnpm test -- tests/paths.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Write failing tests for schemas**

Add to `tests/types.test.ts`:

```typescript
import { dailySnapshotSchema, notifiedMilestonesSchema } from "../src/types.js";

describe("dailySnapshotSchema", () => {
  it("parses a valid daily snapshot", () => {
    const result = dailySnapshotSchema.parse({
      date: "2026-04-08",
      total_value: 10024.41,
    });
    expect(result.date).toBe("2026-04-08");
    expect(result.total_value).toBe(10024.41);
  });
});

describe("notifiedMilestonesSchema", () => {
  it("parses valid milestone tracking data", () => {
    const result = notifiedMilestonesSchema.parse({
      thresholds_notified: [10, 25],
      peak_value: 12500,
      drawdown_thresholds_notified: [50],
      last_checked: "2026-04-08T15:30:00Z",
    });
    expect(result.thresholds_notified).toEqual([10, 25]);
    expect(result.peak_value).toBe(12500);
    expect(result.drawdown_thresholds_notified).toEqual([50]);
  });

  it("provides defaults for empty object", () => {
    const result = notifiedMilestonesSchema.parse({});
    expect(result.thresholds_notified).toEqual([]);
    expect(result.peak_value).toBe(0);
    expect(result.drawdown_thresholds_notified).toEqual([]);
    expect(result.last_checked).toBe("");
  });
});
```

- [ ] **Step 6: Add schemas to types.ts**

In `src/types.ts`, after the `objectiveTrackerSchema` (around line 267), add:

```typescript
export const dailySnapshotSchema = z.object({
  date: z.string(),
  total_value: z.number(),
});

export type DailySnapshot = z.infer<typeof dailySnapshotSchema>;

export const notifiedMilestonesSchema = z.object({
  thresholds_notified: z.array(z.number()).default([]),
  peak_value: z.number().default(0),
  drawdown_thresholds_notified: z.array(z.number()).default([]),
  last_checked: z.string().default(""),
});

export type NotifiedMilestones = z.infer<typeof notifiedMilestonesSchema>;
```

- [ ] **Step 7: Run all tests**

Run: `pnpm test -- tests/paths.test.ts tests/types.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/paths.ts src/types.ts tests/paths.test.ts tests/types.test.ts
git commit -m "feat: add daily snapshot and notified milestones paths and schemas"
```

---

### Task 2: Add state read/write for new state files

**Files:**
- Modify: `src/state.ts`
- Test: `tests/state.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/state.test.ts` (import the new functions and types):

```typescript
import {
  // ... existing imports ...
  readDailySnapshot,
  writeDailySnapshot,
  readNotifiedMilestones,
  writeNotifiedMilestones,
} from "../src/state.js";
```

```typescript
describe("Daily Snapshot", () => {
  it("reads daily snapshot from the correct path", async () => {
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ date: "2026-04-08", total_value: 10000 }));
    const snapshot = await readDailySnapshot("test-fund");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.date).toBe("2026-04-08");
    expect(snapshot!.total_value).toBe(10000);
  });

  it("returns null when snapshot does not exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedReadFile.mockRejectedValueOnce(err);
    const snapshot = await readDailySnapshot("test-fund");
    expect(snapshot).toBeNull();
  });

  it("writes daily snapshot atomically", async () => {
    await writeDailySnapshot("test-fund", { date: "2026-04-08", total_value: 10000 });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("daily_snapshot.json.tmp"),
      expect.stringContaining("10000"),
      "utf-8",
    );
    expect(mockedRename).toHaveBeenCalled();
  });
});

describe("Notified Milestones", () => {
  it("reads milestones from the correct path", async () => {
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({
      thresholds_notified: [10, 25],
      peak_value: 12500,
      drawdown_thresholds_notified: [],
      last_checked: "2026-04-08T15:30:00Z",
    }));
    const milestones = await readNotifiedMilestones("test-fund");
    expect(milestones.thresholds_notified).toEqual([10, 25]);
    expect(milestones.peak_value).toBe(12500);
  });

  it("returns defaults when file does not exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedReadFile.mockRejectedValueOnce(err);
    const milestones = await readNotifiedMilestones("test-fund");
    expect(milestones.thresholds_notified).toEqual([]);
    expect(milestones.peak_value).toBe(0);
    expect(milestones.drawdown_thresholds_notified).toEqual([]);
  });

  it("writes milestones atomically", async () => {
    await writeNotifiedMilestones("test-fund", {
      thresholds_notified: [10],
      peak_value: 10500,
      drawdown_thresholds_notified: [],
      last_checked: "2026-04-08T16:00:00Z",
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("notified_milestones.json.tmp"),
      expect.stringContaining("10500"),
      "utf-8",
    );
    expect(mockedRename).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/state.test.ts --reporter=verbose`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement the functions**

In `src/state.ts`, add imports for the new schemas at the top:

```typescript
import {
  // ... existing imports ...
  dailySnapshotSchema,
  notifiedMilestonesSchema,
  type DailySnapshot,
  type NotifiedMilestones,
} from "./types.js";
```

After the Session Handoff section, add:

```typescript
// ── Daily Snapshot ────────────────────────────────────────────

export async function readDailySnapshot(fundName: string): Promise<DailySnapshot | null> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.dailySnapshot);
    return dailySnapshotSchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeDailySnapshot(fundName: string, snapshot: DailySnapshot): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.dailySnapshot, snapshot);
}

// ── Notified Milestones ──────────────────────────────────────

export async function readNotifiedMilestones(fundName: string): Promise<NotifiedMilestones> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.notifiedMilestones);
    return notifiedMilestonesSchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return notifiedMilestonesSchema.parse({});
    }
    throw err;
  }
}

export async function writeNotifiedMilestones(fundName: string, milestones: NotifiedMilestones): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.notifiedMilestones, milestones);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/state.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: add daily snapshot and notified milestones state read/write"
```

---

### Task 3: Add trade/stop-loss notifications to broker-local MCP

**Files:**
- Modify: `src/mcp/broker-local.ts:214-246` (the `place_order` handler)
- Create: `tests/broker-local-notify.test.ts`

- [ ] **Step 1: Write tests for the notification helper functions**

Create `tests/broker-local-notify.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  isInQuietHoursEnv,
  shouldSendNotification,
  formatTradeAlert,
  formatStopLossAlert,
} from "../src/mcp/broker-local-notify.js";

describe("isInQuietHoursEnv", () => {
  it("returns false when env vars not set", () => {
    expect(isInQuietHoursEnv(undefined, undefined)).toBe(false);
  });

  it("returns true when current time is inside range", () => {
    // 23:00 - 07:00, test at 01:00
    expect(isInQuietHoursEnv("23:00", "07:00", 60)).toBe(true);
  });

  it("returns false when current time is outside range", () => {
    // 23:00 - 07:00, test at 12:00
    expect(isInQuietHoursEnv("23:00", "07:00", 720)).toBe(false);
  });
});

describe("shouldSendNotification", () => {
  it("returns true when not in quiet hours", () => {
    expect(shouldSendNotification(false, false, false)).toBe(true);
  });

  it("returns false when in quiet hours and not critical", () => {
    expect(shouldSendNotification(true, false, true)).toBe(false);
  });

  it("returns true when in quiet hours, critical, and allow_critical", () => {
    expect(shouldSendNotification(true, true, true)).toBe(true);
  });

  it("returns false when in quiet hours, critical, but no allow_critical", () => {
    expect(shouldSendNotification(true, true, false)).toBe(false);
  });
});

describe("formatTradeAlert", () => {
  it("formats a buy alert", () => {
    const msg = formatTradeAlert("Growth", "URA", "buy", 6, 48.66, "Gold miners oversold");
    expect(msg).toContain("🟢");
    expect(msg).toContain("<b>Growth</b>");
    expect(msg).toContain("BUY");
    expect(msg).toContain("6 URA");
    expect(msg).toContain("48.66");
    expect(msg).toContain("Gold miners oversold");
  });

  it("formats a sell alert", () => {
    const msg = formatTradeAlert("Growth", "URA", "sell", 6, 52.00, "Target reached");
    expect(msg).toContain("🔴");
    expect(msg).toContain("SELL");
  });
});

describe("formatStopLossAlert", () => {
  it("formats a stop-loss alert", () => {
    const msg = formatStopLossAlert("Growth", "URA", 6, 46.00, -15.96, -5.48);
    expect(msg).toContain("⚠️");
    expect(msg).toContain("STOP-LOSS");
    expect(msg).toContain("URA");
    expect(msg).toContain("46.00");
    expect(msg).toContain("-15.96");
    expect(msg).toContain("-5.48");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/broker-local-notify.test.ts --reporter=verbose`
Expected: FAIL — module not found.

- [ ] **Step 3: Create broker-local-notify.ts with pure functions**

Create `src/mcp/broker-local-notify.ts`:

```typescript
// ── Quiet Hours (env-var based, matching telegram-notify.ts) ──

export function isInQuietHoursEnv(
  start: string | undefined,
  end: string | undefined,
  currentMinutesOverride?: number,
): boolean {
  if (!start || !end) return false;
  const now = currentMinutesOverride ?? new Date().getHours() * 60 + new Date().getMinutes();
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const startMin = startH! * 60 + startM!;
  const endMin = endH! * 60 + endM!;
  if (startMin <= endMin) return now >= startMin && now < endMin;
  return now >= startMin || now < endMin;
}

export function shouldSendNotification(
  inQuietHours: boolean,
  isCritical: boolean,
  allowCritical: boolean,
): boolean {
  if (!inQuietHours) return true;
  if (isCritical && allowCritical) return true;
  return false;
}

// ── Formatting ──────────────────────────────────────────────

export function formatTradeAlert(
  fund: string,
  symbol: string,
  side: "buy" | "sell",
  qty: number,
  price: number,
  reason?: string,
): string {
  const emoji = side === "buy" ? "🟢" : "🔴";
  const action = side === "buy" ? "BUY" : "SELL";
  const total = (qty * price).toFixed(2);
  const lines = [
    `${emoji} <b>${fund}</b> — ${action} ${qty} ${symbol} @ $${price.toFixed(2)}`,
    `Total: $${total}`,
  ];
  if (reason) lines.push(`Reason: ${reason}`);
  return lines.join("\n");
}

export function formatStopLossAlert(
  fund: string,
  symbol: string,
  shares: number,
  price: number,
  loss: number,
  lossPct: number,
): string {
  return [
    `⚠️ <b>${fund}</b> — STOP-LOSS ${symbol}`,
    `${shares} shares sold @ $${price.toFixed(2)} (stop triggered)`,
    `Loss: $${loss.toFixed(2)} (${lossPct.toFixed(1)}%)`,
  ].join("\n");
}

// ── Send ────────────────────────────────────────────────────

export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch {
    // Best effort — never fail the trade because of a notification error
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/broker-local-notify.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Integrate notifications into broker-local place_order**

In `src/mcp/broker-local.ts`, add import at the top:

```typescript
import {
  isInQuietHoursEnv,
  shouldSendNotification,
  formatTradeAlert,
  formatStopLossAlert,
  sendTelegram,
} from "./broker-local-notify.js";
```

After the `logTrade()` call in the `place_order` handler (around line 232), add the notification:

```typescript
    // ── Notify via Telegram ──
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      const fundName = FUND_DIR.split("/").pop() ?? "unknown";
      const isStopLoss = /stop/i.test(entry_reason ?? "");
      const notifyEnabled = isStopLoss
        ? process.env.NOTIFY_STOP_LOSS_ALERTS !== "false"
        : process.env.NOTIFY_TRADE_ALERTS !== "false";

      if (notifyEnabled) {
        const inQuiet = isInQuietHoursEnv(
          process.env.QUIET_HOURS_START,
          process.env.QUIET_HOURS_END,
        );
        const allowCrit = process.env.QUIET_HOURS_ALLOW_CRITICAL === "true";

        if (shouldSendNotification(inQuiet, isStopLoss, allowCrit)) {
          const message = isStopLoss
            ? formatStopLossAlert(
                fundName,
                symbol.toUpperCase(),
                qty,
                price,
                result.trade.total_value - (result.trade.total_value + Math.abs(result.trade.pnl ?? 0)),
                result.trade.pnl_pct ?? 0,
              )
            : formatTradeAlert(
                fundName,
                symbol.toUpperCase(),
                side,
                qty,
                price,
                entry_reason,
              );
          await sendTelegram(botToken, chatId, message);
        }
      }
    }
```

NOTE: The `result.trade` object from `executeBuy`/`executeSell` contains `{ symbol, side, qty, price, total_value, reason }`. For stop-loss loss computation, the reason string already contains the loss info. A simpler approach: for stop-loss, parse loss from the reason string. Or even simpler: for sells, compute `(price - avg_cost) * qty` from the position. Let the implementer read `paper-trading.ts` to determine the exact fields available on `result.trade` and adapt.

- [ ] **Step 6: Run full test suite**

Run: `pnpm test --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mcp/broker-local-notify.ts src/mcp/broker-local.ts tests/broker-local-notify.test.ts
git commit -m "feat: add trade and stop-loss Telegram notifications to broker-local"
```

---

### Task 4: Add daily digest notification to daemon

**Files:**
- Modify: `src/services/daemon.service.ts:510-515` (daily report section)
- Test: `tests/daemon-integration.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/daemon-integration.test.ts`:

```typescript
import { sendDailyDigest } from "../src/services/daemon.service.js";

describe("sendDailyDigest", () => {
  it("is exported and callable", () => {
    expect(typeof sendDailyDigest).toBe("function");
  });
});
```

- [ ] **Step 2: Implement sendDailyDigest function**

In `src/services/daemon.service.ts`, add imports:

```typescript
import { readPortfolio, readTracker, readDailySnapshot, writeDailySnapshot } from "../state.js";
```

Add the exported function (near other utility functions):

```typescript
/** Send a daily digest notification for a fund via Telegram */
export async function sendDailyDigest(fundName: string): Promise<void> {
  const config = await loadFundConfig(fundName);
  if (!config.notifications.telegram.enabled || !config.notifications.telegram.daily_digest) return;

  // Check quiet hours
  const qh = config.notifications.quiet_hours;
  if (qh.enabled && isInQuietHoursForFund(qh.start, qh.end)) return;

  const portfolio = await readPortfolio(fundName);
  const tracker = await readTracker(fundName).catch(() => null);
  const snapshot = await readDailySnapshot(fundName);

  const today = new Date().toISOString().split("T")[0];
  let pnlLine = "";
  if (snapshot && snapshot.date === today) {
    const pnl = portfolio.total_value - snapshot.total_value;
    const pnlPct = snapshot.total_value > 0 ? (pnl / snapshot.total_value) * 100 : 0;
    const sign = pnl >= 0 ? "+" : "";
    pnlLine = `P&amp;L: ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`;
  } else {
    pnlLine = `Value: $${portfolio.total_value.toFixed(2)}`;
  }

  const cashPct = portfolio.total_value > 0
    ? ((portfolio.cash / portfolio.total_value) * 100).toFixed(1)
    : "100.0";

  // Find top mover
  let topMover = "";
  if (portfolio.positions.length > 0) {
    const best = portfolio.positions.reduce((a, b) =>
      Math.abs(a.unrealized_pnl_pct) > Math.abs(b.unrealized_pnl_pct) ? a : b);
    const sign = best.unrealized_pnl_pct >= 0 ? "+" : "";
    topMover = `\nTop mover: ${best.symbol} ${sign}${best.unrealized_pnl_pct.toFixed(1)}%`;
  }

  const objectiveLine = tracker
    ? `\nObjective: ${tracker.progress_pct.toFixed(1)}% toward goal`
    : "";

  const displayName = config.fund.display_name;
  const message = [
    `📊 <b>${displayName}</b> — Daily Digest (${today})`,
    pnlLine,
    `Portfolio: $${portfolio.total_value.toFixed(2)}`,
    `Cash: ${cashPct}% | Positions: ${portfolio.positions.length}`,
  ].join("\n") + topMover + objectiveLine;

  const { sendTelegramNotification } = await import("./gateway.service.js");
  await sendTelegramNotification(message);
}
```

Add the quiet hours helper (near the top of the file):

```typescript
function isInQuietHoursForFund(start: string, end: string): boolean {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const startMin = startH! * 60 + startM!;
  const endMin = endH! * 60 + endM!;
  if (startMin <= endMin) return currentMinutes >= startMin && currentMinutes < endMin;
  return currentMinutes >= startMin || currentMinutes < endMin;
}
```

- [ ] **Step 3: Wire into the daily report cron**

In `daemon.service.ts`, modify the daily report block (around line 511):

```typescript
            if (currentTime === DAILY_REPORT_TIME) {
              generateDailyReport(name).then(async () => {
                try { await sendDailyDigest(name); } catch (err) {
                  await log(`Daily digest error (${name}): ${err}`);
                }
              }).catch(async (err) => {
                await log(`Daily report error (${name}): ${err}`);
              });
            }
```

- [ ] **Step 4: Run tests**

Run: `pnpm test --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon.service.ts src/state.ts tests/daemon-integration.test.ts
git commit -m "feat: add daily digest Telegram notification after report generation"
```

---

### Task 5: Add weekly digest notification to daemon

**Files:**
- Modify: `src/services/daemon.service.ts:516-520` (weekly report section)
- Test: `tests/daemon-integration.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { sendWeeklyDigest } from "../src/services/daemon.service.js";

describe("sendWeeklyDigest", () => {
  it("is exported and callable", () => {
    expect(typeof sendWeeklyDigest).toBe("function");
  });
});
```

- [ ] **Step 2: Implement sendWeeklyDigest**

In `src/services/daemon.service.ts`, add:

```typescript
/** Send a weekly digest notification for a fund via Telegram */
export async function sendWeeklyDigest(fundName: string): Promise<void> {
  const config = await loadFundConfig(fundName);
  if (!config.notifications.telegram.enabled || !config.notifications.telegram.weekly_digest) return;

  const qh = config.notifications.quiet_hours;
  if (qh.enabled && isInQuietHoursForFund(qh.start, qh.end)) return;

  const portfolio = await readPortfolio(fundName);
  const tracker = await readTracker(fundName).catch(() => null);

  // Get trades from last 7 days
  const { openJournal, getTradesInDays } = await import("../journal.js");
  const db = openJournal(fundName);
  let trades: Array<{ pnl?: number | null }> = [];
  try {
    trades = getTradesInDays(db, fundName, 7);
  } finally {
    db.close();
  }

  const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
  const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;
  const bestPnl = trades.reduce((max, t) => Math.max(max, t.pnl ?? 0), 0);
  const worstPnl = trades.reduce((min, t) => Math.min(min, t.pnl ?? 0), 0);

  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekRange = `${weekAgo.toISOString().split("T")[0]} – ${today.toISOString().split("T")[0]}`;

  const objectiveLine = tracker
    ? `\nObjective: ${tracker.progress_pct.toFixed(1)}% toward goal`
    : "";

  const displayName = config.fund.display_name;
  const message = [
    `📅 <b>${displayName}</b> — Weekly Digest (${weekRange})`,
    `Portfolio: $${portfolio.total_value.toFixed(2)}`,
    `Trades: ${trades.length} (${wins} wins, ${losses} losses)`,
    `Best: $${bestPnl.toFixed(2)} | Worst: $${worstPnl.toFixed(2)}`,
  ].join("\n") + objectiveLine;

  const { sendTelegramNotification } = await import("./gateway.service.js");
  await sendTelegramNotification(message);
}
```

- [ ] **Step 3: Wire into the weekly report cron**

```typescript
            if (currentDay === "FRI" && currentTime === WEEKLY_REPORT_TIME) {
              generateWeeklyReport(name).then(async () => {
                try { await sendWeeklyDigest(name); } catch (err) {
                  await log(`Weekly digest error (${name}): ${err}`);
                }
              }).catch(async (err) => {
                await log(`Weekly report error (${name}): ${err}`);
              });
            }
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm test --reporter=verbose`
Expected: PASS

```bash
git add src/services/daemon.service.ts tests/daemon-integration.test.ts
git commit -m "feat: add weekly digest Telegram notification after report generation"
```

---

### Task 6: Add daily snapshot write and milestone/drawdown checks to daemon

**Files:**
- Modify: `src/services/daemon.service.ts:528-552` (stop-loss check block)
- Test: `tests/daemon-integration.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { checkMilestonesAndDrawdown } from "../src/services/daemon.service.js";

describe("checkMilestonesAndDrawdown", () => {
  it("is exported and callable", () => {
    expect(typeof checkMilestonesAndDrawdown).toBe("function");
  });
});
```

- [ ] **Step 2: Implement checkMilestonesAndDrawdown**

In `src/services/daemon.service.ts`, add imports if not already present:

```typescript
import { readNotifiedMilestones, writeNotifiedMilestones } from "../state.js";
```

Add the function:

```typescript
const MILESTONE_THRESHOLDS = [10, 25, 50, 75, 100];
const DRAWDOWN_BUDGET_THRESHOLDS = [50, 75];

/** Check for milestone and drawdown alerts, send Telegram notifications */
export async function checkMilestonesAndDrawdown(fundName: string): Promise<void> {
  const config = await loadFundConfig(fundName);
  if (!config.notifications.telegram.enabled) return;

  const portfolio = await readPortfolio(fundName);
  const tracker = await readTracker(fundName).catch(() => null);
  const milestones = await readNotifiedMilestones(fundName);

  const displayName = config.fund.display_name;
  const { sendTelegramNotification } = await import("./gateway.service.js");

  // ── Update peak value ──
  if (portfolio.total_value > milestones.peak_value) {
    milestones.peak_value = portfolio.total_value;
    // Reset drawdown thresholds when new peak is reached
    milestones.drawdown_thresholds_notified = [];
  }

  // ── Milestone check ──
  if (tracker && config.notifications.telegram.milestone_alerts) {
    const qh = config.notifications.quiet_hours;
    const suppressed = qh.enabled && isInQuietHoursForFund(qh.start, qh.end);

    if (!suppressed) {
      for (const threshold of MILESTONE_THRESHOLDS) {
        if (
          tracker.progress_pct >= threshold &&
          !milestones.thresholds_notified.includes(threshold)
        ) {
          milestones.thresholds_notified.push(threshold);
          const gain = portfolio.total_value - tracker.initial_capital;
          const sign = gain >= 0 ? "+" : "";
          await sendTelegramNotification(
            `🎯 <b>${displayName}</b> — Milestone: ${threshold}% of objective reached\n` +
            `$${tracker.initial_capital.toLocaleString()} → $${portfolio.total_value.toLocaleString()} (${sign}$${gain.toFixed(2)})`,
          );
        }
      }
    }
  }

  // ── Drawdown check ──
  if (config.notifications.telegram.drawdown_alerts && milestones.peak_value > 0) {
    const drawdownPct = ((milestones.peak_value - portfolio.total_value) / milestones.peak_value) * 100;
    const maxDrawdown = config.risk.max_drawdown_pct;
    const budgetUsed = maxDrawdown > 0 ? (drawdownPct / maxDrawdown) * 100 : 0;

    // Drawdown is CRITICAL — check quiet hours with allow_critical
    const qh = config.notifications.quiet_hours;
    const inQuiet = qh.enabled && isInQuietHoursForFund(qh.start, qh.end);
    const allowCrit = qh.allow_critical;
    const suppressed = inQuiet && !allowCrit;

    if (!suppressed) {
      for (const threshold of DRAWDOWN_BUDGET_THRESHOLDS) {
        if (
          budgetUsed >= threshold &&
          !milestones.drawdown_thresholds_notified.includes(threshold)
        ) {
          milestones.drawdown_thresholds_notified.push(threshold);
          const action = threshold >= 75
            ? "No new positions, reduce-only mode"
            : "Half sizing on new positions";
          await sendTelegramNotification(
            `📉 <b>${displayName}</b> — Drawdown Warning\n` +
            `-$${(milestones.peak_value - portfolio.total_value).toFixed(2)} (-${drawdownPct.toFixed(1)}%) from peak $${milestones.peak_value.toLocaleString()}\n` +
            `Drawdown budget: ${budgetUsed.toFixed(0)}% used (max -${maxDrawdown}%)\n` +
            `Action: ${action}`,
          );
        }
      }
    }
  }

  milestones.last_checked = new Date().toISOString();
  await writeNotifiedMilestones(fundName, milestones);
}
```

- [ ] **Step 3: Add daily snapshot write at first stop-loss check of the day**

In the stop-loss check block (around line 534), BEFORE the `checkStopLosses` call, add:

```typescript
                  // Write daily snapshot at first check of the day
                  try {
                    const today = new Date().toISOString().split("T")[0];
                    const snap = await readDailySnapshot(name);
                    if (!snap || snap.date !== today) {
                      const port = await readPortfolio(name);
                      await writeDailySnapshot(name, { date: today, total_value: port.total_value });
                    }
                  } catch { /* non-critical */ }
```

- [ ] **Step 4: Wire milestone/drawdown check after stop-loss check**

After the `executeStopLosses` call and before the `clearError(name, "stoploss")` line, add:

```typescript
                    // Check milestones and drawdown after stop-loss check
                    try {
                      await checkMilestonesAndDrawdown(name);
                    } catch (err) {
                      await log(`Milestone/drawdown check error (${name}): ${err}`);
                    }
```

- [ ] **Step 5: Add the readDailySnapshot and writeDailySnapshot imports**

Ensure the state import in `daemon.service.ts` includes the new functions:

```typescript
import { readSessionHistory, readPendingSessions, writePendingSessions, readSessionCounts, writeSessionCounts, readPortfolio, readTracker, readDailySnapshot, writeDailySnapshot, readNotifiedMilestones, writeNotifiedMilestones } from "../state.js";
```

Note: `readPortfolio` and `readTracker` may already be imported for the digest functions added in Tasks 4-5. Check and add only missing ones.

- [ ] **Step 6: Run tests**

Run: `pnpm test --reporter=verbose`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/daemon.service.ts tests/daemon-integration.test.ts
git commit -m "feat: add milestone/drawdown alerts and daily snapshot to daemon"
```

---

### Task 7: Run full verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Clean build (including new `broker-local-notify.ts` compiled alongside `broker-local.ts`).

- [ ] **Step 4: Run lint**

Run: `pnpm lint`
Expected: No new lint errors.

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address test/lint issues from programmatic notifications"
```
