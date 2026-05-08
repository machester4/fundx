# Phase 4 — Operational Observability (G6) — Design

**Date:** 2026-05-07
**Status:** Approved (brainstorm complete; ready for writing-plans)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Replaces stub:** [phase-4 stub (2026-04-27)](./2026-04-27-harness-phase-4-design.md)
**Closes gap:** G6 — no external supervisor / no daily-fund cap / weak operational visibility
**Patterns enforced:** operational layer (above the canonical 12)

---

## Goal

Add four capabilities on top of the existing supervisor + daemon + heartbeat
infrastructure, without changing agent behaviour:

1. **Append-only per-fund session log** (`session_log.jsonl`) — full audit trail
   of session metadata, source of truth for daily aggregation.
2. **Daily-per-fund USD cap** — extends Phase 1a's per-session cap to a daily
   envelope. Hard block + one-shot Telegram alert when crossed.
3. **Stale heartbeat watch** — supervisor proactively alerts via Telegram when
   the daemon's heartbeat is older than 3 minutes; one-shot + recovery alert.
4. **Status UI extension** — `fundx status` shows today's USD spend per fund
   with cap percentage and visual threshold colors.

Plus: `docs/operations.md` runbook for operators (alert glossary, common ops,
escalation triggers).

## Non-goals

- Web dashboard (terminal-only).
- Multi-host clustering / centralized metrics.
- Persistent metrics database (the JSONL is the only new persistence).
- Reimplementing supervisor in another language (it already exists in TypeScript).

---

## Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Supervisor (existing) ─────► Heartbeat watch (NEW)                  │
│       └─► fork daemon                  └─► setInterval 60s           │
│                                            └─► > 3 min stale → alert │
│                                                                      │
│  Daemon (existing) ────► runFundSession (existing)                   │
│       │                       ▲                                      │
│       │                       │ pre-session check (NEW)              │
│       │            ┌──────────┴───────────┐                          │
│       │            │ Daily cap enforced?  │                          │
│       │            │ (sum today JSONL)    │                          │
│       │            └──────────┬───────────┘                          │
│       │                       │                                      │
│       └─► writes session_log.json (existing)                         │
│              └─► appends session_log.jsonl (NEW)                     │
│                                                                      │
│  fundx status (existing) ────► reads daily aggregate (NEW)           │
│                                                                      │
│  docs/operations.md (NEW) ────► runbook                              │
└──────────────────────────────────────────────────────────────────────┘
```

**Tech**: TypeScript ESM strict; append-only writes via `fs/promises.appendFile`
(atomic for line-sized writes per fund file); budget cascade extends Phase 1a's
`resolveBudget`; alerts via existing `notifyDaemonEvent`.

---

## Component 1 — Session log JSONL

**New file**: `~/.fundx/funds/<name>/state/session_log.jsonl` — append-only,
one `SessionLogV2` record per line.

**Write path**: in `runFundSession` (`src/services/session.service.ts`), the
existing `await writeSessionLog(fundName, log)` call (line ~346) is followed
by a new `await appendSessionLogEntry(fundName, log)` call. Same payload.

**Read path**: new helper `readTodaysSessionUsage(fundName)` in
`src/services/session-history.service.ts` (NEW file). Streams the JSONL
filtered by `started_at >= midnight UTC`. Returns `{ totalUsd, sessionCount, entries }`.

**Why JSONL and not a JSON array**:
- POSIX `appendFile` is atomic for writes < `PIPE_BUF` (~4 KB on macOS/Linux).
  A typical `SessionLogV2` line is 200-500 bytes — well within the limit.
- Concurrent appends across funds don't race (each fund has its own file).
- Stream-friendly read avoids parsing the entire array on every check.

**Rotation**: a daily cron tick in the daemon (alongside auto-reports) runs
`pruneSessionLogJsonl(fundName, retentionDays = 90)`. Implementation: read all
lines, filter by `started_at >= now - 90d`, atomically rewrite (tmp + rename).

**Schema**: re-uses `sessionLogV2Schema` exactly. The schema gets ONE addition
in Component 2: `"skipped_daily_cap"` added to the `status` enum.

**Tests** (`tests/session-history.test.ts`):
- `appendSessionLogEntry` + `readTodaysSessionUsage` round-trip
- multiple appends preserve order
- daily filter excludes records from previous day (mtime-independent — uses
  `started_at` field)
- prune removes old entries, preserves recent
- handles empty file (returns empty result, no crash)
- handles malformed line (skip + log warning, don't crash)

---

## Component 2 — Daily cap config + enforcement

### Schema extension

`src/types.ts` — `budgetSchema` gains an optional `daily_cap_usd: z.number().positive().optional()` field.

`sessionLogV2Schema.status` enum gains `"skipped_daily_cap"`.

### Cascade resolution

Phase 1a's `resolveBudget(fundConfig, globalConfig, sessionType)` already
resolves `maxTurns` and `maxBudgetUsd` via the cascade:

```
fund.budget.<field> ?? global.budget.<field> ?? DEFAULTS.<field>
```

We extend the same function with a new field `dailyCapUsd`. Default value:
`DEFAULTS.dailyCapUsd = 5` (USD/day/fund — conservative starting point).

### Enforcement

In `runFundSession`, BEFORE the SDK invocation:

```typescript
const todayUsage = await readTodaysSessionUsage(fundName);
const cap = budget.dailyCapUsd;
if (todayUsage.totalUsd >= cap) {
  const skipLog: SessionLogV2 = {
    fund: fundName,
    session_type: sessionType,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    trades_executed: 0,
    summary: `Skipped: daily cap $${cap} reached ($${todayUsage.totalUsd.toFixed(2)} used in ${todayUsage.sessionCount} sessions)`,
    cost_usd: 0,
    status: "skipped_daily_cap",
    budget_resolved: budget,
  };
  await writeSessionLog(fundName, skipLog);
  await appendSessionLogEntry(fundName, skipLog);
  await notifyDailyCapReached(fundName, cap, todayUsage);
  return;
}
```

The skip is logged to BOTH `session_log.json` (last-session) AND the JSONL.
Logging the skip in the JSONL would normally inflate `totalUsd` — but
`cost_usd: 0` for skipped sessions means it's a no-op for tomorrow's
calculation.

### Telegram alert (`notifyDailyCapReached`)

One-shot per day per fund. Dedup state lives in
`~/.fundx/funds/<name>/state/daily_cap_state.json`:

```json
{ "alerted_for_date": "2026-05-07" }
```

If `alerted_for_date` !== today, send the alert and update the file.

Alert text:
> ⚠️ Fund X reached daily cap $5 ($5.32 used in 7 sessions). Sessions will resume at 00:00 UTC tomorrow.

### Reset

Implicit — at midnight UTC, the JSONL filter excludes yesterday's records, so
today's `totalUsd` resets to 0 naturally. The `daily_cap_state.json` dedup file
is also cleared by the daily cron tick (alongside JSONL prune).

### Tests (`tests/daily-cap.test.ts`)

- below cap → session runs normally
- exactly at cap → session skipped + status logged + alert sent
- above cap → session skipped + alert sent
- alert dedup: 2 skips same day → 1 Telegram message
- midnight rollover → next session can run again (mock `Date.now`)
- cascade: fund overrides global; global overrides default
- skip is logged to both `session_log.json` and JSONL with `cost_usd: 0`

---

## Component 3 — Heartbeat watch (supervisor extension)

### Location

Extend `startSupervisor()` in `src/services/supervisor.service.ts`. The function
already has a `setInterval(60_000, ...)` for `restartCheckInterval`. We add
a SECOND interval (separate concern, separate function) for heartbeat freshness.

### Logic

```typescript
let heartbeatAlerted = false;  // in-memory; resets on supervisor restart
let daemonLaunchedAt = Date.now();  // updated on each launchDaemon()

const heartbeatCheckInterval = setInterval(async () => {
  if (stopping) return;

  let stale = false;
  let ageMs = 0;

  if (existsSync(DAEMON_HEARTBEAT)) {
    try {
      const hbStat = await stat(DAEMON_HEARTBEAT);
      ageMs = Date.now() - hbStat.mtimeMs;
      stale = ageMs > 3 * 60 * 1000;
    } catch {
      stale = true;  // read error → treat as stale
    }
  } else {
    // No heartbeat file: grace period of 3 min from daemon launch
    stale = currentChild ? (Date.now() - daemonLaunchedAt > 3 * 60 * 1000) : false;
  }

  if (stale && !heartbeatAlerted) {
    const { notifyDaemonEvent } = await import("./daemon.service.js");
    await notifyDaemonEvent(
      "Daemon heartbeat stale",
      `Heartbeat ${Math.round(ageMs / 1000)}s old. Sessions may be missed.`,
    );
    heartbeatAlerted = true;
  } else if (!stale && heartbeatAlerted) {
    const { notifyDaemonEvent } = await import("./daemon.service.js");
    await notifyDaemonEvent(
      "Daemon heartbeat recovered",
      "Heartbeat fresh again after stale period.",
    );
    heartbeatAlerted = false;
  }
}, 60_000);

process.on("SIGTERM", () => clearInterval(heartbeatCheckInterval));
process.on("SIGINT", () => clearInterval(heartbeatCheckInterval));
```

### Why supervisor and not daemon

If the daemon's event loop is blocked (deadlock, hung MCP call), it cannot
detect its own staleness. The supervisor is a separate process that already
monitors daemon liveness — it is the natural location for proactive checks.

### State persistence

`heartbeatAlerted` is in-memory only. If the supervisor restarts, the flag
resets — that is acceptable, because supervisor restart usually means the
daemon was just restarted too (fresh state warranted).

### Tests (`tests/supervisor-heartbeat.test.ts`)

- fresh heartbeat (mtime < 3 min ago) → no alert
- stale heartbeat (mtime > 3 min ago) → alert + flag set
- still stale on next tick → no duplicate alert
- recovers (heartbeat updated) → recovery alert + flag cleared
- no heartbeat file + daemon recently started → no alert (grace period)
- no heartbeat file + daemon running > 3 min → alert
- read error on heartbeat file → treated as stale

---

## Component 4 — Status UI extension

### New service helper

In `src/services/status.service.ts`:

```typescript
export interface FundDailyUsage {
  totalUsd: number;
  sessionCount: number;
  cap: number;
  pct: number;  // totalUsd / cap * 100
  capped: boolean;  // pct >= 100
}

export async function getDailyUsagePerFund(): Promise<Map<string, FundDailyUsage>>;
```

For each fund: reads `session_log.jsonl`, filters by today, sums `cost_usd`,
resolves cap via cascade, computes pct.

### UI changes

`src/components/FundsOverviewPanel.tsx` (or its cell renderer): add a "Today"
column. Color thresholds:

| pct | Color | Indicator |
|---|---|---|
| `< 50%` | DIM | (none) |
| `50-80%` | default | (none) |
| `80-99%` | YELLOW | ⚠️ |
| `>= 100%` | RED | "CAPPED" 🔴 |

### Display format (per fund row)

```
fundx-audit    active   $4,611  +2.0%   today: $2.34/$5 (47%)
fundx-runway   active   $9,200  -1.2%   today: $4.95/$5 (99% ⚠️)
fundx-growth   paused   $5,000  +0.0%   today: CAPPED ($5.12/$5) 🔴
```

### Heartbeat already shown

The existing `SystemInfo.heartbeat` rendering needs no change — Component 3
handles the proactive alert; the dashboard already displays freshness.

### Tests (`tests/status-daily-usage.test.ts`)

- fund with no sessions today → `totalUsd=0`, `pct=0`
- fund with 3 sessions summing $2.34 → matches
- fund at exact cap → `pct=100`, `capped=true`
- fund over cap → `pct > 100`, `capped=true`
- multiple funds → independent counters
- cascade: per-fund cap overrides global

---

## Component 5 — Operations runbook

**New file**: `docs/operations.md` — concise, one-screen-per-section.

### Sections

1. **Starting / stopping the system** — `fundx start`, `fundx stop`, `fundx status`.
2. **Where to read logs** — `daemon.log`, `session_log.jsonl` (NEW), `analysis/`.
3. **Telegram alerts — what each means + what to do** (table — see below).
4. **Common operations** — raise daily cap, reset counter, query yesterday's spend.
5. **When to escalate (manual debug needed)** — crash loops, frozen funds, deadlock.

### Alert glossary table

| Alert | Cause | Action |
|---|---|---|
| "Daemon crashed" | Crash exit, supervisor restarting | None — wait. If 5 within 10 min → "Max restarts exceeded". |
| "Max restarts exceeded" | Supervisor gave up | `fundx stop && fundx start`. Check `daemon.log`. |
| "Daemon heartbeat stale" (NEW) | Event loop blocked > 3 min | Check daemon process. If stuck → restart. |
| "Daemon heartbeat recovered" (NEW) | Heartbeat fresh again | None — informational. |
| "Daily cap reached" (NEW) | Fund exhausted daily USD budget | Sessions skip until 00:00 UTC. To override: edit `fund.budget.daily_cap_usd`. |
| "Budget killed" (Phase 1a) | Per-session cap hit | Review session_log; consider raising session cap. |

---

## File structure summary

| Path | Type | Responsibility |
|---|---|---|
| `src/services/session-history.service.ts` | Create | `appendSessionLogEntry`, `readTodaysSessionUsage`, `pruneSessionLogJsonl` |
| `src/services/daily-cap.service.ts` | Create | `notifyDailyCapReached` (with dedup state) |
| `src/services/session.service.ts` | Modify | Pre-session cap check; append to JSONL after writeSessionLog |
| `src/services/supervisor.service.ts` | Modify | Add heartbeat watch interval |
| `src/services/status.service.ts` | Modify | `getDailyUsagePerFund` |
| `src/services/daemon.service.ts` | Modify | Daily cron tick: prune JSONL + clear daily_cap_state |
| `src/types.ts` | Modify | `budgetSchema.daily_cap_usd?`; `sessionLogV2Schema.status` enum + `"skipped_daily_cap"` |
| `src/paths.ts` | Modify | New paths: `sessionLogJsonl`, `dailyCapState` |
| `src/components/FundsOverviewPanel.tsx` | Modify | Add "Today" column |
| `src/commands/status.tsx` | Modify | Wire `getDailyUsagePerFund` into `getSystemInfo` |
| `tests/session-history.test.ts` | Create | 6 tests |
| `tests/daily-cap.test.ts` | Create | 7 tests |
| `tests/supervisor-heartbeat.test.ts` | Create | 7 tests |
| `tests/status-daily-usage.test.ts` | Create | 6 tests |
| `docs/operations.md` | Create | Runbook |

**Estimated**: ~600 LOC source + ~26 new tests.

---

## Acceptance criteria

Phase 4 is done when:

- [ ] `session_log.jsonl` written on every session end; daily cron prunes records > 90 days old.
- [ ] Daily cap enforcement: simulated fund crossing cap → next session skipped with `status: "skipped_daily_cap"` + Telegram alert (one-shot per day).
- [ ] Heartbeat watch: `kill -STOP <daemon-pid>` for > 3 min → Telegram alert from supervisor.
- [ ] Heartbeat watch: `kill -CONT <daemon-pid>` (after STOP) → recovery Telegram alert.
- [ ] `fundx status` shows today's USD per fund + percentage of cap with threshold colors.
- [ ] Cap reached UI: "CAPPED" badge in red.
- [ ] `docs/operations.md` reviewed and committed.
- [ ] Full test suite passes (~810 tests after additions, ~26 new).
- [ ] Smoke test on a real test fund: simulated cap exceedance, verify alert fires + session skipped + status reflects state.

---

## Dependencies

- **Hard**: Phase 1a's `cost_usd` field in `SessionLogV2`. Already in place.
- **Soft**: Existing supervisor heartbeat-write loop. Already in place.

No agent behaviour change. No prompt change. Pure operational layer.

---

## Effort

2-3 days, matching the original stub estimate. Distribution:
- Day 1: Components 1 + 2 (JSONL + daily cap enforcement, with TDD).
- Day 2: Components 3 + 4 (heartbeat watch + status UI).
- Day 3: Component 5 (runbook), full smoke test, audit log.

## Open items / Phase 5+ candidates (out of scope)

- **Multi-host coordination** — if FundX ever runs across multiple machines,
  the JSONL approach needs migration to a central store (SQLite or postgres).
- **Web dashboard** — terminal-only is sufficient for now.
- **Operational metrics export** — Prometheus/OpenTelemetry hooks could be
  added later if observability stack is desired.

---

## References

- Phase 1a: per-session cap (`resolveBudget`) — pattern reused for daily cap.
- Phase 3a: handoff archive — pattern reused for session_log.jsonl append + prune.
- Stub: [phase-4 stub (2026-04-27)](./2026-04-27-harness-phase-4-design.md).
