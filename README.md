# FundX — Autonomous AI Fund Manager

> **CLI-first, goal-oriented, multi-fund autonomous investment platform powered by Claude Code.**

-----

## Vision

FundX is a local CLI tool that lets you define **investment funds with real-life financial objectives** (not just “maximize returns”) and delegates the entire analysis, decision-making, and execution cycle to Claude Code running autonomously via scheduled sessions.

Each fund is an independent entity with its own capital, objective, risk profile, asset universe, schedule, and persistent memory. Claude Code acts as the brain — creating scripts on the fly, searching the web, running parallel sub-agents, and executing trades through broker APIs — all within the constraints you define.

**What makes FundX different from everything else:**

- **Goal-oriented, not return-oriented.** You don’t say “beat the S&P”. You say “I have $30k, I spend $2k/month, give me 18 months of runway.” The AI optimizes for *your life goal*.
- **Claude Code as artisan, not robot.** Each session, Claude can invent new analysis tools, write and execute temporary scripts, search the web for breaking news, brainstorm strategies — it’s not limited to pre-defined tools.
- **Multi-fund architecture.** Run a conservative runway fund, an aggressive growth fund, and a BTC accumulation fund simultaneously, each with its own AI personality and constraints.
- **Bidirectional Telegram.** Get notifications AND wake up Claude anytime to ask questions about past analyses, current positions, or cross-fund insights.
- **CLI-first.** Install locally, configure interactively, manage everything from your terminal. Similar UX to TradingAgents.

-----

## Inspiration & Prior Art

This project builds on ideas from several existing projects, combining the best aspects of each:

|Project                                                                                    |What we take                                                                          |What we improve                                                                                                  |
|-------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------|
|[TradingAgents](https://github.com/TauricResearch/TradingAgents) (arXiv:2412.20138)        |Multi-agent debate architecture (bull/bear researchers, risk management)              |TradingAgents is stateless and non-autonomous. FundX runs continuously with persistent memory and real execution.|
|[Prophet Trader](https://github.com/JakeNesler/Claude_Prophet)                             |Claude Code + MCP + Alpaca for autonomous trading, vector memory of past trades       |Prophet is single-fund, single-objective (maximize returns). FundX is multi-fund, goal-oriented.                 |
|[Agentic Investment Management](https://github.com/hvkshetry/agentic-investment-management)|12 specialist sub-agents, MCP servers, deterministic workflows with gates             |Agentic IM is complex to set up. FundX provides a simple CLI with interactive fund creation.                     |
|[CC Trading Terminal](https://github.com/degentic-tools/claude-code-trading-terminal)      |Claude Code sub-agents for parallel execution, real-time data pipelines               |CC Terminal is crypto-only. FundX supports any asset class.                                                      |
|[claude-code-langchain](https://github.com/tim-schultz/claude-code-langchain)              |LangChain-compatible wrapper for Claude Code SDK (for potential LangGraph integration)|Direct Claude Code usage is simpler and more powerful than wrapping in LangChain for our use case.               |

### Key Papers

- **TradingAgents** — Xiao et al., 2024. Multi-agent LLM framework simulating trading firms. [arXiv:2412.20138](https://arxiv.org/abs/2412.20138)
- **Trading-R1** — Tauric Research, 2025. RL-based financial reasoning for LLMs. [arXiv:2509.11420](https://arxiv.org/abs/2509.11420)
- **AlphaAgents** — Zhao et al., 2025. Multi-agent systems for equity portfolio construction. [arXiv:2508.11152](https://arxiv.org/abs/2508.11152)
- **LLM Agents for Investment Management** — Saha et al., 2025 (BlackRock). Survey of LLM agents in trading and investment. [SSRN:5447274](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=5447274)
- **FinMem** — Yu et al., 2023. LLM trading agent with layered memory. [arXiv:2311.13743](https://arxiv.org/abs/2311.13743)
- **FinRobot** — Yang et al., 2024. Open-source AI agent platform for financial analysis. [arXiv:2405.14767](https://arxiv.org/abs/2405.14767)

-----

## Architecture

### High-Level Overview

```
┌──────────────────────────────────────────────────────────────┐
│                         CLI (fundx)                           │
│  init · fund create/edit/list · start/stop · status · ask    │
└──────────────┬───────────────────────────────┬───────────────┘
               │                               │
               ▼                               ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│      Daemon/Scheduler     │    │       Telegram Gateway        │
│  (node-cron / Bree)       │    │  (always-on bot)              │
│                           │    │                               │
│  For each active fund:    │    │  IN:  user messages/commands  │
│  - Check schedule         │    │  OUT: alerts, reports, trades │
│  - Launch Claude Code     │    │  WAKE: on-demand Claude Code  │
│    session with fund      │    │        sessions               │
│    context                │    │                               │
└──────────┬───────────────┘    └──────────────┬───────────────┘
           │                                    │
           ▼                                    ▼
┌──────────────────────────────────────────────────────────────┐
│                     Claude Code Session                       │
│                                                               │
│  1. Read CLAUDE.md (fund constitution)                        │
│  2. Read fund_config.yaml (constraints)                       │
│  3. Read persistent state (portfolio, journal, past analyses) │
│  4. Create & execute temporary scripts as needed:             │
│     - Market data download (Yahoo Finance, Alpha Vantage)     │
│     - Technical indicators calculation                        │
│     - News/sentiment scraping                                 │
│     - Backtesting                                             │
│  5. Launch sub-agents in parallel (if needed):                │
│     - Macro analyst                                           │
│     - Technical analyst                                       │
│     - Sentiment analyst                                       │
│     - Risk manager                                            │
│  6. Make decisions within fund constraints                    │
│  7. Execute trades via MCP broker server                      │
│  8. Update persistent state                                   │
│  9. Generate report                                           │
│ 10. Send notifications via Telegram MCP                       │
│                                                               │
└──────────────────────────────────────────────────────────────┘
               │                    │
               ▼                    ▼
┌──────────────────────┐  ┌────────────────────────────────────┐
│   Persistent State    │  │         MCP Servers                │
│   (per fund)          │  │                                    │
│                       │  │  - broker-alpaca (stocks/ETFs)     │
│  - portfolio.json     │  │  - broker-ibkr (intl markets)     │
│  - runway_tracker.json│  │  - broker-binance (crypto)        │
│  - trade_journal.db   │  │  - market-data (Yahoo Fin/AV)     │
│  - analysis_archive/  │  │  - news-sentiment                 │
│  - strategies/        │  │  - telegram-notifications          │
│  - reports/           │  │                                    │
└──────────────────────┘  └────────────────────────────────────┘
```

### Directory Structure

```
~/.fundx/                              # Workspace root (created by `fundx init`)
├── config.yaml                        # Global configuration
├── daemon.pid                         # Daemon process ID
├── daemon.log                         # Daemon log
│
├── funds/                             # All funds live here
│   ├── runway/                        # Example fund
│   │   ├── CLAUDE.md                  # AI constitution for this fund
│   │   ├── fund_config.yaml           # Fund parameters (declarative)
│   │   ├── state/
│   │   │   ├── portfolio.json         # Current holdings + cash
│   │   │   ├── objective_tracker.json # Progress toward goal
│   │   │   ├── trade_journal.sqlite   # All trades + embeddings
│   │   │   └── session_log.json       # Last session metadata
│   │   ├── analysis/                  # Claude's analysis archive
│   │   │   ├── 2026-02-21_pre.md
│   │   │   ├── 2026-02-21_mid.md
│   │   │   ├── 2026-02-21_post.md
│   │   │   └── ...
│   │   ├── scripts/                   # Scripts Claude created & wants to keep
│   │   │   ├── gold_dxy_correlation.py
│   │   │   └── jnug_momentum_scanner.py
│   │   ├── reports/                   # Human-readable reports
│   │   │   ├── daily/
│   │   │   ├── weekly/
│   │   │   └── monthly/
│   │   └── .claude/                   # Claude Code config for this fund
│   │       ├── settings.json          # MCP servers, permissions
│   │       └── commands/              # Custom slash commands
│   │
│   ├── growth/
│   │   └── ... (same structure)
│   │
│   └── btc-accumulation/
│       └── ... (same structure)
│
├── shared/
│   ├── mcp-servers/                   # Shared MCP server configs
│   │   ├── broker-alpaca/
│   │   ├── broker-binance/
│   │   ├── market-data/
│   │   ├── news-sentiment/
│   │   └── telegram/
│   ├── skills/                        # Reusable analysis skills
│   │   ├── technical_analysis/
│   │   ├── sentiment_analysis/
│   │   ├── macro_analysis/
│   │   ├── risk_management/
│   │   └── portfolio_optimization/
│   └── templates/                     # Fund templates
│       ├── runway.yaml
│       ├── growth.yaml
│       ├── accumulation.yaml
│       ├── income.yaml
│       └── custom.yaml
│
├── gateway/
│   ├── bot.ts                         # Always-on Telegram bot
│   └── conversation_store.sqlite      # Chat history
│
└── orchestrator/
    ├── daemon.ts                      # Session scheduler
    ├── session_runner.ts              # Launches Claude Code sessions
    └── fund_registry.json             # Active funds + schedules
```

-----

## Fund Configuration

### fund_config.yaml (Complete Schema)

```yaml
fund:
  name: "runway"                       # Unique identifier
  display_name: "Runway Fund"          # Human-readable name
  description: "Capital de despido - generar runway mientras busco trabajo"
  created: 2026-02-22
  status: active                       # active | paused | closed

capital:
  initial: 30000                       # Starting capital (USD)
  currency: USD

# ── Objective Types ──────────────────────────────────────────
# The objective type changes how Claude thinks about every decision.
# It's not just a label — it fundamentally alters the optimization target.

objective:
  type: runway                         # runway | growth | accumulation | income | custom
  
  # For type: runway
  target_months: 18                    # How many months to sustain
  monthly_burn: 2000                   # Monthly expenses
  min_reserve_months: 3                # Never go below this in cash
  
  # For type: growth
  # target_multiple: 2.0               # e.g., 2x initial capital
  # target_amount: 20000               # OR absolute target
  # timeframe_months: 24               # Time horizon
  
  # For type: accumulation
  # target_asset: BTC                  # What to accumulate
  # target_amount: 1.0                 # How much
  # deadline: 2027-12-31               # By when
  
  # For type: income
  # target_monthly_income: 500         # Passive income target
  # income_assets: [dividends, covered_calls, staking]
  
  # For type: custom
  # description: "Free-form objective description for Claude"
  # success_criteria: "..."
  # constraints: "..."

risk:
  profile: moderate                    # conservative | moderate | aggressive | custom
  max_drawdown_pct: 15                 # Max portfolio drawdown before going defensive
  max_position_pct: 25                 # Max single position size
  max_leverage: 2                      # Max leverage allowed
  stop_loss_pct: 8                     # Per-position stop loss
  max_daily_loss_pct: 5                # Max daily portfolio loss
  correlation_limit: 0.8               # Max correlation between positions
  
  # Custom overrides (optional)
  custom_rules:
    - "Never hold more than 3 leveraged ETFs simultaneously"
    - "Reduce exposure 50% before FOMC meetings"
    - "Keep minimum 30% in cash or cash-equivalents"

universe:
  allowed:
    - type: etf
      tickers: [GDX, GDXJ, SLV, GLD, UGL, AGQ, JNUG]
    - type: equity
      sectors: [mining, precious_metals]
      # tickers: []                    # Empty = any in sector
    # - type: options
    #   strategies: [covered_calls, protective_puts]
    # - type: crypto
    #   tickers: [BTC, ETH, SOL]
    # - type: defi
    #   protocols: [aave, uniswap]
  
  forbidden:
    - type: options                    # Not for this fund
    - type: crypto
    - tickers: [UVXY, SQQQ]           # Specific exclusions

schedule:
  timezone: America/Montevideo
  trading_days: [MON, TUE, WED, THU, FRI]
  
  sessions:
    pre_market:
      time: "09:00"                    # Local time
      enabled: true
      focus: |
        Analyze overnight developments, global markets, futures.
        Review open positions. Plan trades for the day.
        Set alerts and orders.
      max_duration_minutes: 15         # Claude Code session timeout
    
    mid_session:
      time: "13:00"
      enabled: true
      focus: |
        Monitor positions. React to intraday news/moves.
        Adjust stops. Execute planned trades if conditions met.
      max_duration_minutes: 10
    
    post_market:
      time: "18:00"
      enabled: true
      focus: |
        Review day's performance. Update trade journal.
        Analyze what worked/didn't. Plan for tomorrow.
        Generate daily report.
      max_duration_minutes: 15
    
    # overnight:
    #   time: "23:00"
    #   enabled: false
    #   focus: "Review Asian markets opening, crypto moves"

  special_sessions:
    - trigger: "FOMC meeting days"
      time: "14:30"                    # 30 min before announcement
      focus: "Pre-FOMC positioning review and risk reduction"
    
    - trigger: "Monthly options expiration (OpEx)"
      time: "09:00"
      focus: "Review options exposure, roll or close positions"

broker:
  provider: alpaca                     # alpaca | ibkr | binance | manual
  mode: paper                          # paper | live
  # Credentials are stored in global config, not per-fund

notifications:
  telegram:
    enabled: true
    alerts:
      trade_executed: true
      stop_loss_triggered: true
      daily_digest: true               # End of day summary
      weekly_digest: true              # Weekend summary
      objective_milestone: true        # "You've hit 50% of your target!"
      runway_warning_months: 4         # Alert when runway gets low
      drawdown_warning_pct: 10         # Alert on significant drawdown
    quiet_hours:
      start: "23:00"
      end: "07:00"
    priority_override:                 # These ignore quiet hours
      - stop_loss_triggered
      - drawdown_warning_pct

interaction:
  telegram:
    enabled: true
    allow_commands: true               # /status, /portfolio, etc.
    allow_free_questions: true         # Natural language → wake Claude
    allow_trade_commands: false        # Don't allow "buy X" via Telegram (safety)

# ── Claude Behavior ──────────────────────────────────────────
# These shape the AI's personality and approach for this fund

claude:
  model: opus                          # opus | sonnet (for different session types)
  temperature: 0.3                     # Lower = more conservative decisions
  
  personality: |
    You are a conservative fund manager focused on capital preservation.
    Your primary goal is protecting the runway, not maximizing returns.
    You think in terms of "months of runway remaining" not "percentage return."
    You are patient — you'd rather miss an opportunity than take a bad risk.
    You always explain your reasoning clearly.
  
  decision_framework: |
    Before every trade, answer:
    1. How does this affect my runway in months?
    2. What's the worst case scenario for this position?
    3. Is there a simpler/safer way to achieve the same exposure?
    4. Am I being reactive (bad) or strategic (good)?
  
  tools_allowed:
    - bash                             # Execute scripts
    - write                            # Create files
    - read                             # Read files
    - web_search                       # Search the web
    - web_fetch                        # Fetch web pages
    - mcp                              # Use MCP servers
    - subagent                         # Launch sub-agents
```

-----

## CLAUDE.md Template

Each fund gets a `CLAUDE.md` that serves as Claude Code’s constitution for that fund. This is auto-generated from `fund_config.yaml` but can be manually customized.

```markdown
# Fund: {fund_name}

## Identity
You are the AI fund manager for "{display_name}".
{personality}

## Objective
{objective_description}

## Current State
- Read `state/portfolio.json` for current holdings
- Read `state/objective_tracker.json` for progress toward goal
- Read `state/session_log.json` for what happened last session
- Browse `analysis/` for past analyses you've written

## Constraints
- Max drawdown: {max_drawdown_pct}%
- Max position size: {max_position_pct}%
- Stop loss: {stop_loss_pct}% per position
- Allowed assets: {universe_summary}
- Forbidden: {forbidden_summary}
- Custom rules: {custom_rules}

## Decision Framework
{decision_framework}

## Session Protocol
1. ALWAYS start by reading your current state files
2. NEVER trade without updating state files after
3. ALWAYS write an analysis report to `analysis/{date}_{session}.md`
4. ALWAYS update `state/objective_tracker.json` with current runway/progress
5. Send Telegram notification for any trade or significant insight
6. If uncertain about a trade, DON'T do it. Document why in analysis.

## Tools Available
- Create and execute TypeScript/JavaScript scripts for any analysis
- Use web search for news, macro data, sentiment
- Use MCP servers: {mcp_servers_list}
- Launch sub-agents for parallel analysis (macro, technical, sentiment, risk)
- Read and write to your persistent state

## Memory
Your `state/trade_journal.sqlite` contains all past trades with:
- Entry/exit prices and dates
- Your reasoning at the time
- Outcome and lessons learned
- Vector embeddings for similarity search

Use this to learn from your own history. Before making a trade, check
if you've seen a similar setup before and what happened.

## Communication
- Telegram MCP for notifications to the user
- Write reports in markdown to `reports/`
- Be concise in Telegram, detailed in reports
```

-----

## CLI Interface

### Technology Stack

- **Language:** TypeScript (Node.js 20+)
- **CLI Framework:** Commander.js or oclif
- **Rich Output:** Ink (React for CLI) + chalk
- **Interactive Prompts:** @inquirer/prompts
- **Configuration:** YAML (yaml / js-yaml)
- **Database:** SQLite (better-sqlite3 or drizzle-orm)
- **Daemon:** node-cron or Bree
- **Telegram:** grammy (modern Telegram bot framework)
- **Package:** npm/pnpm installable via package.json

### Command Reference

```
fundx --help

Usage: fundx <command> [options]

  FundX — Autonomous AI Fund Manager powered by Claude Code

Core Commands:
  init                              Initialize FundX workspace
  status                            Dashboard of all funds and services
  start [fund|all]                  Start daemon and/or specific fund
  stop [fund|all]                   Stop daemon and/or specific fund
  logs [fund] [-f|--follow]         View daemon/fund logs

Fund Management:
  fund create                       Interactive fund creation wizard
  fund edit <name>                  Edit fund configuration (opens in $EDITOR or interactive)
  fund info <name>                  Detailed fund information
  fund list                         List all funds with status summary
  fund pause <name>                 Pause a fund (keeps state)
  fund resume <name>                Resume a paused fund
  fund delete <name>                Delete a fund (requires confirmation)
  fund clone <source> <new_name>    Clone fund configuration as template

Analysis & Interaction:
  ask <fund> "<question>"           Wake Claude to answer about a specific fund
  ask --cross "<question>"          Cross-fund analysis (Claude reads all fund states)
  report <fund> [--date DATE]       View analysis report for a date
  report <fund> --weekly            Weekly performance summary
  report <fund> --monthly           Monthly performance summary
  journal <fund>                    Browse trade journal interactively

Portfolio & Performance:
  portfolio <fund>                  Current holdings and allocation
  portfolio <fund> --history        Historical allocation over time
  trades <fund> [--today|--week]    Recent trades
  performance <fund>                Performance metrics and charts

Sessions:
  session run <fund> <type>         Manually trigger a session (pre/mid/post)
  session history <fund>            View past sessions and outcomes
  session next                      Show upcoming scheduled sessions

Configuration:
  config show                       View global configuration
  config set <key> <value>          Update global config value
  config broker                     Configure broker connection
  config telegram                   Configure Telegram bot
  config claude                     Configure Claude Code path and model

Templates:
  template list                     List available fund templates
  template export <fund> <file>     Export fund config as reusable template
  template import <file>            Create new fund from template
```

### CLI Flow Examples

#### `fundx init`

```
$ fundx init

  ███████╗██╗   ██╗███╗   ██╗██████╗ ██╗  ██╗
  ██╔════╝██║   ██║████╗  ██║██╔══██╗╚██╗██╔╝
  █████╗  ██║   ██║██╔██╗ ██║██║  ██║ ╚███╔╝
  ██╔══╝  ██║   ██║██║╚██╗██║██║  ██║ ██╔██╗
  ██║     ╚██████╔╝██║ ╚████║██████╔╝██╔╝ ██╗
  ╚═╝      ╚═════╝ ╚═╝  ╚═══╝╚═════╝ ╚═╝  ╚═╝
  Autonomous AI Fund Manager v0.1.0

  ? Claude Code path: /usr/local/bin/claude ✓ detected (v2.1.x)
  ? Default model: Opus 4.6
  ? Default timezone: America/Montevideo
  ? Telegram Bot Token: ●●●●●●●●●●●●●●
  ? Your Telegram Chat ID: 123456789
  ? Default broker:
    ❯ Alpaca (stocks, ETFs, options)
      Interactive Brokers
      Binance (crypto)
      Manual (no auto-execution)
  ? Alpaca API Key: ●●●●●●●●●●
  ? Alpaca Secret Key: ●●●●●●●●●●
  ? Alpaca mode: Paper trading

  ✓ Workspace initialized at ~/.fundx/
  ✓ Claude Code verified (Opus 4.6 available)
  ✓ Telegram bot connected (@YourFundxBot)
  ✓ Alpaca API verified (paper mode)

  Next: Run 'fundx fund create' to create your first fund.
```

#### `fundx fund create`

```
$ fundx fund create

  ┌─ New Fund ───────────────────────────────────────────────┐

  ? Fund name (slug): runway
  ? Display name: Runway Fund
  ? Description: Capital de despido - sustain living expenses

  ── Objective ──
  ? Goal type:
    ❯ 🛡️  Runway — Sustain monthly expenses for N months
      📈 Growth — Multiply capital by a target
      🪙  Accumulation — Acquire a target amount of an asset
      💰 Income — Generate passive monthly income
      ⚙️  Custom — Define your own objective

  ? Initial capital (USD): 30000
  ? Monthly burn rate (USD): 2000
  ? Minimum cash reserve (months): 3

  ── Risk Profile ──
  ? Risk tolerance:
      🟢 Conservative (max DD: 10%, max pos: 15%)
    ❯ 🟡 Moderate (max DD: 15%, max pos: 25%)
      🔴 Aggressive (max DD: 25%, max pos: 40%)
      ⚙️  Custom

  ? Additional risk rules (one per line, empty to skip):
    > Never hold more than 3 leveraged ETFs simultaneously
    > Keep minimum 30% in cash
    >

  ── Asset Universe ──
  ? Allowed asset types: (space to select)
    ◉ ETFs
    ◉ Stocks
    ◯ Options
    ◯ Crypto
    ◯ DeFi

  ? Specific tickers (comma separated, empty = any):
    > GDX, GDXJ, SLV, GLD, UGL, AGQ, JNUG

  ── Schedule ──
  ? Trading sessions: (space to select)
    ◉ Pre-market    09:00 UYT
    ◉ Mid-session   13:00 UYT
    ◉ Post-market   18:00 UYT
    ◯ Overnight     23:00 UYT

  ? Edit session times? (y/N): N

  ── Broker ──
  ? Broker: Alpaca (from global config)
  ? Mode:
    ❯ 📋 Paper trading (recommended to start)
      💵 Live trading

  ── Notifications ──
  ? Telegram alerts: (space to select)
    ◉ Trade executed
    ◉ Stop-loss triggered
    ◉ Daily digest (end of day)
    ◉ Weekly digest
    ◉ Runway warning (< N months)
    ◯ Every analysis report

  ── AI Personality ──
  ? Claude's approach for this fund:
    ❯ 🛡️  Conservative (capital preservation first)
      ⚖️  Balanced (equal weight to growth and protection)
      🎯 Opportunistic (actively seek alpha within constraints)
      ✍️  Custom (write your own prompt)

  ┌─ Summary ────────────────────────────────────────────────┐
  │                                                           │
  │  Fund: runway (Runway Fund)                               │
  │  Objective: 18 months runway at $2,000/mo                 │
  │  Capital: $30,000 | Risk: Moderate                        │
  │  Assets: GDX, GDXJ, SLV, GLD, UGL, AGQ, JNUG            │
  │  Schedule: 3 sessions/day Mon-Fri (UYT)                   │
  │  Broker: Alpaca (paper)                                   │
  │  AI: Conservative capital preservation                    │
  │                                                           │
  └───────────────────────────────────────────────────────────┘

  ? Create this fund? (Y/n): Y

  ✓ Fund 'runway' created at ~/.fundx/funds/runway/
  ✓ CLAUDE.md generated
  ✓ fund_config.yaml saved
  ✓ State directory initialized
  ✓ MCP servers configured

  Start trading: fundx start runway
  View status:   fundx status
```

#### `fundx status`

```
$ fundx status

  ┌─ FundX Dashboard ──────────────────────────────────────────────────┐
  │                                                                     │
  │  DAEMON: ● Running (PID 4521)    TELEGRAM: ● Connected             │
  │  CLAUDE: ● Available (Opus 4.6)  BROKER:   ● Alpaca (paper)        │
  │                                                                     │
  │  ┌─ 🛡️  runway ─────────────────────────────────────────────────┐  │
  │  │  Status: ● Active       Last: Pre-market (09:03)             │  │
  │  │                                                               │  │
  │  │  Capital: $30,000 → $31,240 (+4.1%)                          │  │
  │  │  🎯 Runway: 15.6 months remaining (target: 18)               │  │
  │  │                                                               │  │
  │  │  Positions:                                                   │  │
  │  │    GDXJ  35%  ████████████░░░░  +2.3%                       │  │
  │  │    AGQ   20%  ███████░░░░░░░░░  +1.8%                       │  │
  │  │    Cash  45%  ██████████████░░                               │  │
  │  │                                                               │  │
  │  │  Today: +$127 | Week: +$540 | Month: +$1,240                │  │
  │  │  Next session: Mid-session in 2h 14m                         │  │
  │  └───────────────────────────────────────────────────────────────┘  │
  │                                                                     │
  │  ┌─ 📈 growth ──────────────────────────────────────────────────┐  │
  │  │  Status: ● Active       Last: Pre-market (09:05)             │  │
  │  │                                                               │  │
  │  │  Capital: $10,000 → $10,870 (+8.7%)                          │  │
  │  │  🎯 Target: 2x ($20,000) — 34% complete                     │  │
  │  │                                                               │  │
  │  │  Positions:                                                   │  │
  │  │    NVDA  40%  █████████████░░░  +12.1%                      │  │
  │  │    AMD   25%  ████████░░░░░░░░  +4.2%                       │  │
  │  │    Cash  35%  ███████████░░░░░                               │  │
  │  │                                                               │  │
  │  │  Today: -$43 | Week: +$220 | Month: +$870                   │  │
  │  │  Next session: Mid-session in 2h 14m                         │  │
  │  └───────────────────────────────────────────────────────────────┘  │
  │                                                                     │
  │  ┌─ 🪙 btc-accumulation ────────────────────────────────────────┐  │
  │  │  Status: ◐ Paused       Last: 2026-02-20 18:00              │  │
  │  │                                                               │  │
  │  │  Capital: $5,000 → $5,340 (+6.8%)                            │  │
  │  │  🎯 Target: 1 BTC — holding 0.047 BTC (4.7%)                │  │
  │  │  Next session: Paused                                        │  │
  │  └───────────────────────────────────────────────────────────────┘  │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘
```

#### `fundx ask`

```
$ fundx ask runway "por qué vendiste GDXJ ayer?"

  ⏳ Waking up Claude for fund 'runway'...
  📖 Loading: trade journal, yesterday's analysis...

  ╭─ Claude @ runway ───────────────────────────────────────────╮
  │                                                              │
  │  Vendí 60% de GDXJ ayer en post-market por 3 razones:      │
  │                                                              │
  │  1. Divergencia bajista en RSI diario — precio haciendo     │
  │     higher highs, RSI haciendo lower highs desde el 18/02   │
  │                                                              │
  │  2. DXY rebotó en soporte 103.20, históricamente            │
  │     presiona gold miners 2-3 días después                    │
  │                                                              │
  │  3. Position size era 35% del portfolio. Con earnings de    │
  │     Barrick Gold hoy, el risk/reward no justificaba         │
  │     mantener posición tan grande                             │
  │                                                              │
  │  Resultado: vendí a $45.20 (compra fue $43.10, +4.8%)      │
  │  Mantuve 40% como core position.                             │
  │                                                              │
  │  📄 Análisis completo: ~/.fundx/funds/runway/analysis/      │
  │     2026-02-21_post.md                                       │
  │                                                              │
  ╰──────────────────────────────────────────────────────────────╯

  💬 Follow-up? (empty to exit): _
```

#### `fundx ask --cross`

```
$ fundx ask --cross "cuál de mis fondos tiene más riesgo esta semana?"

  ⏳ Cross-fund analysis...
  📖 Loading states: runway, growth, btc-accumulation...

  ╭─ Claude @ cross-fund ───────────────────────────────────────╮
  │                                                              │
  │  Fund 'growth' tiene el mayor riesgo esta semana:           │
  │                                                              │
  │  • 65% concentrado en semiconductores (NVDA+AMD)            │
  │  • NVDA earnings jueves — implied vol en máx de 3 meses    │
  │  • Drawdown estimado si NVDA cae >5%: ~8.2% ($890)         │
  │                                                              │
  │  Runway está más protegido (45% cash, posiciones diversif.) │
  │  BTC-accumulation está pausado, sin exposición activa.       │
  │                                                              │
  │  Recomendación: mañana en pre-market evaluaré reducir       │
  │  NVDA a 25% en 'growth' antes de earnings.                  │
  │                                                              │
  ╰──────────────────────────────────────────────────────────────╯
```

-----

## Daemon & Session Runner

### How Sessions Work

The daemon checks every minute which funds have pending sessions and launches Claude Code with the appropriate context:

```typescript
// Pseudocode — session_runner.ts

import { execFile } from "node:child_process";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { logSession } from "./logger.js";

async function runSession(fundName: string, sessionType: string) {
  const fundDir = join(WORKSPACE, "funds", fundName);
  const config = await loadConfig(join(fundDir, "fund_config.yaml"));

  // Build the prompt based on session type
  const sessionConfig = config.schedule.sessions[sessionType];
  const today = new Date().toISOString().split("T")[0];

  const prompt = `
    You are running a ${sessionType} session for fund '${fundName}'.

    Focus: ${sessionConfig.focus}

    Start by reading your state files, then proceed with analysis
    and actions as appropriate. Remember to:
    1. Update state files after any changes
    2. Write analysis to analysis/${today}_${sessionType}.md
    3. Send Telegram notifications for trades or important insights
    4. Update objective_tracker.json
  `;

  // Launch Claude Code in the fund's directory
  const result = await execFileAsync("claude", [
    "--project-dir", fundDir,
    "--prompt", prompt,
    "--allowedTools", "bash,write,read,web_search,web_fetch,mcp",
    "--model", config.claude.model,
    "--max-turns", "50",
  ], {
    timeout: (sessionConfig.maxDurationMinutes ?? 15) * 60 * 1000,
  });

  // Log session result
  await logSession(fundName, sessionType, result);
}
```

### Daemon Modes

```bash
# Start daemon (background process)
fundx start
# → Starts scheduler + Telegram bot

# Start only a specific fund
fundx start runway

# Manual session trigger (useful for testing)
fundx session run runway pre_market

# View upcoming sessions
fundx session next
# ┌─────────────┬──────────┬───────┬──────────┐
# │ Fund        │ Session  │ Time  │ In       │
# ├─────────────┼──────────┼───────┼──────────┤
# │ runway      │ mid      │ 13:00 │ 1h 42m   │
# │ growth      │ mid      │ 13:30 │ 2h 12m   │
# │ runway      │ post     │ 18:00 │ 6h 42m   │
# │ growth      │ post     │ 18:00 │ 6h 42m   │
# └─────────────┴──────────┴───────┴──────────┘
```

-----

## Telegram Integration

### Bot Commands (Quick — No Claude needed)

These read directly from state files and respond instantly:

```
/status                    → Summary of all funds
/status runway             → Specific fund status  
/portfolio runway          → Current holdings
/runway                    → Months remaining (for runway funds)
/trades runway today       → Today's trades
/pause growth              → Pause a fund
/resume growth             → Resume a fund
/next                      → Next scheduled sessions
```

### Free Questions (Wake Claude)

Any message that isn’t a command wakes Claude Code:

```
User: "qué opinas de gold esta semana?"
Bot:  ⏳ Waking up Claude...
Bot:  [Claude's analysis]

User: "por qué no compraste JNUG en el dip de ayer?"
Bot:  ⏳ Checking fund 'runway'...
Bot:  [Claude explains, referencing its analysis archive]

User: "comparame el rendimiento de los 3 fondos este mes"
Bot:  ⏳ Cross-fund analysis...
Bot:  [Claude reads all fund states and compares]
```

### Auto-Fund Detection

The gateway detects which fund a message relates to:

- Mentions a ticker in a specific fund’s universe → that fund
- Mentions fund name → that fund
- Ambiguous → asks which fund
- General question → cross-fund analysis

### Notification Examples

```
📊 Daily Digest — runway (Feb 22)
──────────────────────────
P&L: +$127 (+0.4%)
Runway: 15.6 months
Trades: Sold 60% GDXJ @ $45.20 (+4.8%)
Cash: 45% | Exposure: 55%
Top mover: AGQ +3.2%

⚠️ STOP-LOSS — runway
──────────────────────────
JNUG hit stop-loss at $38.50 (-8%)
Position closed: 100 shares
Loss: -$335
Action: Moved to cash, will reassess in post-market

🎯 Milestone — growth  
──────────────────────────
Fund 'growth' reached 50% of target!
$10,000 → $15,000 (+50%)
Target: $20,000 (2x)
```

-----

## MCP Servers

### Required MCP Servers

|Server           |Purpose                                    |Priority|
|-----------------|-------------------------------------------|--------|
|`broker-alpaca`  |Execute trades, get positions, account info|P0 (MVP)|
|`market-data`    |Price data, indicators (Yahoo Finance/AV)  |P0 (MVP)|
|`telegram-notify`|Send messages to Telegram                  |P0 (MVP)|
|`news-sentiment` |Web scraping for financial news            |P1      |
|`broker-binance` |Crypto trading                             |P2      |
|`broker-ibkr`    |International markets                      |P2      |

### MCP Server Example (broker-alpaca)

```
Tools:
  get_account()              → Account balance, buying power, equity
  get_positions()            → Current positions with P&L
  get_position(symbol)       → Specific position details
  place_order(symbol, qty,   → Place market/limit/stop order
    side, type, limit_price,
    stop_price, time_in_force)
  cancel_order(order_id)     → Cancel open order
  get_orders(status)         → List open/closed/all orders
  get_bars(symbol, timeframe,→ OHLCV data
    start, end)
  get_quote(symbol)          → Real-time quote
```

-----

## State Management

### portfolio.json

```json
{
  "last_updated": "2026-02-22T18:00:00-03:00",
  "cash": 13500.00,
  "total_value": 31240.00,
  "positions": [
    {
      "symbol": "GDXJ",
      "shares": 150,
      "avg_cost": 43.10,
      "current_price": 45.20,
      "market_value": 6780.00,
      "unrealized_pnl": 315.00,
      "unrealized_pnl_pct": 4.87,
      "weight_pct": 21.7,
      "stop_loss": 41.50,
      "entry_date": "2026-02-18",
      "entry_reason": "Gold breakout above 200-day MA"
    },
    {
      "symbol": "AGQ",
      "shares": 80,
      "avg_cost": 40.50,
      "current_price": 42.30,
      "market_value": 3384.00,
      "unrealized_pnl": 144.00,
      "unrealized_pnl_pct": 4.44,
      "weight_pct": 10.8,
      "stop_loss": 37.26,
      "entry_date": "2026-02-19",
      "entry_reason": "Silver momentum following gold"
    }
  ]
}
```

### objective_tracker.json (Runway Example)

```json
{
  "type": "runway",
  "initial_capital": 30000,
  "current_value": 31240,
  "monthly_burn": 2000,
  "months_remaining": 15.6,
  "target_months": 18,
  "min_reserve_months": 3,
  "min_reserve_value": 6000,
  "available_for_investment": 25240,
  "progress_pct": 86.7,
  "status": "on_track",
  "milestones": [
    { "date": "2026-02-25", "event": "First profitable week", "value": 30540 },
    { "date": "2026-03-01", "event": "Recovered initial capital", "value": 30120 }
  ],
  "projections": {
    "conservative": { "months": 14.2, "assumes": "0% return, $2k/mo burn" },
    "base_case": { "months": 16.8, "assumes": "5% annual return" },
    "optimistic": { "months": 19.5, "assumes": "12% annual return" }
  }
}
```

### trade_journal.sqlite

```sql
CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    fund TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,           -- buy | sell
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    total_value REAL NOT NULL,
    order_type TEXT NOT NULL,     -- market | limit | stop
    
    -- Context
    session_type TEXT,            -- pre_market | mid_session | post_market | on_demand
    reasoning TEXT,               -- Claude's explanation
    analysis_ref TEXT,            -- Path to analysis file
    
    -- Outcome (filled on close)
    closed_at TEXT,
    close_price REAL,
    pnl REAL,
    pnl_pct REAL,
    lessons_learned TEXT,
    
    -- For similarity search
    market_context TEXT,          -- JSON: DXY, VIX, sector performance, etc.
    embedding BLOB               -- 384-dim vector for similarity search
);

CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    timestamp TEXT NOT NULL,
    fund TEXT NOT NULL,
    session_type TEXT NOT NULL,
    duration_seconds INTEGER,
    trades_executed INTEGER,
    analysis_file TEXT,
    summary TEXT,
    claude_model TEXT
);
```

-----

## Development Roadmap

### Phase 1 — MVP (Foundation)

- [ ] Project structure + package.json + tsconfig.json
- [ ] `fundx init` (workspace setup)
- [ ] `fundx fund create` (interactive wizard)
- [ ] `fundx fund list` / `fundx fund info`
- [ ] `fundx status` (read from state files)
- [ ] CLAUDE.md template generation
- [ ] fund_config.yaml schema + validation
- [ ] State file initialization (portfolio.json, objective_tracker.json)
- [ ] Basic daemon with node-cron or Bree
- [ ] Session runner (launches Claude Code)
- [ ] `fundx start` / `fundx stop`
- [ ] `fundx logs`
- [ ] `fundx session run` (manual trigger)

### Phase 2 — Broker & Trading

- [ ] MCP server: broker-alpaca (paper trading)
- [ ] MCP server: market-data (Yahoo Finance / Alpha Vantage wrapper)
- [ ] Portfolio state auto-sync from broker
- [ ] Trade execution + journal logging
- [ ] Stop-loss monitoring
- [ ] `fundx portfolio` / `fundx trades`
- [ ] `fundx performance`

### Phase 3 — Telegram

- [ ] Telegram bot (always-on)
- [ ] Quick commands (/status, /portfolio, /runway, etc.)
- [ ] Notification system (trade alerts, digests, warnings)
- [ ] Free question → wake Claude flow
- [ ] Auto-fund detection
- [ ] Quiet hours

### Phase 4 — Intelligence

- [ ] Sub-agent parallel execution (macro, technical, sentiment, risk)
- [ ] `fundx ask` (CLI → Claude wake)
- [ ] `fundx ask --cross` (cross-fund analysis)
- [ ] Trade journal vector embeddings + similarity search
- [ ] Analysis archive with searchable history
- [ ] Reusable scripts persistence (scripts Claude creates and wants to keep)
- [ ] Skills library (technical analysis, sentiment, etc.)

### Phase 5 — Advanced

- [ ] Live trading mode (with safety confirmations)
- [ ] Multiple broker support (IBKR, Binance)
- [ ] Fund templates (export/import)
- [ ] `fundx fund clone`
- [ ] Special sessions (FOMC, OpEx, etc.)
- [ ] Performance charting (terminal-based with Ink or cli-chart)
- [ ] Daily/weekly/monthly auto-reports
- [ ] Cross-fund correlation monitoring
- [ ] Runway projections with Monte Carlo simulation

### Phase 6 — Community & Polish

- [ ] `npm install -g fundx` / `npx fundx` distribution
- [ ] Comprehensive documentation
- [ ] Example funds (templates) for common objectives
- [ ] Plugin system for custom MCP servers
- [ ] Web dashboard (optional, lightweight)
- [ ] Multi-user support (different Telegram users)

-----

## Tech Stack Summary

|Component  |Technology                              |Why                                        |
|-----------|----------------------------------------|-------------------------------------------|
|CLI        |TypeScript + Commander.js/oclif + Ink   |Best DX for interactive CLIs               |
|Config     |YAML (yaml / js-yaml)                   |Human-readable, git-friendly               |
|State DB   |SQLite (better-sqlite3 / drizzle-orm)   |Zero-config, file-based, embedded          |
|Vectors    |sqlite-vec or transformers.js           |Trade similarity search                    |
|Daemon     |node-cron or Bree                       |Cron-like but in-process, timezone-aware   |
|Telegram   |grammy                                  |Modern, TypeScript-first Telegram framework|
|AI Engine  |Claude Code (CLI)                       |Leverages subscription, full autonomy      |
|MCP Servers|TypeScript (MCP SDK)                    |Best MCP ecosystem support                 |
|Broker     |Alpaca API (@alpacahq/alpaca-trade-api) |Best API for US stocks/ETFs                |
|Market Data|Yahoo Finance API + Alpha Vantage       |Free, reliable                             |
|Package    |package.json + npm/pnpm                 |Standard Node.js distribution              |

-----

## Key Design Principles

1. **Goal-first, not trade-first.** Every decision is evaluated against the fund’s life objective, not just P&L.
1. **Claude as artisan.** No pre-defined analysis pipeline. Claude creates what it needs each session — scripts, calculations, research — like a human analyst would.
1. **Declarative funds.** A fund is fully defined by its `fund_config.yaml`. Everything else is derived or generated.
1. **State is king.** Everything persists between sessions. Claude always knows where it left off.
1. **Human in the loop, but not in the way.** The system runs autonomously but the human can always intervene via CLI or Telegram.
1. **Paper first, live later.** Every fund starts in paper mode. Switching to live requires explicit confirmation.
1. **Memory makes it smarter.** The trade journal + vector search means Claude learns from its own history within each fund.
1. **Open and extensible.** New brokers, new MCP servers, new objective types — all pluggable.

-----

## License

TBD — Considering MIT or Apache 2.0 for maximum community adoption.

-----

## Contributing

TBD — Will set up contribution guidelines after MVP.
