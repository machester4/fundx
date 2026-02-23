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

| Component    | Technology                          |
|-------------|-------------------------------------|
| Language     | Python 3.11+                        |
| CLI          | Typer + Rich + questionary          |
| Config       | YAML (PyYAML)                       |
| State DB     | SQLite (trade journal, conversations)|
| Vectors      | sqlite-vss or numpy                 |
| Daemon       | APScheduler                         |
| Telegram     | python-telegram-bot (async)         |
| AI Engine    | Claude Code (CLI)                   |
| MCP Servers  | Node.js (TypeScript)                |
| Broker       | Alpaca API (alpaca-py)              |
| Market Data  | yfinance + Alpha Vantage            |
| Package      | pyproject.toml + pip                |

## Development Conventions

### Code Style

- Python 3.11+ with type hints throughout
- Follow PEP 8; use a formatter (black or ruff format) and linter (ruff)
- Use `pyproject.toml` for all project metadata and tool configuration
- Prefer dataclasses or Pydantic models for structured data
- Use `pathlib.Path` over `os.path`

### Project Structure Patterns

- CLI commands go in a `fundx/cli/` module, one file per command group (e.g., `fund.py`, `session.py`, `config.py`)
- Business logic belongs in `fundx/core/`, separate from CLI presentation
- MCP servers are standalone packages in `mcp-servers/` at the repo root (Node.js/TypeScript)
- Configuration schemas should be validated with Pydantic or a YAML schema validator
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
- Project structure + `pyproject.toml`
- `fundx init` (workspace setup)
- `fundx fund create` (interactive wizard)
- `fundx fund list` / `fundx fund info`
- `fundx status` (read from state files)
- CLAUDE.md template generation per fund
- `fund_config.yaml` schema + validation
- State file initialization
- Basic daemon with APScheduler
- Session runner (launches Claude Code)
- `fundx start` / `fundx stop` / `fundx logs`
- `fundx session run` (manual trigger)

### Phase 2 — Broker & Trading
- MCP server: broker-alpaca (paper trading)
- MCP server: market-data (yfinance wrapper)
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
- `pip install fundx` distribution, documentation, plugin system

## Build & Run Commands

No build system exists yet. When implemented, expect:

```bash
# Install in development mode
pip install -e ".[dev]"

# Run the CLI
fundx --help

# Run tests
pytest

# Lint and format
ruff check .
ruff format .

# Type check
mypy fundx/
```

## Testing Conventions

- Use `pytest` as the test framework
- Test files go in `tests/` mirroring the `fundx/` source structure
- Use fixtures for fund configs, mock state files, and broker API stubs
- MCP server tests should mock external APIs (Alpaca, yfinance)
- Integration tests for CLI commands should use Typer's `CliRunner`

## Important Notes for AI Assistants

- The README.md is the authoritative design document — refer to it for detailed schemas, CLI flow examples, and architecture diagrams
- When creating new files, follow the planned directory structure above
- Never hardcode broker credentials or API keys; always read from global config
- Fund state files must always be updated atomically (write to temp file, then rename)
- Every trade must be logged in the SQLite journal with reasoning
- Per-fund `CLAUDE.md` files are auto-generated from `fund_config.yaml` — they are separate from this root `CLAUDE.md`
- The `.gitignore` is currently Node.js-focused; add Python patterns (`.venv/`, `__pycache__/`, `*.pyc`, `.mypy_cache/`, etc.) when setting up the Python project
