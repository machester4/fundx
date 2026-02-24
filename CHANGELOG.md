# Changelog

All notable changes to FundX will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
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
