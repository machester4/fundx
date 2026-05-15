# Changelog

All notable changes to FundX will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `notify.service` — native OS notifications via `node-notifier` with five event
  types (trade executed, stop-loss triggered, daily cap reached, supervisor
  stale, handoff missing) and a generic emitter.
- Global `notifications` config block: `enabled` master switch and
  `quiet_hours` with `start` / `end` (UTC) and `allow_critical` to let
  high-priority alerts bypass quiet hours.
- `trade-watcher` service: polls `trade_journal.sqlite` inside session runs and
  emits trade notifications, skipping `session_type = stop_loss` so the
  dedicated stop-loss path owns those.
- Stop-loss path now persists `pnl` / `pnl_pct` / `closed_at` / `close_price`
  to the trade journal and the trade reasoning string is sign-aware
  (`Gain:` vs `Loss:`) — trailing stops above avg_cost are no longer
  misreported as losses.
- `insertTrade` now binds `closed_at`, `close_price`, `pnl`, `pnl_pct`, and
  `lessons_learned` — closing fields the schema declared but the INSERT
  silently dropped.

### Removed
- Telegram integration in its entirety: `gateway.service`, `telegram-notify`
  MCP server, `broker-local-notify` helper, `fundx gateway` commands, and
  the `grammy` dependency. All notification flows now go through OS
  notifications.
- Read-view CLI commands (`portfolio`, `trades`, `performance`, `chart`,
  `report`, `montecarlo`, `correlation`, `template`, `ask`, `logs`,
  `fund list`, `fund info`, `fund pause`, `fund resume`, `fund clone`,
  `fund show-universe`, `generator`, `config`). All capabilities continue
  to exist as services; the chat REPL inside `fundx` now drives them.

### Changed
- `daemon.service` no longer launches the Telegram gateway alongside the
  cron scheduler.
- Per-fund `notifications.telegram.*` config sub-tree removed; replaced by
  the single global `notifications` block (per-fund overrides were never
  user-facing useful).
- Workspace and per-fund `CLAUDE.md` templates, fund rules, and skills
  scrubbed of Telegram references.

### Fixed
- Notify service now respects `notifications.enabled = false` and
  `quiet_hours.allow_critical = false` (regression introduced when the
  notify-service stub was first added).
- Trade-watcher cursor is primed to the latest trade ID on first run so the
  first session after install does not re-notify historical journal rows.
- `tests/notify.test.ts` is now deterministic regardless of the user's
  local `~/.fundx/config.yaml` and wall-clock time — `loadGlobalConfig`
  is mocked file-locally.
- Cleaned up all ESLint warnings (unused imports/vars)
- Improved package.json metadata for npm publish readiness
- Rewrote README.md as user-facing documentation

## [0.1.0] - 2026-02-24

Initial release with all core features (Phases 1-5).

### Phase 1 — MVP (Foundation)
- Project scaffolding with TypeScript, ESM, tsup, Vitest
- Zod schemas for fund config, global config, state files (`types.ts`)
- Path helpers for `~/.fundx/` workspace structure (`paths.ts`)
- Global config management with YAML read/write (`config.ts`)
- State file CRUD with atomic writes — temp + rename (`state.ts`)
- Per-fund `CLAUDE.md` auto-generation from `fund_config.yaml` (`template.ts`)
- `fundx init` — interactive workspace setup wizard
- `fundx fund create/list/info/delete` — full fund lifecycle management
- `fundx status` — dashboard showing all funds and services
- `fundx session run` — manual Claude Code session launcher
- `fundx start/stop` — daemon with node-cron scheduler
- `fundx logs` — daemon and fund log viewer

### Phase 2 — Broker & Trading
- MCP server: `broker-alpaca` — paper/live trading via Alpaca API
- MCP server: `market-data` — Yahoo Finance / Alpha Vantage data
- Portfolio state auto-sync from broker positions
- Trade execution with journal logging (SQLite)
- Stop-loss monitoring with automated triggers
- `fundx portfolio` / `fundx trades` / `fundx performance` commands

### Phase 3 — Telegram
- Telegram bot with grammy framework (`gateway.ts`)
- Quick commands: `/status`, `/portfolio`, `/trades`, `/pause`, `/resume`, `/next`
- Free question routing — any message wakes Claude with auto-fund detection
- MCP server: `telegram-notify` — send_message, send_trade_alert, send_daily_digest, etc.
- Notification system with quiet hours and priority override
- Authorization middleware (owner chat_id only)
- Daemon starts gateway alongside scheduler
- `fundx gateway start` / `fundx gateway test` commands

### Phase 4 — Intelligence
- Sub-agent parallel execution: macro, technical, sentiment, risk analysts (`subagent.ts`)
- `fundx ask` with single-fund and cross-fund analysis (`ask.ts`)
- `fundx session run --parallel` — sessions with sub-agent analysis
- `fundx session agents` — standalone sub-agent execution
- Trade journal FTS5 indexing with similarity search (`embeddings.ts`)
- Auto-indexing via SQLite triggers (INSERT, UPDATE, DELETE sync)
- Trade context summary generation for Claude prompts

### Phase 5 — Advanced
- Live trading mode with safety checks and double confirmation (`live-trading.ts`)
- Multi-broker adapter: Alpaca, IBKR, Binance (`broker-adapter.ts`)
- Fund templates: built-in (runway, growth, accumulation, income), export/import (`templates.ts`)
- `fundx fund clone` — clone existing fund configuration
- Special sessions: FOMC, OpEx, CPI, NFP, Earnings Season triggers (`special-sessions.ts`)
- Terminal-based performance charting: allocation pie, P&L bars, sparklines (`chart.ts`)
- Auto-reports: daily, weekly, monthly markdown reports (`reports.ts`)
- Cross-fund correlation monitoring with position overlap detection (`correlation.ts`)
- Monte Carlo simulation: runway projections, probability of ruin (`montecarlo.ts`)
- Daemon integration: special session triggers + auto-report generation
