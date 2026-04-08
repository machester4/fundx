# Programmatic Notifications

**Date:** 2026-04-08
**Status:** Draft

## Summary

Make all 6 notification types programmatic instead of relying on Claude to call MCP tools. Notifications fire automatically from the broker-local MCP server (trade/stop-loss alerts) and the daemon (digests, milestones, drawdowns).

## Context

FundX has 7 Telegram notification tools in the `telegram-notify` MCP server, but none are called programmatically. Trade alerts, stop-loss alerts, daily/weekly digests, milestone alerts, and drawdown alerts are all silent. The only working Telegram notifications are session lifecycle events and breaking news alerts.

### Current Gaps

| Notification | MCP Tool Exists | Called Programmatically | Status |
|---|---|---|---|
| Trade alert | `send_trade_alert` | No | Trades are silent |
| Stop-loss alert | `send_stop_loss_alert` | No | Stop-losses execute silently |
| Daily digest | `send_daily_digest` | No | Reports generated silently |
| Weekly digest | `send_weekly_digest` | No | Reports generated silently |
| Milestone alert | `send_milestone_alert` | No | Orphaned tool |
| Drawdown alert | `send_drawdown_alert` | No | Orphaned tool |

### Design Decision

Notifications are system events, not agent decisions. They should fire automatically from the code that executes the event, not depend on Claude remembering to call a tool.

---

## Architecture

```
broker-local MCP ──> Trade alerts (after place_order)
                 ──> Stop-loss alerts (same path, different format)

daemon cron ──> Daily digest (18:30, after report generation)
            ──> Weekly digest (Friday 19:00, after report generation)
            ──> Milestone alerts (every 5 min, with stop-loss check)
            ──> Drawdown alerts (every 5 min, with stop-loss check)
```

All notifications go to Telegram. The broker-local MCP uses the Telegram Bot API directly via HTTP fetch (it's a separate process, can't import gateway.service). The daemon uses the existing `sendTelegramNotification()` from gateway.service.

---

## 1. Trade Alerts (broker-local MCP)

### Trigger

After `place_order` tool executes a trade successfully in `src/mcp/broker-local.ts`.

### Implementation

Add a `sendTelegram()` helper inside `broker-local.ts` that calls the Telegram Bot API directly:

```typescript
async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}
```

After a successful trade execution, check env vars and send:

- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` must be set
- `NOTIFY_TRADE_ALERTS` must be `"true"`
- Quiet hours check using `QUIET_HOURS_START`, `QUIET_HOURS_END` env vars
- Trades are NOT critical — suppressed during quiet hours

### Format

**Buy:**
```
🟢 <b>Growth</b> — BUY 6 URA @ $48.66
Total: $291.96
Reason: Gold miners oversold, regime transition
```

**Sell:**
```
🔴 <b>Growth</b> — SELL 6 URA @ $52.00
Total: $312.00
P&L: +$20.04 (+6.87%)
Reason: Target reached
```

### Stop-Loss Differentiation

Stop-losses also execute via `place_order` (sell side). When the order reason contains "stop" (case-insensitive), use a different format:

```
⚠️ <b>Growth</b> — STOP-LOSS URA
6 shares sold @ $46.00 (stop triggered)
Loss: -$15.96 (-5.48%)
```

Stop-loss alerts are **CRITICAL** — bypass quiet hours when `QUIET_HOURS_ALLOW_CRITICAL=true`.

### Quiet Hours Logic

Reuse the same logic as the `telegram-notify` MCP server (env var based):

```typescript
function isInQuietHours(): boolean {
  const start = process.env.QUIET_HOURS_START;
  const end = process.env.QUIET_HOURS_END;
  if (!start || !end) return false;
  // Same time comparison as telegram-notify.ts
}

function shouldSend(isCritical: boolean): boolean {
  if (!isInQuietHours()) return true;
  if (isCritical && process.env.QUIET_HOURS_ALLOW_CRITICAL === "true") return true;
  return false;
}
```

### Error Handling

Best-effort: catch and log errors, never fail the trade because of a notification failure.

---

## 2. Daily Digest (daemon)

### Trigger

After `generateDailyReport()` completes in the 18:30 cron in `daemon.service.ts`.

### Data Source

Read directly from fund state files (not parse the markdown report):
- `portfolio.json` — total_value, cash, positions
- `objective_tracker.json` — progress_pct, status
- Compute daily P&L by comparing current `total_value` against previous day's value (from `session_log.json` or a new `state/daily_snapshot.json`)

### Daily P&L Tracking

To compute daily P&L, we need to know the portfolio value at the start of the day. Two options:

**Option A:** Read the previous day's daily report (parse total_value from markdown) — fragile.
**Option B:** Save a daily snapshot at market open — `state/daily_snapshot.json` with `{ date, total_value }`.

Use **Option B**. The daemon writes `daily_snapshot.json` at the first stop-loss check of the day (9:30 AM). If it doesn't exist for today, the digest shows absolute values without daily P&L delta.

### Format

```
📊 <b>Growth</b> — Daily Digest (Apr 8)
P&L: +$24.41 (+0.24%)
Portfolio: $10,024.41
Cash: 94.6% | Positions: 2
Top mover: URA +6.97%
Objective: 0.24% toward goal
```

### Quiet Hours

Respects fund's quiet hours config. Daily digest at 18:30 is unlikely to be in quiet hours (default 23:00-07:00), but check anyway. NOT critical.

### Per-Fund Config

Only send if `notifications.telegram.enabled && notifications.telegram.daily_digest`.

---

## 3. Weekly Digest (daemon)

### Trigger

After `generateWeeklyReport()` completes in the Friday 19:00 cron.

### Data Source

Read from fund state:
- `portfolio.json` — current total_value
- `trade_journal.sqlite` — trades in last 7 days (count, wins, losses, best, worst)
- `objective_tracker.json` — progress

### Format

```
📅 <b>Growth</b> — Weekly Digest (Apr 1-8)
P&L: +$124.41 (+1.26%)
Trades: 3 (2 wins, 1 loss)
Best: URA +$38.50
Worst: GLD -$12.30
Objective: 1.26% toward goal
```

Weekly P&L: compare current `total_value` against value 7 days ago. Use the daily snapshots (7 days back) or the weekly report's computed data if available.

### Quiet Hours & Config

Same as daily digest. NOT critical. Controlled by `notifications.telegram.weekly_digest`.

---

## 4. Milestone Alerts (daemon, every 5 min)

### Trigger

During the existing 5-minute stop-loss check loop in `daemon.service.ts`, after stop-loss checks complete.

### Logic

1. Read `objective_tracker.json` → `progress_pct`
2. Define milestone thresholds: `[10, 25, 50, 75, 100]`
3. Read `state/notified_milestones.json` → array of already-notified thresholds
4. If `progress_pct` crosses a new threshold that hasn't been notified, send alert
5. Write updated `notified_milestones.json`

### State File

`state/notified_milestones.json`:
```json
{
  "thresholds_notified": [10, 25],
  "last_checked": "2026-04-08T15:30:00Z"
}
```

### Format

```
🎯 <b>Growth</b> — Milestone: 25% of objective reached
$10,000 → $12,500 (+$2,500)
Target: Grow capital 2x
```

### Quiet Hours & Config

NOT critical. Controlled by `notifications.telegram.milestone_alerts`.

---

## 5. Drawdown Alerts (daemon, every 5 min)

### Trigger

Same 5-minute loop as milestones.

### Logic

1. Read `portfolio.json` → `total_value`
2. Track peak portfolio value in `objective_tracker.json` (add `peak_value` field if not present, or use `state/notified_milestones.json` extended)
3. Compute drawdown: `(peak - current) / peak * 100`
4. Compare against `risk.max_drawdown_pct` from fund config
5. Alert at budget thresholds: 50% used, 75% used
6. Track which thresholds have been notified to avoid repeats
7. Reset thresholds when drawdown recovers below a threshold

### State

Extend `state/notified_milestones.json` to include drawdown tracking:

```json
{
  "thresholds_notified": [10, 25],
  "peak_value": 12500,
  "drawdown_thresholds_notified": [50],
  "last_checked": "2026-04-08T15:30:00Z"
}
```

### Format

```
📉 <b>Growth</b> — Drawdown Warning
-$1,500 (-12.0%) from peak $12,500
Drawdown budget: 80% used (max -15%)
Action: Half sizing on new positions
```

### Quiet Hours

**CRITICAL** — bypasses quiet hours. Drawdown alerts need immediate attention.

### Config

Controlled by `notifications.telegram.drawdown_alerts`.

---

## Files to Create or Modify

### New Files
| File | Purpose |
|------|---------|
| `state/notified_milestones.json` (per fund, runtime) | Milestone + drawdown notification tracking |
| `state/daily_snapshot.json` (per fund, runtime) | Daily opening value for P&L computation |

### Modified Files
| File | Changes |
|------|---------|
| `src/mcp/broker-local.ts` | Add `sendTelegram()` helper, quiet hours check, trade/stop-loss notification after `place_order` |
| `src/services/daemon.service.ts` | Add digest calls after report generation, add milestone/drawdown checks to 5-min loop, add daily snapshot write |
| `src/paths.ts` | Add `notifiedMilestones` and `dailySnapshot` paths |
| `src/state.ts` | Add read/write for notified milestones and daily snapshot |
| `src/types.ts` | Add schemas for `NotifiedMilestones` and `DailySnapshot` |

### No Changes Needed
| File | Reason |
|------|--------|
| `src/mcp/telegram-notify.ts` | MCP tools remain for Claude's optional use, no changes |
| `src/services/gateway.service.ts` | `sendTelegramNotification()` already exists, daemon uses it |
| `src/template.ts` | Session protocol already mentions Telegram in step 7 |

---

## Notification Summary

| Type | Source | Priority | Quiet Hours | Config Toggle |
|------|--------|----------|-------------|---------------|
| Trade alert (buy/sell) | broker-local MCP | normal | Suppressed | `trade_alerts` |
| Stop-loss alert | broker-local MCP | **CRITICAL** | Bypass | `stop_loss_alerts` |
| Daily digest | daemon 18:30 | normal | Suppressed | `daily_digest` |
| Weekly digest | daemon Fri 19:00 | normal | Suppressed | `weekly_digest` |
| Milestone alert | daemon 5-min loop | normal | Suppressed | `milestone_alerts` |
| Drawdown alert | daemon 5-min loop | **CRITICAL** | Bypass | `drawdown_alerts` |
