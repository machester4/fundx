# Daemon Resilience Design

## Problem

The FundX daemon (`daemon.service.ts`) has no crash recovery, no session catch-up, no concurrency control, and no alerting. When it dies silently (as happened March 13–20, 2026), funds stop trading with no notification. Restarting is blocked by stale PID files.

## Design Decisions

- **Approach:** Hybrid — resilient daemon + lightweight supervisor process
- **Portability:** Node.js-only, no OS-specific supervisors (launchd/systemd)
- **Concurrency:** Strict lock per fund — one session at a time
- **Catch-up:** Only the most recent missed session per fund, within 60-minute window
- **Notifications:** Telegram alerts for all critical daemon events with 30-min dedup

## Architecture Overview

```
fundx start
    └── Supervisor (parent process)
            ├── writes ~/.fundx/supervisor.pid
            ├── monitors child via 'exit' event
            ├── restarts with exponential backoff (2s, 4s, 8s, 16s, 32s)
            ├── max 5 restarts in 10 min window, then gives up + notifies
            └── forks → Daemon (child process)
                    ├── writes ~/.fundx/daemon.pid (JSON with metadata)
                    ├── writes ~/.fundx/daemon.heartbeat every tick
                    ├── runs checkMissedSessions() on startup
                    ├── cron loop every minute with backpressure guard
                    └── per-fund lock for all operations
```

## Section 1: Supervisor Process

### New file: `src/services/supervisor.service.ts` (~50 lines)

`fundx start` calls `startSupervisor()` instead of `startDaemon()` directly.

**Behavior:**

1. Writes `~/.fundx/supervisor.pid` with its own PID
2. Forks the daemon as a child process (`child_process.fork()` pointing to daemon entry)
3. Listens for `child.on('exit')`:
   - On exit: wait `backoff` seconds, then relaunch (backoff sequence: 2s, 4s, 8s, 16s, 32s)
   - Track restart timestamps in a sliding 10-minute window
   - If 5 restarts within 10 minutes: notify via Telegram ("Daemon crashed 5 times in 10 min, giving up"), stop
   - On successful restart: notify ("Daemon recovered after crash, attempt N/5")
4. On SIGTERM/SIGINT: send SIGTERM to child → wait for child exit → remove `supervisor.pid` → exit

**Modified files:**

- `start.tsx` — calls `startSupervisor()` instead of `startDaemon()`
- `stop.tsx` — reads `supervisor.pid`, kills supervisor (which cascades to child)
- `daemon.service.ts` — `startDaemon()` no longer writes `supervisor.pid`; only writes `daemon.pid`
- `paths.ts` — add `SUPERVISOR_PID` constant

## Section 2: Robust PID File

### PID file format change

Current: plain text with PID number.
New: JSON with metadata.

```json
{ "pid": 92318, "startedAt": "2026-03-20T12:16:31Z", "version": "0.1.0" }
```

### Improved `isDaemonRunning()`

1. Read PID file → parse JSON
2. Check process exists: `process.kill(pid, 0)`
3. Verify process is actually fundx: `ps -p <pid> -o command` must contain `fundx`
4. If process doesn't exist or isn't fundx → delete stale PID file → return `false`

### Heartbeat file: `~/.fundx/daemon.heartbeat`

Updated every cron tick (every minute):

```json
{ "timestamp": "2026-03-20T13:00:00Z", "fundsChecked": 4 }
```

`isDaemonRunning()` additionally checks heartbeat:
- If PID exists but heartbeat is older than 3 minutes → daemon is hung → report as dead

**Modified files:**

- `daemon.service.ts` — `isDaemonRunning()`, `startDaemon()`, cron callback (heartbeat update)
- `paths.ts` — add `DAEMON_HEARTBEAT` constant

## Section 3: Fund Lock (Per-Fund Mutex)

### New file: `src/lock.ts` (~40 lines)

Prevents concurrent operations on the same fund (sessions, stop-loss, portfolio sync).

**Lock file:** `~/.fundx/funds/<name>/state/.lock`

```json
{ "pid": 92318, "session": "pre_market", "since": "2026-03-20T12:00:00Z" }
```

**API:**

- `acquireFundLock(fundName: string, sessionType: string): Promise<boolean>` — returns `true` if acquired, `false` if already locked
- `releaseFundLock(fundName: string): Promise<void>` — always called in `finally` block
- `isLockStale(fundName: string): Promise<boolean>` — lock older than 30 minutes or owning process dead → stale, auto-cleaned

**Behavior in daemon loop:**

- `runFundSession()` → `acquireFundLock()` → if fails, log "Skipping pre_market for X: mid_session still running"
- `checkStopLosses()` → same pattern
- `syncPortfolio()` → same pattern

**Modified files:**

- `daemon.service.ts` — wrap sessions/stop-loss/sync with lock acquire/release
- `paths.ts` — add `fundLockFile(name)` helper

## Section 4: Catch-up for Missed Sessions

### Function: `checkMissedSessions()` in `daemon.service.ts`

Called once at the start of `startDaemon()`, after writing PID and heartbeat.

**Algorithm:**

1. For each active fund:
   - Read `session_log.json` → get `lastSessionTimestamp`
   - Compare with fund's schedule: which sessions should have run between `lastSessionTimestamp` and `now`?
   - If gap > 0 missed sessions: identify the **most recent** one
2. Execute catch-up only if the most recent missed session was **less than 60 minutes ago**
3. Session marked as `sessionType: "catchup_pre_market"` (prefixed with `catchup_`) so Claude knows it's retroactive
4. Respects fund lock — skip if fund already has active session
5. Log: "Catch-up: running missed pre_market for 'runway-metal' (scheduled 09:00, now 09:45)"

**Telegram notification:**

- Missed sessions found: "Daemon recovered. Missed sessions: runway-metal (pre_market, mid_session). Running catch-up for mid_session."
- No missed sessions: "Daemon started. No missed sessions."

**Modified files:**

- `daemon.service.ts` — new `checkMissedSessions()` function, called in `startDaemon()`
- `types.ts` — optional: catch-up tolerance config field

## Section 5: Log Rotation and Notifications

### Log rotation

Function: `rotateLogIfNeeded()` in `daemon.service.ts`

- Called on `startDaemon()` and once daily at midnight
- If `daemon.log` exceeds **5 MB**: rename to `daemon.log.1` (shifting existing `.1` → `.2`, `.2` → `.3`)
- Keep max **3 rotated files** — oldest deleted
- Simple, no external dependencies

### Daemon event notifications

Function: `notifyDaemonEvent(event: string, details: string)` in `daemon.service.ts`

Sends Telegram message to owner's chat_id directly (using grammy, not MCP server, since this runs inside the daemon process).

**Events:**

| Event | Message example |
|-------|----------------|
| Crash + recovery | "Daemon crashed and restarted (attempt 2/5)" |
| Max restarts exceeded | "Daemon crashed 5 times in 10 min. Stopped. Manual restart needed." |
| Missed sessions detected | "Recovered. Missed: runway-metal (pre_market, mid_session). Catching up mid_session." |
| Session lock conflict | "Skipped post_market for prueba: pre_market still running (started 25 min ago)" |
| Repeated API failures | "Alpaca API failing for 'prueba' — 3 consecutive errors" |
| Stop-loss failure | "Stop-loss check failed for runway-metal: [error]" |

**Dedup:** In-memory `lastAlertByType: Map<string, Date>` — minimum 30 minutes between alerts of the same type.

**Modified files:**

- `daemon.service.ts` — `rotateLogIfNeeded()`, `notifyDaemonEvent()`
- `supervisor.service.ts` — notifies on crash/recovery/max-restarts
- `paths.ts` — constants for `DAEMON_LOG_MAX_SIZE` (5MB), `DAEMON_LOG_MAX_FILES` (3)

## Section 6: Async Safety and Error Handling

### Backpressure guard

Flag `isProcessing = false` at daemon scope:
- Start of tick: if `isProcessing`, skip with log "Previous tick still processing, skipping"
- End of tick: `isProcessing = false`

### Awaited sessions with timeout

Replace fire-and-forget `.catch()` with structured execution:

```
each minute:
  if (isProcessing) return
  isProcessing = true
  updateHeartbeat()

  funds = listFundNames()
  await Promise.allSettled(funds.map(async fund => {
    if (!shouldRun(fund, now)) return
    if (!acquireFundLock(fund, sessionType)) return
    try {
      await withTimeout(runFundSession(fund, type), 20min)
      await syncPortfolio(fund)   // if scheduled
      await checkStopLosses(fund) // if during market hours
    } finally {
      releaseFundLock(fund)
    }
  }))

  isProcessing = false
```

- Funds run in **parallel** (`Promise.allSettled`) — one slow fund doesn't block others
- Operations within a fund run **sequentially** — protected by lock
- `withTimeout()` prevents hung sessions from holding a lock forever

### Error tracking

- `errorCounts: Map<string, number>` tracks consecutive failures per fund+type
- After 3 consecutive failures of the same type: notify via Telegram (with dedup)
- On success: reset counter
- If `log()` itself fails (disk full): fallback to `console.error`, never swallow

**Modified files:**

- `daemon.service.ts` — complete refactor of cron callback

## Files Summary

### New files

| File | Purpose | ~Lines |
|------|---------|--------|
| `src/services/supervisor.service.ts` | Parent process that forks/restarts daemon | ~50 |
| `src/lock.ts` | Per-fund mutex (acquire/release/stale check) | ~40 |

### Modified files

| File | Changes |
|------|---------|
| `src/services/daemon.service.ts` | PID JSON format, heartbeat, backpressure guard, fund locks, catch-up, log rotation, notifications, refactored cron loop |
| `src/paths.ts` | New constants: `SUPERVISOR_PID`, `DAEMON_HEARTBEAT`, `fundLockFile()`, log rotation constants |
| `src/types.ts` | Optional catch-up config schema |
| `src/commands/start.tsx` | Call `startSupervisor()` instead of `startDaemon()` |
| `src/commands/stop.tsx` | Kill supervisor PID instead of daemon PID |

### Not modified

- `session.service.ts` — no changes needed, timeout is handled at daemon level
- `gateway.service.ts` — lifecycle already tied to daemon, supervisor handles crash recovery
- `state.ts` — atomic writes already in place
- MCP servers — untouched
