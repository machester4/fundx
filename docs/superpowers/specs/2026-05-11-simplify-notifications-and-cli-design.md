# Simplify Notifications and CLI — Design

**Date:** 2026-05-11
**Status:** Approved (sections 1–5 validated in conversation)
**Scope:** Remove Telegram entirely (notifications + bidirectional gateway). Replace outbound alerts with OS-native notifications for a small set of critical events. Cut the CLI surface from ~50 commands to 13, leaving only what the autonomous agent cannot do.

## Motivation

FundX accumulated two layers of surface that no longer pay for themselves:

1. **Telegram** was added in Phase 3 as the remote interaction channel (mobile alerts + bidirectional "wake Claude" flow). In day-to-day single-user operation, the chat REPL in the dashboard already covers interaction, and the user explicitly accepts losing the mobile/remote capability in exchange for a simpler system. Telegram requires a bot token, a long-running gateway process, authorization middleware, quiet-hours handling, and 5 distinct outbound MCP tools — none of which earns its keep when the user is at their machine.
2. **CLI breadth** grew alongside features: separate commands for every read view (`portfolio`, `trades`, `performance`, `chart/*`, `correlation`, `news/*`, `screen/*`, `report/*`) and every generator (`screen/run`, `news/fetch`, `montecarlo/run`, `report/{daily,weekly,monthly}`). The chat REPL inside the dashboard can now answer all of these in natural language, making the dedicated commands redundant — and confusing, because users have to remember which command exists.

The simplification trades remote/mobile reach and breadth-of-CLI for a system that is easier to reason about, easier to maintain, and easier to onboard.

## Non-goals

- Not adding a new remote channel (no email, no web UI, no push service). If the user wants remote access in the future, that is a separate project.
- Not changing the autonomous agent's analysis/decision behavior. The skills, rules, sub-agents, and session pipeline stay intact — only the notification fanout and the CLI shell around them change.
- Not migrating data: trade journals, session logs, handoffs, and per-fund state files stay untouched.

## Architecture changes

### Notifications

A new module `src/services/notify.service.ts` becomes the single fanout point for OS-native notifications. It uses `node-notifier` (cross-platform; on macOS uses the native notification center via NSUserNotification / terminal-notifier shim).

**Public API:**

```ts
notifyTrade(fund: string, side: "buy" | "sell", ticker: string, qty: number, price: number): void
notifyStopLoss(fund: string, ticker: string, trigger: number, action: string): void
notifyDailyCap(fund: string, capUsd: number, spentUsd: number): void
notifySupervisorStale(fund: string, lastHeartbeatAt: Date): void
notifyHandoffMissing(fund: string, sessionType: string): void
```

**Critical architectural shift:** the agent stops emitting notifications. Today the agent calls `mcp__telegram-notify__send_*` from inside the SDK session loop. With OS notifications, the daemon and services observe events and emit. The agent's job ends at "wrote a clean handoff and journal entry"; the system surfaces the user-visible signal.

**Event sources that call `notify.service`:**

| Event | Source | Trigger |
|---|---|---|
| Trade executed | daemon (journal watcher) | new row in `trade_journal.sqlite` since last poll |
| Stop-loss fired | `src/stoploss.ts` | post-execution |
| Daily cap reached | `src/services/daily-cap.service.ts` | `checkDailyCap()` reaches threshold |
| Supervisor stale | `src/services/supervisor.service.ts` | heartbeat > 3 min stale |
| Handoff missing | `src/services/handoff-tracker.ts` | Stop hook detects no fresh handoff after success |

**Journal watcher:** the daemon polls `trade_journal.sqlite` (per fund) every 5 seconds and emits trade notifications for rows newer than its last-seen cursor. The cursor persists at `~/.fundx/funds/<name>/state/last_notify_cursor.json` (last `trade_id` notified). On restart, the watcher resumes from the cursor; duplicate suppression by `trade_id` guarantees each trade fires exactly one OS notification across restarts. This decouples notification from the `broker-local` MCP child process — the MCP no longer imports any notify code.

**Quiet hours:** `config.notifications.quiet_hours` (start/end UTC) suppresses non-priority notifications. Stop-loss and supervisor-stale always bypass quiet hours (priority="high"). Other categories suppress silently.

**Config schema (`src/types.ts`):**

```ts
notifications: {
  enabled: boolean       // default true
  quiet_hours?: {
    start: string        // "22:00" UTC
    end: string          // "07:00" UTC
  }
}
```

No `telegram_*` fields remain.

### Telegram removal

**Files deleted:**
- `src/mcp/telegram-notify.ts`
- `src/mcp/broker-local-notify.ts`
- `src/services/gateway.service.ts`
- `src/commands/gateway/start.tsx`
- `src/commands/gateway/test.tsx`
- Test files: `tests/gateway.*` and any `telegram-*` tests

**Files updated:**
- `src/types.ts` — drop `auth.telegram`, `gateway`, all `notifications.telegram_*` fields
- `src/paths.ts` — drop telegram MCP paths/constants
- `src/agent.ts` (`buildMcpServers`) — remove telegram-notify from MCP list
- `src/services/daemon.service.ts` — remove gateway bootstrap; daemon now only runs scheduler + journal watcher + supervisor + meta-reflection cron + report cron
- `src/services/init.service.ts` — remove Telegram wizard step (token/chat_id); update workspace `CLAUDE.md` generation
- `src/services/status.service.ts` — drop telegram status field
- `src/components/SystemStatusPanel.tsx` — drop "Telegram" row
- `src/mcp/broker-local.ts` — remove import/calls to `broker-local-notify`
- `src/services/daily-cap.service.ts` — replace Telegram calls with `notify.service`
- `src/services/supervisor.service.ts` — same
- `src/services/session.service.ts` — same (budget-kill alerts)
- `src/services/handoff-tracker.ts` — same
- `src/services/news.service.ts` — drop any Telegram fanout (news no longer notifies)
- `src/services/chat.service.ts` — remove Telegram mode/context refs
- `src/services/eval/seed.ts` — drop Telegram mocking
- `src/skills.ts` — purge Telegram references from `FUND_RULES.communication`, `session-init`, `session-completion`, and any skill that names `mcp__telegram-notify__*`
- `src/template.ts` — remove Telegram MCP listing and Communicate-via-Telegram phrasing from per-fund `CLAUDE.md`

**Project-root `CLAUDE.md` updates:**
- Mark Phase 3 (Telegram) as removed/superseded in roadmap
- Drop Telegram Gateway from "High-Level Flow"
- Drop `telegram-notify`, `gateway/*` from "Source Structure"
- Drop `grammy` from "Tech Stack"
- Drop Phase 3 Telegram bullets

**Dependencies (`package.json`):**
- Remove: `grammy`, `@grammyjs/*` (if any)
- Add: `node-notifier`

### CLI surface

**Final command set (13):**

```
fundx init                              # workspace setup wizard

fundx fund create <name>                # create fund (human-driven, destructive)
fundx fund delete <name>                # destroy fund (human-driven, destructive)
fundx fund upgrade [--all|--name <n>]   # re-render skills/rules/templates after src/skills.ts change
fundx fund consolidate <name>           # ad-hoc meta-reflection backfill
fundx fund refresh-universe <name>      # recompute universe manually

fundx start                             # start daemon
fundx stop                              # stop daemon

fundx status                            # TUI dashboard + chat REPL (the universal console)

fundx session run <fund>                # force-trigger an autonomous session

fundx sws login                         # Simply Wall St auth (human-required)
fundx sws logout
fundx sws status

fundx eval [...]                        # dev/CI eval harness
```

**Final layout of `src/commands/`:**

```
src/commands/
  index.tsx                       # default — dashboard + chat REPL
  init.tsx
  start.tsx
  stop.tsx
  session/run.tsx
  fund/
    create.tsx
    delete.tsx
    upgrade.tsx
    consolidate.tsx
    refresh-universe.tsx
  sws/
    login.tsx
    logout.tsx
    status.tsx
  eval.tsx
```

**Deleted commands (~37):**

| Group | Commands |
|---|---|
| Read views (covered by chat) | `ask`, `portfolio`, `trades`, `performance`, `logs`, `chart/{allocation,pnl,sparkline}`, `correlation`, `report/view`, `news/{list,search,stats}`, `screen/{watchlist,trajectory,tag}`, `fund/{list,info,show-universe}` |
| Generators (agent invokes via tools) | `screen/run`, `news/fetch`, `report/{daily,weekly,monthly}`, `montecarlo/run` |
| Config (file-editable) | `special/{add,list,remove}`, `template/{list,builtin,export,import}`, `fund/clone` |
| Telegram (removed) | `gateway/{start,test}` |

**Important:** the underlying services (`chart.service.ts`, `correlation.service.ts`, `montecarlo.service.ts`, `reports.service.ts`, `screening.service.ts`, `news.service.ts`, `templates.service.ts`, `special-sessions.service.ts`) stay. Only the command layer (`.tsx` files in `src/commands/`) is removed. The autonomous sessions and the chat REPL still call those services directly.

**Operational coverage for removed commands:**
- `logs` → `tail -f ~/.fundx/daemon.log`
- `special/*` → edit `fund_config.yaml`'s `special_sessions` section
- `template/*` → edit YAML in `~/.fundx/shared/templates/`; `fund create` already supports `--template <path>`
- `fund/list`, `fund/info` → dashboard shows them on open
- `fund/clone` → use `fund create` with `--template <existing-fund-path>` or copy `fund_config.yaml`

### Skills / rules / template updates

**`src/skills.ts`:**
- `FUND_RULES.communication` — rewrite: "Persist analysis, journal, and reports in English. OS notifications are emitted by the system; you do not call any notify MCP." Chat replies still mirror user language.
- `FUND_RULES.session-init` — drop Telegram-related Orient steps if any.
- `FUND_RULES.session-completion` — replace "send daily digest via Telegram" with "ensure handoff is complete; the system surfaces critical events".
- Skills `session-reflection`, `risk-assessment`, `trade-memory` — grep for `mcp__telegram-notify__` and remove.
- Workspace skill `create-fund` — drop Telegram setup question.

**`src/template.ts`:**
- Remove the MCP listing line for `telegram-notify`
- Remove the "Communicate" phase mention of Telegram bot
- Reformulate Communicate phase: "Critical events (trades, stop-loss, supervisor) are notified by the system automatically. Your responsibility is the handoff."

**Workspace `CLAUDE.md` (generated in `init.service.ts`):**
- Drop gateway section
- Replace CLI command catalog with the 13-command list above

**`assistant-behavior.md` (workspace rule):**
- Remove the "Telegram question → wake fund" pattern guidance

### Tests

- `tests/skills.test.ts` — update assertions that reference Telegram text in skills/rules (remove those assertions)
- `tests/template.test.ts` — same
- `tests/eval/cases/` — grep for `telegram` in case YAMLs; remove any `must_invoke: mcp__telegram-notify__*` expectations (unlikely to exist; cases are mostly `must_not_invoke`)
- New: `tests/notify.test.ts` — unit-test the new `notify.service` (mock `node-notifier`, assert quiet-hours suppression, assert priority bypass)

## Migration

**For the user (single end-to-end procedure):**

```bash
fundx stop                      # stop daemon (kills gateway too)
git pull && pnpm install        # update code + deps
pnpm build                      # compile
fundx fund upgrade --all        # re-render skills/rules/templates for every fund
fundx start                     # restart daemon (scheduler + journal watcher, no gateway)
```

**Config compatibility:**
- The Zod schemas for `config.yaml` (workspace) and `fund_config.yaml` (per-fund) switch from strict to `.strip()`, so unknown fields (`auth.telegram`, `gateway`, `notifications.telegram_*`) are silently dropped at load time. On the next config write, they disappear.
- No migration script needed.

**Orphan state files (left in place, harmless):**
- `~/.fundx/funds/*/state/last_*_alert.json` — old Telegram one-shot guards; new code creates analogous SO-notification one-shot files (`last_*_so_alert.json`) so we don't double-fire on restart.
- `~/.fundx/daemon.log`, `~/.fundx/funds/*/state/session_log.jsonl` — untouched.

**Verification post-migration:**
1. Smoke: run `fundx session run fundx-audit` → confirm an OS notification fires when the session executes a trade.
2. Run MVP eval suite: `pnpm dev -- eval --filter mvp-` → all 8 cases pass (suite does not depend on Telegram).
3. `fundx status` → SystemStatusPanel shows no Telegram row; daemon row reflects scheduler-only state.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| User loses mobile/remote reach for emergencies | Explicit user decision (recorded in conversation). Stop-loss + supervisor-stale always bypass quiet hours so the user is alerted at the machine. |
| OS notification reliability (macOS Focus modes, Linux notify-daemon variations) | `node-notifier` is the most mature cross-platform option. Fallback: log to `~/.fundx/daemon.log` with `NOTIFY:` prefix so a `tail -f` reveals events even if the OS swallows them. |
| Journal watcher misses a trade if daemon crashes between row insert and notify | Watcher persists last-seen `trade_id` cursor per fund (see Notifications section). On restart, picks up from the cursor and re-checks the next row only. Duplicate suppression by `trade_id` makes it effectively exactly-once. |
| User invokes a removed command and gets a cryptic "command not found" | Pastel's default error handler is acceptable. Document the new surface in workspace `CLAUDE.md`; users open the dashboard and ask the chat instead. |
| Skills/rules/CLAUDE.md still mention Telegram after upgrade | `fund upgrade --all` re-renders all `.claude/` files and the per-fund `CLAUDE.md` from scratch — old content is fully replaced, not patched. Add a regression test asserting no rendered skill, rule, or `CLAUDE.md` file contains the string "telegram" (case-insensitive). |

## Out of scope (deferred)

- New chat tools for "run a session now" / "consolidate" — `session run`, `fund consolidate`, `fund refresh-universe` stay as CLI; chat can still describe and explain, just doesn't trigger.
- Per-event notification customization (sound, urgency level). Defaults are fine.
- Web dashboard / email digest. Out of scope.

## Implementation order (high-level)

1. Build `notify.service` + `node-notifier` integration + tests (no callers wired yet).
2. Wire `daily-cap`, `supervisor`, `session` (budget-kill), `handoff-tracker` to `notify.service`. Keep Telegram code in place but unused.
3. Build journal watcher in daemon; wire trade + stop-loss notifications.
4. Delete Telegram code (MCP, gateway, commands, types, paths, schema fields).
5. Delete CLI commands per the table above.
6. Update `src/skills.ts`, `src/template.ts`, workspace `CLAUDE.md`, root `CLAUDE.md`.
7. Update tests; run MVP eval suite end-to-end.
8. Smoke test: `fundx-audit` fund → trade → OS notification fires.

The detailed implementation plan (per-step file changes, test-first ordering) is produced by the writing-plans skill in a follow-up.
