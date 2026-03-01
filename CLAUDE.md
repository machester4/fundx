# CLAUDE.md — FundX Development Guide

## Project Overview

FundX is a **CLI-first, goal-oriented, multi-fund autonomous investment platform** powered by Claude Code. It lets users define investment funds with real-life financial objectives (e.g., "sustain 18 months of living expenses") and delegates analysis, decision-making, and trade execution to Claude Code running autonomously via scheduled sessions.

**Current status:** Phases 1-5 complete. All core features implemented. Ready for Phase 6 (Community & Polish).

**License:** Apache 2.0

## Architecture

### Core Concepts

- **Fund**: An independent investment entity with its own capital, objective, risk profile, asset universe, schedule, and persistent memory. Each fund lives in `~/.fundx/funds/<name>/`.
- **Session**: A Claude Code invocation scoped to a single fund. Sessions run on a schedule (pre-market, mid-session, post-market) or on-demand via CLI/Telegram.
- **Daemon/Scheduler**: Background process that checks schedules and launches Claude Code sessions for each active fund.
- **Telegram Gateway**: Always-on bot for notifications (trade alerts, digests) and bidirectional interaction (user questions wake Claude).
- **MCP Servers**: Broker integrations (Alpaca), market data, news/sentiment, and Telegram notifications. IBKR and Binance adapters are planned.

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
4. Optionally invokes analyst sub-agents via the Task tool (macro, technical, sentiment, risk, news)
5. Makes decisions within fund constraints
6. Executes trades via MCP broker server
7. Updates persistent state and generates reports
8. Sends notifications via Telegram

### Directory Structure

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
| CLI          | Ink (React for CLI) + Pastel (file-based routing) + @inkjs/ui |
| Config       | YAML (js-yaml) + Zod validation         |
| State DB     | SQLite (better-sqlite3)                 |
| Daemon       | node-cron                               |
| Telegram     | grammy (Phase 3)                        |
| AI Engine    | Claude Agent SDK (@anthropic-ai/claude-agent-sdk) |
| MCP Servers  | TypeScript (Phase 2+)                   |
| Market Data  | FMP (primary) / Alpaca Data API (fallback) |
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

### CLI Architecture Conventions

- **Build & distribution:** TypeScript compiled with tsup (not webpack). The `bin` field in `package.json` points to the compiled entry point. Publish to npm, users install with `npm i -g fundx`
- **Persistent config:** Global settings (API keys, preferred model, market data provider) live in `~/.fundx/config.yaml` via YAML + Zod validation. Never store secrets in per-fund configs
- **Error handling:** Use an `ErrorBoundary` at the app level (Ink components) to catch and display formatted errors instead of crashing with raw stack traces. Services should throw typed errors, commands should catch and render with `<ErrorMessage>`
- **Graceful exit:** Capture `SIGINT`/`SIGTERM` to clean up resources (cancel in-flight requests, save state) before exiting. The daemon already does this in `daemon.service.ts` — follow the same pattern for any long-running process
- **State machine + streaming hook:** The highest-impact pattern. Commands that interact with Claude use a `Phase` state machine (e.g., `resolving → selecting → ready`) for UI flow, and `useStreaming` for Agent SDK responses with buffer + cancel. These two together make the React mental model map naturally to interactive CLI states. See `commands/index.tsx` (phase machine) and `hooks/useStreaming.ts` (streaming hook) as reference implementations

### Source Structure

```
src/
  index.tsx             # Pastel entry point (file-based CLI routing)
  types.ts              # Zod schemas + inferred TypeScript types (single source of truth)
  paths.ts              # ~/.fundx path constants and per-fund path helpers
  config.ts             # Global config read/write (~/.fundx/config.yaml)
  state.ts              # Per-fund state file CRUD (portfolio, tracker, session log)
  template.ts           # Per-fund CLAUDE.md generation from fund_config.yaml
  agent.ts              # Claude Agent SDK wrapper — single entry point for all AI queries
  subagent.ts           # Analyst AgentDefinitions for the Task tool (macro, technical, sentiment, risk, news)
  embeddings.ts         # Trade journal FTS5 indexing + similarity search
  journal.ts            # Trade journal SQLite CRUD (open, insert, query, summary)
  alpaca-helpers.ts     # Shared Alpaca API helpers (credentials, fetch, orders)
  sync.ts               # Portfolio sync from Alpaca broker
  stoploss.ts           # Stop-loss monitoring and execution
  broker-adapter.ts     # Broker adapter interface + Alpaca implementation
  skills.ts             # Reusable analysis skills
  services/             # Pure business logic (async functions, no UI)
    index.ts            # Barrel file re-exporting all services
    fund.service.ts     # Fund CRUD, config load/save, list, validate, create
    init.service.ts     # Workspace initialization
    status.service.ts   # Dashboard data aggregation
    session.service.ts  # Session runner
    daemon.service.ts   # Daemon start/stop, cron scheduling
    gateway.service.ts  # Telegram gateway management
    ask.service.ts      # Question answering + cross-fund analysis
    chat.service.ts     # Chat REPL context building + streaming
    live-trading.service.ts  # Live trading safety checks + mode switching
    templates.service.ts     # Fund templates (export/import/builtin/clone)
    special-sessions.service.ts  # Event-triggered sessions (FOMC, OpEx, etc.)
    chart.service.ts    # Performance chart data (allocation, P&L, sparklines)
    reports.service.ts  # Auto-reports (daily/weekly/monthly)
    correlation.service.ts   # Cross-fund correlation monitoring
    montecarlo.service.ts    # Monte Carlo runway/portfolio projections
    logs.service.ts     # Daemon/session log retrieval
    portfolio.service.ts     # Portfolio display data
    trades.service.ts   # Trade history queries
    performance.service.ts   # Performance metrics aggregation
    market.service.ts   # Market data (FMP primary, Alpaca fallback)
  commands/             # Pastel commands (React/Ink components, file-based routing)
    index.tsx           # Default command (fullscreen TUI dashboard + chat REPL)
    init.tsx            # fundx init
    status.tsx          # fundx status
    start.tsx           # fundx start
    stop.tsx            # fundx stop
    ask.tsx             # fundx ask <question>
    chat.tsx            # fundx chat (interactive REPL)
    portfolio.tsx       # fundx portfolio <fund>
    trades.tsx          # fundx trades <fund>
    performance.tsx     # fundx performance <fund>
    logs.tsx            # fundx logs
    correlation.tsx     # fundx correlation
    fund/               # fundx fund {create,list,info,delete,clone}
    session/            # fundx session {run,agents}
    gateway/            # fundx gateway {start,test}
    live/               # fundx live {enable,disable}
    template/           # fundx template {list,export,import,builtin}
    special/            # fundx special {list,add,remove}
    chart/              # fundx chart {allocation,pnl,sparkline}
    report/             # fundx report {daily,weekly,monthly,view}
    montecarlo/         # fundx montecarlo {run}
  components/           # Reusable Ink components
    StatusBadge.tsx     # Colored status indicator (active/paused/closed)
    PnlText.tsx         # Green/red P&L display with $ and %
    Header.tsx          # Bold section header with optional rule
    ErrorMessage.tsx    # Red error display
    SuccessMessage.tsx  # Green success with checkmark
    Table.tsx           # Terminal table with aligned columns
    FundSelector.tsx    # Interactive fund picker (Select)
    ConfirmAction.tsx   # Y/n confirmation (ConfirmInput)
    WizardStep.tsx      # Multi-step form wizard
    Logo.tsx            # FundX ASCII banner
    BarChart.tsx        # Horizontal bar chart with Unicode blocks
    Sparkline.tsx       # Inline sparkline
    MarkdownView.tsx    # Terminal markdown renderer
    Panel.tsx           # General bordered panel wrapper
    KeyboardHint.tsx    # Keyboard shortcut hint display
    HeaderBar.tsx       # Header bar with title
    FundCard.tsx        # Fund summary card
    AlertsPanel.tsx     # Dashboard alerts panel
    FundDetailView.tsx  # Expanded fund detail view
    ChatMessage.tsx     # Chat message bubble
    StreamingIndicator.tsx # Streaming response indicator
    FundContextBar.tsx  # Active fund context bar
    ChatView.tsx        # Chat REPL view (inline + fullscreen)
    NewsPanel.tsx       # News headlines panel
    DashboardFooter.tsx # Dashboard footer with hints
    FundsOverviewPanel.tsx # Funds overview panel
    SystemStatusPanel.tsx  # Service status panel (daemon, telegram, market data)
    MarketTickerBanner.tsx  # Full-width market ticker bar (indices, commodities, crypto)
  hooks/                # Custom React hooks
    useAsyncAction.ts   # Run async fn, track { data, isLoading, error, retry }
    useStreaming.ts     # Agent SDK streaming with buffer + cancel
    useFundData.ts      # Load fund config + portfolio + tracker
    useAllFunds.ts      # List all fund names
    useDaemonStatus.ts  # Check if daemon is running
    useInterval.ts      # Periodic callback (polling/refresh)
    useTerminalSize.ts  # Terminal columns/rows tracking
  context/              # React contexts
    AppContext.tsx       # Global config, error handling
  mcp/
    broker-alpaca.ts    # MCP server: Alpaca broker integration
    market-data.ts      # MCP server: market data provider
    telegram-notify.ts  # MCP server: Telegram notifications for Claude sessions
```

**Design pattern:** Strict separation of concerns — services contain pure business logic (no UI deps), commands are thin React/Ink components that call services and render results. Pastel provides file-based routing: folder nesting = subcommands.

- All Zod schemas and types live in `types.ts` — single import for any module
- `paths.ts` is the only place that knows about `~/.fundx` structure
- `state.ts` handles all JSON read/write with atomic writes (tmp + rename)
- New commands: add a `.tsx` file under `commands/` (Pastel auto-discovers it)
- New business logic: add to or create a service in `services/`
- Commands use `export const description`, `export const args` (zod), `export const options` (zod), and `export default function` pattern

### Configuration

- Global config: `~/.fundx/config.yaml` (broker credentials, Telegram token, market data provider, default model)
- Per-fund config: `~/.fundx/funds/<name>/fund_config.yaml` (objective, risk, universe, schedule, AI personality)
- Market data: `market_data.provider` (`fmp` or `alpaca`) + `market_data.fmp_api_key` in global config
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

### Phase 1 — MVP (Foundation) — COMPLETE
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
- [x] Install dependencies and verify build
- [x] `fundx logs` command
- [x] End-to-end test: init → create fund → run session

### Phase 2 — Broker & Trading — COMPLETE
- [x] MCP server: broker-alpaca (paper trading)
- [x] MCP server: market-data (Yahoo Finance / Alpha Vantage wrapper)
- [x] Portfolio state auto-sync, trade execution, journal logging
- [x] Stop-loss monitoring

### Phase 3 — Telegram — COMPLETE
- [x] Telegram bot with grammy (`gateway.ts`)
- [x] Quick commands: /status, /portfolio, /trades, /pause, /resume, /next
- [x] Free question → wake Claude flow with auto-fund detection
- [x] MCP server: telegram-notify (send_message, send_trade_alert, send_stop_loss_alert, send_daily_digest, send_milestone_alert)
- [x] Notification system with quiet hours and priority override
- [x] Authorization middleware (only owner chat_id can interact)
- [x] Daemon starts gateway alongside scheduler
- [x] `fundx gateway start` — standalone gateway, `fundx gateway test` — send test message

### Phase 4 — Intelligence — COMPLETE
- [x] Analyst AgentDefinitions via Task tool (`subagent.ts`) — macro, technical, sentiment, risk, news
- [x] `fundx ask` command with cross-fund analysis (`ask.ts`)
- [x] Trade journal FTS5 vector embeddings + similarity search (`embeddings.ts`)
- [x] Zod schemas for similar trade results (`types.ts`)
- [x] Auto-indexing via SQLite triggers (INSERT, UPDATE, DELETE sync)
- [x] Trade context summary generation for prompts

### Phase 5 — Advanced — COMPLETE
- [x] Live trading mode with safety checks and double confirmation (`live-trading.ts`)
- [x] Broker adapter interface + Alpaca implementation (`broker-adapter.ts`); IBKR/Binance planned
- [x] Fund templates: built-in (runway, growth, accumulation, income), export/import (`templates.ts`)
- [x] `fundx fund clone` — clone existing fund configuration
- [x] Special sessions: FOMC, OpEx, CPI, NFP, Earnings Season triggers (`special-sessions.ts`)
- [x] Terminal-based performance charting: allocation, P&L bars, sparklines (`chart.ts`)
- [x] Auto-reports: daily, weekly, monthly markdown reports (`reports.ts`)
- [x] Cross-fund correlation monitoring with position overlap detection (`correlation.ts`)
- [x] Monte Carlo simulation: runway projections, probability of ruin (`montecarlo.ts`)
- [x] Daemon integration: special session triggers + auto-report generation
- [x] Zod schemas for all Phase 5 types (`types.ts`)

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
