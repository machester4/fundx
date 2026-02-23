# CLAUDE.md — FundX Development Guide

## Project Overview

FundX is a **CLI-first, goal-oriented, multi-fund autonomous investment platform** powered by Claude Code. It lets users define investment funds with real-life financial objectives (e.g., "sustain 18 months of living expenses") and delegates analysis, decision-making, and trade execution to Claude Code running autonomously via scheduled sessions.

**Current status:** Project scaffolding complete. Core architecture, types, and CLI skeleton are implemented. Ready for Phase 1 feature work.

**License:** Apache 2.0

## Architecture

### Core Concepts

- **Fund**: An independent investment entity with its own capital, objective, risk profile, asset universe, schedule, and persistent memory. Each fund lives in `~/.fundx/funds/<name>/`.
- **Session**: A Claude Code invocation scoped to a single fund. Sessions run on a schedule (pre-market, mid-session, post-market) or on-demand via CLI/Telegram.
- **Daemon/Scheduler**: Background process that checks schedules and launches Claude Code sessions for each active fund.
- **Telegram Gateway**: Always-on bot for notifications (trade alerts, digests) and bidirectional interaction (user questions wake Claude).
- **MCP Servers**: Broker integrations (Alpaca, IBKR, Binance), market data, news/sentiment, and Telegram notifications.

### High-Level Flow

```
CLI (fundx) → Daemon/Scheduler → Claude Code Session → MCP Servers (broker, data, telegram)
                                       ↕
                                 Persistent State (per fund)
```

Each Claude Code session:
1. Reads the fund's `CLAUDE.md` (its constitution) and `fund_config.yaml`
2. Reads persistent state (portfolio, journal, past analyses)
3. Creates and executes analysis scripts as needed
4. Optionally launches sub-agents for parallel analysis
5. Makes decisions within fund constraints
6. Executes trades via MCP broker server
7. Updates persistent state and generates reports
8. Sends notifications via Telegram

### Planned Directory Structure

```
~/.fundx/                          # Workspace root
├── config.yaml                    # Global configuration
├── daemon.pid / daemon.log        # Daemon state
├── funds/                         # All funds
│   └── <fund-name>/
│       ├── CLAUDE.md              # AI constitution for this fund
│       ├── fund_config.yaml       # Fund parameters
│       ├── state/                 # Persistent state (JSON, SQLite)
│       ├── analysis/              # Claude's analysis archive (markdown)
│       ├── scripts/               # Reusable scripts Claude created
│       ├── reports/               # Human-readable reports
│       └── .claude/               # Claude Code config for this fund
├── shared/
│   ├── mcp-servers/               # Shared MCP server configs
│   ├── skills/                    # Reusable analysis skills
│   └── templates/                 # Fund templates (runway, growth, etc.)
├── gateway/                       # Telegram bot
└── orchestrator/                  # Daemon + session runner
```

## Tech Stack

| Component    | Technology                              |
|-------------|-----------------------------------------|
| Language     | TypeScript (Node.js 20+)                |
| CLI          | Commander.js + @inquirer/prompts + chalk |
| Config       | YAML (js-yaml) + Zod validation         |
| State DB     | SQLite (better-sqlite3)                 |
| Daemon       | node-cron                               |
| Telegram     | grammy (Phase 3)                        |
| AI Engine    | Claude Code (CLI via child_process)     |
| MCP Servers  | TypeScript (Phase 2+)                   |
| Broker       | Alpaca API (Phase 2)                    |
| Build        | tsup (prod) / tsx (dev)                 |
| Test         | Vitest                                  |
| Package      | pnpm                                    |

## Development Conventions

### Code Style

- TypeScript with strict mode enabled (`"strict": true` in tsconfig.json)
- Use ESM modules (`"type": "module"` in package.json)
- Format with Prettier, lint with ESLint (flat config)
- Prefer Zod schemas for runtime validation of configs and API responses
- Use `node:path` and `node:fs/promises` (node: protocol prefix)
- Prefer `interface` over `type` for object shapes; use `type` for unions and intersections
- Use `async/await` throughout — no raw Promise chains or callbacks

### Source Structure

```
src/
  index.ts       # CLI entry point — wires all commands via Commander.js
  types.ts       # Zod schemas + inferred TypeScript types (single source of truth)
  paths.ts       # ~/.fundx path constants and per-fund path helpers
  config.ts      # Global config read/write (~/.fundx/config.yaml)
  state.ts       # Per-fund state file CRUD (portfolio, tracker, session log)
  template.ts    # Per-fund CLAUDE.md generation from fund_config.yaml
  init.ts        # `fundx init` command — workspace setup wizard
  fund.ts        # `fundx fund *` commands + fund CRUD logic
  status.ts      # `fundx status` command — dashboard
  session.ts     # `fundx session run` + Claude Code launcher
  daemon.ts      # `fundx start/stop` + node-cron scheduler + gateway startup
  gateway.ts     # Telegram bot + quick commands + free question routing
  mcp/
    broker-alpaca.ts    # MCP server: Alpaca broker integration
    market-data.ts      # MCP server: market data provider
    telegram-notify.ts  # MCP server: Telegram notifications for Claude sessions
```

**Design pattern:** Each file owns its domain completely — CLI command definition and business logic live together. No separate "commands" and "core" layers. This avoids indirection while the codebase is small. Split only when a file gets too large.

- All Zod schemas and types live in `types.ts` — single import for any module
- `paths.ts` is the only place that knows about `~/.fundx` structure
- `state.ts` handles all JSON read/write with atomic writes (tmp + rename)
- New commands get their own file (e.g., `ask.ts`, `portfolio.ts`) and register in `index.ts`

### Configuration

- Global config: `~/.fundx/config.yaml` (broker credentials, Telegram token, Claude path)
- Per-fund config: `~/.fundx/funds/<name>/fund_config.yaml` (objective, risk, universe, schedule, AI personality)
- Credentials must NEVER be stored in per-fund configs or committed to git
- The `.gitignore` already covers `.env` files — maintain this pattern

### Key Design Principles

1. **Goal-first, not trade-first** — Every decision is evaluated against the fund's life objective, not just P&L
2. **Claude as artisan** — No pre-defined analysis pipeline; Claude creates scripts, research, and calculations as needed each session
3. **Declarative funds** — A fund is fully defined by its `fund_config.yaml`; everything else is derived
4. **State is king** — Everything persists between sessions; Claude always knows where it left off
5. **Human in the loop, not in the way** — Autonomous operation with CLI/Telegram intervention available
6. **Paper first, live later** — Every fund starts in paper mode; live trading requires explicit confirmation
7. **Memory makes it smarter** — Trade journal + vector search enables learning from history
8. **Open and extensible** — New brokers, MCP servers, and objective types are all pluggable

### Fund Objective Types

When implementing fund logic, support these objective types:

| Type          | Optimization Target                    |
|--------------|---------------------------------------|
| `runway`     | Sustain monthly expenses for N months  |
| `growth`     | Multiply capital by target multiple    |
| `accumulation`| Acquire target amount of an asset     |
| `income`     | Generate passive monthly income        |
| `custom`     | Free-form user-defined objective       |

### State Files (per fund)

- `portfolio.json` — Current holdings, cash, market values
- `objective_tracker.json` — Progress toward fund goal
- `trade_journal.sqlite` — All trades with reasoning, outcomes, embeddings
- `session_log.json` — Last session metadata

## Development Roadmap (Priority Order)

Development follows 6 phases. When implementing, follow this order:

### Phase 1 — MVP (Foundation) — IN PROGRESS
- [x] Project structure + `package.json` + `tsconfig.json` + `tsup.config.ts`
- [x] Zod schemas for fund config, state, global config (`types.ts`)
- [x] Path helpers (`paths.ts`)
- [x] Global config management (`config.ts`)
- [x] State file CRUD with atomic writes (`state.ts`)
- [x] Per-fund CLAUDE.md generation (`template.ts`)
- [x] `fundx init` — workspace setup wizard (`init.ts`)
- [x] `fundx fund create/list/info/delete` (`fund.ts`)
- [x] `fundx status` — dashboard (`status.ts`)
- [x] `fundx session run` — Claude Code launcher (`session.ts`)
- [x] `fundx start/stop` — daemon with node-cron (`daemon.ts`)
- [ ] Install dependencies and verify build
- [ ] `fundx logs` command
- [ ] End-to-end test: init → create fund → run session

### Phase 2 — Broker & Trading
- MCP server: broker-alpaca (paper trading)
- MCP server: market-data (Yahoo Finance / Alpha Vantage wrapper)
- Portfolio state auto-sync, trade execution, journal logging
- Stop-loss monitoring

### Phase 3 — Telegram — COMPLETE
- [x] Telegram bot with grammy (`gateway.ts`)
- [x] Quick commands: /status, /portfolio, /trades, /pause, /resume, /next
- [x] Free question → wake Claude flow with auto-fund detection
- [x] MCP server: telegram-notify (send_message, send_trade_alert, send_stop_loss_alert, send_daily_digest, send_milestone_alert)
- [x] Notification system with quiet hours and priority override
- [x] Authorization middleware (only owner chat_id can interact)
- [x] Daemon starts gateway alongside scheduler
- [x] `fundx gateway start` — standalone gateway, `fundx gateway test` — send test message

### Phase 4 — Intelligence
- Sub-agent parallel execution
- `fundx ask` and cross-fund analysis
- Trade journal vector embeddings + similarity search

### Phase 5 — Advanced
- Live trading, multi-broker, fund templates, special sessions

### Phase 6 — Community & Polish
- `npm install -g fundx` / `npx fundx` distribution, documentation, plugin system

## Build & Run Commands

```bash
pnpm install              # Install dependencies
pnpm dev -- --help        # Run CLI in dev mode (tsx)
pnpm build                # Build for production (tsup)
pnpm start -- --help      # Run production build
pnpm test                 # Run tests (vitest)
pnpm lint                 # Lint (eslint)
pnpm format               # Format (prettier)
pnpm typecheck            # Type check (tsc --noEmit)
```

## Testing Conventions

- **Vitest** as test framework — test files in `tests/` (e.g., `tests/fund.test.ts`)
- Use `vi.mock()` for module mocking, `vi.spyOn()` for partial mocking
- Mock `fs` operations and external APIs — never hit real broker/market APIs in tests
- CLI integration tests should test command handler functions directly

## Important Notes for AI Assistants

- The README.md is the authoritative design document — refer to it for detailed schemas, CLI flow examples, and architecture diagrams
- When creating new files, follow the planned directory structure above
- Never hardcode broker credentials or API keys; always read from global config
- Fund state files must always be updated atomically (write to temp file, then rename)
- Every trade must be logged in the SQLite journal with reasoning
- Per-fund `CLAUDE.md` files are auto-generated from `fund_config.yaml` — they are separate from this root `CLAUDE.md`
- The `.gitignore` already covers Node.js patterns (node_modules, dist, etc.) — extend it with `*.tsbuildinfo` if not already present
