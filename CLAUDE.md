# CLAUDE.md — FundX Development Guide

## Project Overview

FundX is a **CLI-first, goal-oriented, multi-fund autonomous investment platform** powered by Claude Code. It lets users define investment funds with real-life financial objectives (e.g., "sustain 18 months of living expenses") and delegates analysis, decision-making, and trade execution to Claude Code running autonomously via scheduled sessions.

**Current status:** Pre-implementation / planning phase. The repository contains a detailed architectural README but no source code yet. All development starts from scratch following the roadmap in `README.md`.

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

| Component    | Technology                                  |
|-------------|---------------------------------------------|
| Language     | TypeScript (Node.js 20+)                    |
| CLI          | Commander.js or oclif + Ink (React for CLI) |
| Config       | YAML (yaml / js-yaml)                       |
| State DB     | SQLite (better-sqlite3 or drizzle-orm)      |
| Vectors      | sqlite-vec or transformers.js               |
| Daemon       | node-cron or Bree                           |
| Telegram     | grammy (modern Telegram bot framework)      |
| AI Engine    | Claude Code (CLI)                           |
| MCP Servers  | TypeScript (MCP SDK)                        |
| Broker       | Alpaca API (@alpacahq/alpaca-trade-api)     |
| Market Data  | Yahoo Finance API + Alpha Vantage           |
| Package      | package.json + npm/pnpm                     |
| Build        | tsup or tsx                                 |
| Runtime      | tsx (dev) / compiled JS (prod)              |

## Development Conventions

### Code Style

- TypeScript with strict mode enabled (`"strict": true` in tsconfig.json)
- Use ESM modules (`"type": "module"` in package.json)
- Format with Prettier, lint with ESLint (flat config)
- Prefer Zod schemas for runtime validation of configs and API responses
- Use `node:path` and `node:fs/promises` (node: protocol prefix)
- Prefer `interface` over `type` for object shapes; use `type` for unions and intersections
- Use `async/await` throughout — no raw Promise chains or callbacks

### Project Structure Patterns

```
fundx/
├── src/
│   ├── cli/              # CLI commands, one file per command group
│   │   ├── index.ts      # Main CLI entry point
│   │   ├── fund.ts       # fund create/edit/list/info commands
│   │   ├── session.ts    # session run/history/next commands
│   │   └── config.ts     # config show/set/broker/telegram commands
│   ├── core/             # Business logic (no CLI dependencies)
│   │   ├── fund.ts       # Fund CRUD operations
│   │   ├── scheduler.ts  # Daemon/session scheduling
│   │   ├── session.ts    # Claude Code session runner
│   │   ├── state.ts      # State file read/write
│   │   └── config.ts     # Global config management
│   ├── mcp/              # MCP server implementations
│   │   ├── broker-alpaca/
│   │   ├── market-data/
│   │   └── telegram/
│   ├── gateway/          # Telegram bot
│   │   └── bot.ts
│   ├── schemas/          # Zod schemas for validation
│   │   ├── fund-config.ts
│   │   ├── portfolio.ts
│   │   └── state.ts
│   ├── types/            # Shared TypeScript types
│   │   └── index.ts
│   └── utils/            # Shared utilities
├── tests/                # Test files mirroring src/ structure
├── package.json
├── tsconfig.json
└── tsup.config.ts        # Build configuration
```

- CLI commands go in `src/cli/`, one file per command group
- Business logic belongs in `src/core/`, separate from CLI presentation
- MCP servers live in `src/mcp/` as part of the monorepo (or as separate packages if needed)
- Configuration schemas are validated with Zod in `src/schemas/`
- State files (JSON, SQLite) are per-fund under `state/`

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

### Phase 1 — MVP (Foundation) — START HERE
- Project structure + `package.json` + `tsconfig.json`
- `fundx init` (workspace setup)
- `fundx fund create` (interactive wizard)
- `fundx fund list` / `fundx fund info`
- `fundx status` (read from state files)
- CLAUDE.md template generation per fund
- `fund_config.yaml` Zod schema + validation
- State file initialization
- Basic daemon with node-cron or Bree
- Session runner (launches Claude Code)
- `fundx start` / `fundx stop` / `fundx logs`
- `fundx session run` (manual trigger)

### Phase 2 — Broker & Trading
- MCP server: broker-alpaca (paper trading)
- MCP server: market-data (Yahoo Finance / Alpha Vantage wrapper)
- Portfolio state auto-sync, trade execution, journal logging
- Stop-loss monitoring

### Phase 3 — Telegram
- Telegram bot, quick commands, notification system
- Free question → wake Claude flow

### Phase 4 — Intelligence
- Sub-agent parallel execution
- `fundx ask` and cross-fund analysis
- Trade journal vector embeddings + similarity search

### Phase 5 — Advanced
- Live trading, multi-broker, fund templates, special sessions

### Phase 6 — Community & Polish
- `npm install -g fundx` / `npx fundx` distribution, documentation, plugin system

## Build & Run Commands

No build system exists yet. When implemented, expect:

```bash
# Install dependencies
pnpm install

# Run in development mode (with tsx)
pnpm dev -- --help

# Build for production
pnpm build

# Run production build
pnpm start -- --help

# Run tests
pnpm test

# Lint and format
pnpm lint
pnpm format

# Type check (without emitting)
pnpm typecheck
```

### package.json Scripts (expected)

```json
{
  "scripts": {
    "dev": "tsx src/cli/index.ts",
    "build": "tsup",
    "start": "node dist/cli/index.js",
    "test": "vitest",
    "lint": "eslint .",
    "format": "prettier --write .",
    "typecheck": "tsc --noEmit"
  }
}
```

## Testing Conventions

- Use **Vitest** as the test framework
- Test files go in `tests/` mirroring the `src/` structure (e.g., `tests/core/fund.test.ts`)
- Use Vitest fixtures and `beforeEach`/`afterEach` for fund configs, mock state files, and broker API stubs
- MCP server tests should mock external APIs (Alpaca, Yahoo Finance)
- Integration tests for CLI commands should invoke the CLI as a subprocess or test command handlers directly
- Use `vi.mock()` for module mocking and `vi.spyOn()` for partial mocking

## Important Notes for AI Assistants

- The README.md is the authoritative design document — refer to it for detailed schemas, CLI flow examples, and architecture diagrams
- When creating new files, follow the planned directory structure above
- Never hardcode broker credentials or API keys; always read from global config
- Fund state files must always be updated atomically (write to temp file, then rename)
- Every trade must be logged in the SQLite journal with reasoning
- Per-fund `CLAUDE.md` files are auto-generated from `fund_config.yaml` — they are separate from this root `CLAUDE.md`
- The `.gitignore` already covers Node.js patterns (node_modules, dist, etc.) — extend it with `*.tsbuildinfo` if not already present
