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
  dailyCapUsd: 10  # default 20 (raised in Phase 5c)
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

**Caveat:** if a "Daily cap reached" alert was already sent in the last
30 minutes, the daemon's in-process alert dedup (`notifyDaemonEvent`) will
silently suppress the next one even after clearing this file. Either wait
30 minutes from the last alert, or restart the daemon (`fundx stop && fundx start`)
to reset the in-memory dedup map.

## Heartbeat smoke test (manual)

Validates the supervisor → daemon heartbeat alert path end-to-end. Run after
any daemon restart for an unrelated reason — no need to trigger one solely
for this.

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

## Meta-reflection (weekly memory consolidation)

The daemon runs `meta_reflection` per active fund every Sunday at 18:00 UTC. It distills recent handoffs and journal entries into `memory/*.md`.

### Verifying it ran

Per fund, look at `state/last_consolidation.json` — should show `last_run_iso` within the past week and `status: "success"` (or `"no_data"` if the fund had no new activity). Memory files (`memory/*.md`) should grow over time across weeks. The `state/session_log.jsonl` should contain a `session_type: "meta_reflection"` entry from last Sunday.

### Backfill on existing funds

For funds with a large handoff archive that pre-dates the feature, run `fundx fund consolidate <name>`. The first run processes everything; subsequent weekly runs only see new handoffs. Watch cost in `state/last_consolidation.json` after the first run.

### Failure modes

- `status: "error"` — the cursor is NOT advanced, next Sunday will retry. Inspect the `error` field. If error is persistent (3 consecutive weeks), force-advance by deleting `state/last_consolidation.json` (next run starts from epoch) or by editing `cursor_iso` to a recent timestamp.
- `status: "skipped_daily_cap"` — the fund's daily cap is exhausted. The Sunday slot is normally idle (market closed); investigate whether another job ran heavy on that day.
- `status: "no_data"` — expected when a fund had no new sessions or trades since the last consolidation. Not a failure.
