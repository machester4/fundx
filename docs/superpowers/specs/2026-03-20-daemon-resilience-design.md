# Daemon Resilience Design

## Problem

The FundX daemon (`daemon.service.ts`) has no crash recovery, no session catch-up, no concurrency control, and no alerting. When it dies silently (as happened March 13–20, 2026), funds stop trading with no notification. Restarting is blocked by stale PID files.

## Design Decisions

- **Approach:** Hybrid — resilient daemon + lightweight supervisor process
- **Portability:** Node.js-only, no OS-specific supervisors (launchd/systemd). Unix-assumed for PID validation (macOS/Linux)
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

There are currently two daemon start paths:
- `fundx start` (via `start.tsx`) — calls blocking `startDaemon()`
- Dashboard auto-start (via `commands/index.tsx`) — calls `forkDaemon()` which spawns a detached child with `--_daemon-mode`

Both are replaced by the supervisor:

**Entry points:**

- `forkSupervisor()` — replaces `forkDaemon()`. Spawns a **detached** supervisor process via `child_process.spawn()` with `--_supervisor-mode` flag, then returns immediately. Used by both `start.tsx` and the dashboard.
- `src/index.tsx` gains `--_supervisor-mode` entry point — calls `startSupervisor()` (blocking)
- `startSupervisor()` — the blocking supervisor loop (only runs inside the detached process)
- `startDaemon()` — remains blocking, but is now only called by the supervisor via `child_process.fork()` with `--_daemon-mode`

**Supervisor behavior:**

1. Writes `~/.fundx/supervisor.pid` with its own PID
2. Forks the daemon as a non-detached child process (`child_process.fork()` with `--_daemon-mode`)
3. Listens for `child.on('exit')`:
   - On exit: wait `backoff` seconds, then relaunch (backoff sequence: 2s, 4s, 8s, 16s, 32s)
   - Track restart timestamps in a sliding 10-minute window
   - If 5 restarts within 10 minutes: notify via Telegram as best-effort ("Daemon crashed 5 times in 10 min, giving up"), log to `daemon.log` as primary channel, then stop
   - On successful restart: notify ("Daemon recovered after crash, attempt N/5")
   - If Telegram notification fails, log the failure — supervisor must never crash due to notification errors
4. On SIGTERM/SIGINT: send SIGTERM to child → wait for child exit → remove `supervisor.pid` → exit

**Gateway idempotency on restart:**

When the supervisor restarts a crashed daemon, `startDaemon()` calls `startGateway()`. To handle lingering state from the crashed process, `startDaemon()` must call `stopGateway()` defensively before `startGateway()`. This ensures the grammy bot reconnects cleanly.

**Modified files:**

- `start.tsx` — calls `forkSupervisor()` (non-blocking, returns immediately)
- `stop.tsx` — reads `supervisor.pid`, kills supervisor (which cascades SIGTERM to child)
- `commands/index.tsx` — replace `forkDaemon()` with `forkSupervisor()`
- `daemon.service.ts` — `startDaemon()` calls `stopGateway()` before `startGateway()`; remove `forkDaemon()`
- `src/index.tsx` — add `--_supervisor-mode` entry point
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
3. Verify process is actually fundx: `ps -p <pid> -o command` must contain `fundx` (Unix-only, acceptable for macOS/Linux target)
4. If process doesn't exist or isn't fundx → delete stale PID file → return `false`

Note: All callers of `isDaemonRunning()` (including `hooks/useDaemonStatus.ts` and commands) go through this single function, so changing the PID file format to JSON only requires updating this function.

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
- `isLockStale(fundName: string): Promise<boolean>` — owning process dead (primary check) OR lock older than 25 minutes (safety net for hung processes, set to SDK timeout of 15 min + 10 min buffer) → stale, auto-cleaned

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

### New state file: `~/.fundx/funds/<name>/state/session_history.json`

The existing `session_log.json` stores only the last session (overwritten each time). Catch-up needs to know which session types ran and when. New file tracks the last execution per session type:

```json
{
  "pre_market": "2026-03-20T09:00:00Z",
  "mid_session": "2026-03-20T13:00:00Z",
  "post_market": "2026-03-19T18:00:00Z"
}
```

Updated by `runFundSession()` after each successful session completion. Written atomically via `writeJsonAtomic()`. Does not replace `session_log.json` — that file continues to store the full last-session metadata.

**Algorithm:**

1. For each active fund:
   - Read `session_history.json` → get last run timestamp per session type
   - Compare with fund's schedule: which sessions should have run between each type's last timestamp and `now`?
   - If gap > 0 missed sessions: identify the **most recent** one across all types
2. Execute catch-up only if the most recent missed session was **less than 60 minutes ago**
3. Session marked as `sessionType: "catchup_pre_market"` (prefixed with `catchup_`) so Claude knows it's retroactive
4. Respects fund lock — skip if fund already has active session
5. Log: "Catch-up: running missed pre_market for 'runway-metal' (scheduled 09:00, now 09:45)"

**Telegram notification:**

- Missed sessions found: "Daemon recovered. Missed sessions: runway-metal (pre_market, mid_session). Running catch-up for mid_session."
- No missed sessions: "Daemon started. No missed sessions."

**Modified files:**

- `daemon.service.ts` — new `checkMissedSessions()` function, called in `startDaemon()`
- `session.service.ts` — update `runFundSession()` to write `session_history.json` on completion
- `state.ts` — add `readSessionHistory()` / `writeSessionHistory()` helpers
- `types.ts` — `SessionHistory` schema (`Record<string, string>`) + optional catch-up tolerance config field
- `paths.ts` — add `fundSessionHistoryFile(name)` helper

## Section 5: Log Rotation and Notifications

### Log rotation

Function: `rotateLogIfNeeded()` in `daemon.service.ts`

- Called on `startDaemon()` and once daily at midnight
- If `daemon.log` exceeds **5 MB**: rename to `daemon.log.1` (shifting existing `.1` → `.2`, `.2` → `.3`)
- Keep max **3 rotated files** — oldest deleted
- Simple, no external dependencies
- Safe for concurrent writes: `log()` uses `appendFile` (open-write-close per call, no persistent file descriptor), so rotation via rename is safe

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

### Awaited operations with lock

Replace fire-and-forget `.catch()` with structured, lock-protected execution. Sessions, stop-loss checks, and portfolio sync retain their **independent schedules** (sessions at configured times, stop-loss every 5 min during market hours, sync at configured time). They are NOT nested — each acquires/releases the fund lock independently.

Utility: `withTimeout(promise, ms)` — simple `Promise.race` helper, defined in `src/lock.ts`. Acts as a safety net above the SDK's own 15-minute timeout. On timeout, the lock is released via `finally`; the underlying SDK session may still be winding down but the fund is unlocked for the next operation.

```
each minute:
  if (isProcessing) return
  isProcessing = true
  updateHeartbeat()

  funds = listFundNames()
  await Promise.allSettled(funds.map(async fund => {
    config = loadFundConfig(fund)
    if (config.status !== "active") return
    if (!isTradingDay(config, now)) return

    // 1. Scheduled sessions (independent schedule: configured times)
    for (sessionType of matchingSessions(config, currentTime)):
      if (!acquireFundLock(fund, sessionType)) continue
      try {
        await withTimeout(runFundSession(fund, sessionType), 20min)
      } finally {
        releaseFundLock(fund)
      }

    // 2. Stop-loss checks (independent schedule: every 5 min during market hours)
    if (isDuringMarketHours(now) && minute % 5 === 0):
      if (acquireFundLock(fund, "stoploss")):
        try {
          await checkAndExecuteStopLosses(fund)
        } finally {
          releaseFundLock(fund)
        }

    // 3. Portfolio sync (independent schedule: configured time)
    if (currentTime === PORTFOLIO_SYNC_TIME):
      if (acquireFundLock(fund, "sync")):
        try {
          await syncPortfolio(fund)
        } finally {
          releaseFundLock(fund)
        }
  }))

  isProcessing = false
```

- Funds run in **parallel** (`Promise.allSettled`) — one slow fund doesn't block others
- Operations within a fund are **lock-gated** — if a session is running, stop-loss/sync skip gracefully
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
| `src/services/supervisor.service.ts` | Parent process that forks/restarts daemon | ~60 |
| `src/lock.ts` | Per-fund mutex (acquire/release/stale check) + `withTimeout` utility | ~50 |

### Modified files

| File | Changes |
|------|---------|
| `src/services/daemon.service.ts` | PID JSON format, heartbeat, backpressure guard, fund locks, catch-up, log rotation, notifications, defensive `stopGateway()` before `startGateway()`, refactored cron loop, remove `forkDaemon()` |
| `src/services/session.service.ts` | Write `session_history.json` on session completion |
| `src/state.ts` | Add `readSessionHistory()` / `writeSessionHistory()` helpers |
| `src/paths.ts` | New constants: `SUPERVISOR_PID`, `DAEMON_HEARTBEAT`, `fundLockFile()`, `fundSessionHistoryFile()`, log rotation constants |
| `src/types.ts` | `SessionHistory` schema + optional catch-up config |
| `src/index.tsx` | Add `--_supervisor-mode` entry point |
| `src/commands/index.tsx` | Replace `forkDaemon()` with `forkSupervisor()` |
| `src/commands/start.tsx` | Call `forkSupervisor()` (non-blocking) instead of `startDaemon()` |
| `src/commands/stop.tsx` | Kill supervisor PID instead of daemon PID |

### Not modified

- `gateway.service.ts` — no structural changes; idempotency handled by daemon calling `stopGateway()` before `startGateway()`
- MCP servers — untouched
