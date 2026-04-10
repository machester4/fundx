# Daemon Token Refresh

**Date:** 2026-04-10
**Status:** Draft

## Summary

Detect expired OAuth tokens in the daemon and trigger automatic restart via the supervisor, so autonomous sessions recover from auth failures without manual intervention.

## Problem

The daemon inherits `CLAUDE_CODE_OAUTH_TOKEN` when forked by the supervisor. This token expires after several hours. When it expires, all autonomous sessions fail silently with `status: "error"`, 0 tokens, 0 turns, empty summary. The daemon continues running and scheduling sessions that all fail.

## Solution

### 1. Detect Auth Failure in Session Runner

In `src/services/session.service.ts`, after a session completes, check for the auth failure signature: `status === "error"` AND `tokens_in === 0` AND `tokens_out === 0` AND `num_turns === 0`. This pattern means the Agent SDK couldn't even start (auth failure, not a runtime error).

When detected:
- Log it as a probable auth failure
- Write a restart flag file at `~/.fundx/daemon.needs-restart`
- Send a Telegram notification: "Daemon: session failed (probable token expiry). Restarting..."

### 2. Supervisor Watches for Restart Flag

In `src/services/supervisor.service.ts`, the supervisor's `launchDaemon()` loop already watches for child exit. Add a periodic check (every 60 seconds) for `~/.fundx/daemon.needs-restart`:
- If the file exists, kill the current daemon child
- Delete the flag file
- The existing restart logic will re-launch the daemon
- The new daemon inherits the supervisor's current `process.env` (which has the same token — see point 3)

### 3. Dashboard Refreshes Supervisor Token

When the user opens `fundx` (dashboard), `forkSupervisor()` is called. If the supervisor is already running but has a stale token, it can't pass a fresh one to the daemon.

Fix: `forkSupervisor()` checks if the supervisor is running. If it is, and `daemon.needs-restart` exists, kill the old supervisor and fork a new one (which inherits the fresh token from the current Claude Code session).

### 4. Restart Flag Path

Add `DAEMON_NEEDS_RESTART` path constant to `src/paths.ts`:
```
~/.fundx/daemon.needs-restart
```

A simple empty file — its existence is the signal. Deleted after the restart.

## Detection Logic

```
Session completes with:
  status === "error"
  AND (tokens_in ?? 0) === 0
  AND (tokens_out ?? 0) === 0
  AND (num_turns ?? 0) === 0
→ Auth failure detected
→ Write daemon.needs-restart
→ Send Telegram notification
```

This pattern is specific to auth failures. Runtime errors (bad prompt, timeout, max turns) always have `tokens > 0` or `num_turns > 0`.

## Files to Modify

| File | Changes |
|------|---------|
| `src/paths.ts` | Add `DAEMON_NEEDS_RESTART` path constant |
| `src/services/session.service.ts` | Detect auth failure pattern, write restart flag, notify |
| `src/services/supervisor.service.ts` | Periodic check for restart flag, kill and re-launch daemon |
| `src/services/supervisor.service.ts` | `forkSupervisor()` kills stale supervisor when restart flag exists |

## Edge Cases

- **Multiple funds fail simultaneously**: Each writes the same flag file — idempotent, one restart suffices.
- **Restart during active session**: The supervisor kills the daemon mid-session. The session is lost but would have failed anyway (no auth). Next launch retries.
- **Supervisor also has stale token**: The supervisor inherits the same expired token. The dashboard's `forkSupervisor()` is the only way to inject a fresh token — requires the user to open fundx from a Claude Code session.
- **No Claude Code running**: If the user doesn't open Claude Code, there's no fresh token. The daemon stays dead after max restart attempts. This is expected — the subscription auth requires Claude Code to be active.
