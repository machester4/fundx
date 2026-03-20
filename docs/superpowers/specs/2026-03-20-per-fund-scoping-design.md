# Per-Fund Scoping Design

## Problem

FundX mixes global and fund-specific views in a single dashboard. The chat context is ambiguous — users don't always know which fund they're interacting with. Telegram auto-detects funds unreliably. There's no per-fund memory system for the agent to learn across sessions.

## Design Decisions

- **Fund selector:** `fundx` without arguments shows a simple fund list picker, not a full dashboard
- **Fund dashboard:** `fundx --fund X` enters a dedicated dashboard scoped entirely to one fund
- **Telegram:** All fund-specific commands require explicit fund name prefix, no auto-detect
- **Agent memory:** Per-fund `memory/` directory at fund root; agent reads via tool use, instructed by a `.claude/rules/` rule
- **Single fund auto-select:** If only 1 fund exists, skip selector and enter its dashboard directly

## Sub-projects

This is sub-project 1 of 3:
1. **Per-fund scoping** (this spec) — architectural separation of fund context
2. **UX reorganization** — command consistency, visual polish (future)
3. **Advanced memory** — memory categorization, retrieval patterns (future)

---

## Section 1: Fund Selector (`fundx` default command)

Replaces the current multi-panel dashboard as the default command.

### Behavior

1. **Logo + welcome** — FundX ASCII banner, version
2. **Fund list** — Interactive `Select` component showing each fund:
   - Display name + internal name
   - Status badge (active/paused/closed)
   - Capital: initial → current, P&L colored
   - Last session relative time ("2h ago", "never")
3. **Selection** → transitions to fund dashboard (same process, state machine phase change)
4. **No funds exist** → offer to create one (existing fund creation wizard)
5. **Single fund** → skip selector, enter fund dashboard directly

### Keyboard

- `Enter` — select fund, enter dashboard
- `c` — create new fund
- `q` — quit

### State Machine

```
loading → selecting → fund-dashboard
              ↑              │
              └── Esc ───────┘
```

### Implementation

- Refactor `src/commands/index.tsx` — replace current multi-panel dashboard with phased UI
- Phase `selecting`: render fund list with `Select` from `@inkjs/ui`
- Phase `fund-dashboard`: render fund-scoped dashboard (Section 2)
- Data: use `getDashboardData()` from `status.service.ts` which returns enriched fund data (display name, current value, P&L, status, last session). Do NOT use `useAllFunds` (returns only names).
- Reuse existing `FundSelector` component (`src/components/FundSelector.tsx`) as a starting point, enhance with richer fund data display
- Reuse `StatusBadge`, `PnlText` components for list items

### Modified files

- `src/commands/index.tsx` — complete refactor of default command

---

## Section 2: Fund Dashboard

Entered via fund selector or `fundx --fund X`. Entirely scoped to one fund.

### Layout (vertical, top to bottom)

1. **Header bar** — Fund display name, status badge, trading mode (paper/live), Claude model
2. **Portfolio panel** — Compact holdings table: symbol, shares, value, P&L per position. Cash + total value.
3. **Objective progress** — Single-line progress bar toward fund goal (e.g., "Runway: 14/18 months, 78%")
4. **Chat REPL** — Full-width, always active. Scoped to this fund. Loads fund's CLAUDE.md, skills, rules, memory, and MCP servers.

### What's removed from the current dashboard

These panels are NOT shown in the fund dashboard:
- MarketTickerBanner (global market data — agent gets this via MCP when needed)
- FundsOverviewPanel (shows all funds — belongs in selector, not fund dashboard)
- NewsPanel (global news — agent gets this via MCP)
- SectorHeatmapPanel (global — not fund-scoped)
- SystemStatusPanel (daemon/telegram status — operational, not fund-scoped)

### Keyboard

- `Esc` — return to fund selector (only when chat input is empty)
- Chat input always active (same as current ChatView behavior)
- Quit via `/q` in chat (existing behavior) or `Ctrl+C`

### Components

**Reused:** ChatView, PnlText, StatusBadge, Header, BarChart
**New:**
- `FundDashboardHeader.tsx` — compact header with fund name, status, mode, model
- `PortfolioPanel.tsx` — compact positions table (different from full `fundx portfolio` command)
- `ObjectiveProgressBar.tsx` — single-line progress toward fund goal

**Existing panels kept for CLI commands:** The existing `fundx status`, `fundx portfolio`, etc. commands remain unchanged. They are standalone CLI commands, not part of the dashboard.

### Data Loading

- Fund config via `loadFundConfig(fundName)`
- Portfolio via `readPortfolio(fundName)`
- Objective tracker via `readTracker(fundName)`
- Chat context via `buildChatContext(fundName)` (existing)
- Refresh portfolio on interval (reuse `useInterval` hook)

### Modified files

- `src/commands/index.tsx` — fund dashboard phase
- `src/components/FundDashboardHeader.tsx` — new
- `src/components/PortfolioPanel.tsx` — new
- `src/components/ObjectiveProgressBar.tsx` — new

---

## Section 3: Telegram — Fund Prefix

Simplify the Telegram bot. Remove auto-detection. All fund-specific commands require the fund name as the first argument.

### Fund-scoped commands

| Command | Example | Behavior |
|---------|---------|----------|
| `/status <fund>` | `/status growth` | Show fund status, P&L, last session |
| `/portfolio <fund>` | `/portfolio runway-metal` | Current holdings |
| `/trades <fund>` | `/trades prueba` | Recent trades |
| `/pause <fund>` | `/pause growth` | Pause fund |
| `/resume <fund>` | `/resume growth` | Resume fund |
| `/ask <fund> <question>` | `/ask growth how is tech?` | Wake Claude for this fund |

### Global commands (no fund arg)

| Command | Behavior |
|---------|----------|
| `/status` (no arg) | List all funds with name, status, P&L summary |
| `/next` | Show upcoming scheduled sessions across all funds |
| `/help` | List available commands with syntax |

### Free-text messages

Free-text messages (no command prefix) are **ignored** by the bot. Users must use `/ask <fund> <question>` for questions. This eliminates the unreliable auto-detect logic.

### Removed features

- `detectFund()` auto-detection — replaced by explicit fund argument
- Dynamic `/<fundname>` commands — replaced by `/status <fund>`
- Dynamic `/ask_<fundname>` commands — replaced by `/ask <fund> <question>`
- Free-text catch-all handler — removed (use `/ask` instead)

### Missing fund argument

When a fund-scoped command is called without a fund name, respond with:
```
Usage: /portfolio <fund>
Available funds: growth, runway-metal, prueba
```

### Changes to `gateway.service.ts`

- Remove `detectFund()` / auto-detection logic
- Each handler parses first arg as fund name via `ctx.match?.trim().split(/\s+/)`
- Validate fund exists via `listFundNames()` before proceeding
- Simplifies all handlers significantly (no guessing)

### Modified files

- `src/services/gateway.service.ts` — simplify all handlers, remove auto-detect

---

## Section 4: Per-Fund Agent Memory

Memory files live at the **fund root** (`~/.fundx/funds/<name>/memory/`), not under `.claude/`. The Agent SDK only auto-loads `.claude/rules/`, `.claude/skills/`, and `CLAUDE.md` — it does NOT auto-load arbitrary subdirectories. Instead, a rule in `.claude/rules/memory-usage.md` instructs the agent to read memory files at session start using the `Read` tool.

### Directory structure

```
~/.fundx/funds/<name>/
├── memory/
│   ├── MEMORY.md           # Index of memory files
│   ├── market-lessons.md   # Market patterns and lessons learned
│   ├── trading-patterns.md # Trading behavior observations
│   └── fund-notes.md       # General fund observations
├── .claude/
│   ├── rules/
│   │   ├── state-consistency.md  # Existing
│   │   └── memory-usage.md      # NEW: instructs agent to read/write memory/
│   └── skills/
│       └── ... (7 existing skills)
└── CLAUDE.md
```

### How memory loading works

1. Agent SDK auto-loads `.claude/rules/memory-usage.md` (this is a rule, always injected)
2. The rule instructs the agent: "At the start of every session, read `memory/MEMORY.md` to recall past observations. Read individual memory files as needed."
3. The agent uses its `Read` tool to load memory files from `cwd` (the fund directory)
4. The agent uses its `Write` tool to update memory files during sessions

**No changes to `agent.ts`, `session.service.ts`, or `chat.service.ts`** — the agent already has read/write access to its `cwd`.

### MEMORY.md (initial content)

```markdown
# Fund Memory

Memory files for this fund. Updated by the AI agent during sessions.

- [market-lessons.md](market-lessons.md) — Market patterns and lessons learned
- [trading-patterns.md](trading-patterns.md) — Trading behavior observations
- [fund-notes.md](fund-notes.md) — General fund observations
```

### memory-usage.md (new rule)

Instructs the agent to:
- At the start of every session, read `memory/MEMORY.md` to recall past observations
- Read individual memory files as needed based on the session focus
- Write new observations when discovering relevant patterns (market behavior, trade outcomes, strategy adjustments)
- Keep memories concise and actionable — facts and lessons, not raw data
- Do not duplicate information already in CLAUDE.md, fund_config.yaml, or state files
- Use memory to inform decisions, not to store data that belongs in state files

### Initial memory file content

Each file starts with a header and empty content:

```markdown
---
description: [one-line description]
---

(No observations yet. The AI agent will populate this during trading sessions.)
```

### Generation

- `fundx fund create` → generates `memory/` directory with initial files + `rules/memory-usage.md`
- `fundx fund upgrade` → adds memory files and rule if they don't exist (backward compat)
- Agent reads/writes memory files during sessions via tool use (has access to cwd)

### Modified files

- `src/skills.ts` — add `FUND_MEMORY_FILES` constant with initial memory file content, add `MEMORY_USAGE_RULE` content, add `ensureFundMemory()` function
- `src/services/fund.service.ts` — call `ensureFundMemory()` during fund creation and upgrade
- `src/paths.ts` — add `memory` directory to `fundPaths()` return object

---

## Files Summary

### New files

| File | Purpose |
|------|---------|
| `src/components/FundDashboardHeader.tsx` | Compact fund header (name, status, mode) |
| `src/components/PortfolioPanel.tsx` | Compact positions table for dashboard |
| `src/components/ObjectiveProgressBar.tsx` | Single-line progress toward fund goal |

### Modified files

| File | Changes |
|------|---------|
| `src/commands/index.tsx` | Complete refactor: fund selector → fund dashboard phases |
| `src/services/gateway.service.ts` | Remove auto-detect, require fund prefix on all commands |
| `src/skills.ts` | Add memory file content, memory usage rule, `ensureFundMemory()` |
| `src/services/fund.service.ts` | Call `ensureFundMemory()` on fund creation and upgrade |
| `src/paths.ts` | Add `memory` directory to `fundPaths()` |
| `src/components/FundSelector.tsx` | Enhance with richer fund data display |

### Migration

Existing funds created before this change will get memory files when running `fundx fund upgrade`. No data migration needed. The fund selector replaces the default dashboard but all existing CLI commands (`fundx status`, `fundx portfolio`, etc.) remain unchanged.

### Unchanged

- `src/agent.ts` — no changes (agent reads memory via tool use, instructed by rule)
- `src/services/session.service.ts` — no changes
- `src/services/chat.service.ts` — no changes (fund context already works)
- `src/services/daemon.service.ts` — no changes
- All existing CLI commands (`fundx status`, `fundx portfolio`, etc.) — unchanged
