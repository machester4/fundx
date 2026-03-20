# Per-Fund Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize FundX UX so each fund has its own dedicated dashboard and chat, Telegram commands require explicit fund names, and each fund has a memory system for the agent to learn across sessions.

**Architecture:** Replace the current multi-panel global dashboard with a two-phase UI: fund selector (pick a fund) then fund dashboard (panels + chat scoped to that fund). Simplify Telegram by removing auto-detect and requiring fund prefix. Add per-fund `memory/` directory at fund root with a rule that teaches the agent to read/write it.

**Tech Stack:** TypeScript, React/Ink, @inkjs/ui (Select), grammy (Telegram), Agent SDK

**Spec:** `docs/superpowers/specs/2026-03-20-per-fund-scoping-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/components/FundDashboardHeader.tsx` | Compact header: fund name, status badge, mode, model |
| `src/components/PortfolioPanel.tsx` | Compact positions table for fund dashboard |
| `src/components/ObjectiveProgressBar.tsx` | Single-line progress bar toward fund goal |

### Modified files

| File | Changes |
|------|---------|
| `src/commands/index.tsx` | Complete refactor: fund selector → fund dashboard state machine |
| `src/components/FundSelector.tsx` | Enhance to accept rich fund data (not just names) |
| `src/services/gateway.service.ts` | Remove auto-detect, require fund prefix, add `/ask` and `/help` commands, remove free-text handler |
| `src/skills.ts` | Add `FUND_MEMORY_FILES`, `MEMORY_USAGE_RULE`, `ensureFundMemory()` |
| `src/services/fund.service.ts` | Call `ensureFundMemory()` in `createFund()` and `upgradeFund()` |
| `src/paths.ts` | Add `memory` directory to `fundPaths()` |

---

## Task 1: Paths and Memory Constants

**Files:**
- Modify: `src/paths.ts`
- Modify: `src/skills.ts`

- [ ] **Step 1: Add `memory` to `fundPaths()` in `src/paths.ts`**

Inside the `fundPaths()` return object, after `reports`:

```typescript
memory: join(root, "memory"),
```

- [ ] **Step 2: Add memory file constants to `src/skills.ts`**

Add after the `FUND_RULES` array (at the end of the file, before the closing of the module):

```typescript
// ── Per-Fund Memory ───────────────────────────────────────────

export interface MemoryFile {
  fileName: string;
  description: string;
  content: string;
}

export const FUND_MEMORY_FILES: MemoryFile[] = [
  {
    fileName: "MEMORY.md",
    description: "Index of memory files",
    content: `# Fund Memory

Memory files for this fund. Updated by the AI agent during sessions.

- [market-lessons.md](market-lessons.md) — Market patterns and lessons learned
- [trading-patterns.md](trading-patterns.md) — Trading behavior observations
- [fund-notes.md](fund-notes.md) — General fund observations
`,
  },
  {
    fileName: "market-lessons.md",
    description: "Market patterns and lessons learned",
    content: `---
description: Market patterns and lessons learned by the AI agent
---

(No observations yet. The AI agent will populate this during trading sessions.)
`,
  },
  {
    fileName: "trading-patterns.md",
    description: "Trading behavior observations",
    content: `---
description: Trading behavior observations and recurring patterns
---

(No observations yet. The AI agent will populate this during trading sessions.)
`,
  },
  {
    fileName: "fund-notes.md",
    description: "General fund observations",
    content: `---
description: General observations about this fund's performance and strategy
---

(No observations yet. The AI agent will populate this during trading sessions.)
`,
  },
];

export const MEMORY_USAGE_RULE = {
  fileName: "memory-usage.md",
  content: `# Memory Usage

You have a persistent memory system in the \`memory/\` directory at the fund root.

## At Session Start
Read \`memory/MEMORY.md\` to see what memory files exist. Read individual files
as relevant to the current session's focus.

## During Sessions
When you discover something worth remembering across sessions, write it to the
appropriate memory file:
- \`memory/market-lessons.md\` — Market patterns, sector behavior, macro observations
- \`memory/trading-patterns.md\` — What works/doesn't for this fund, entry/exit timing
- \`memory/fund-notes.md\` — Strategy adjustments, risk observations, general notes

## Rules
- Keep entries concise and actionable — facts and lessons, not raw data
- Do not duplicate information already in CLAUDE.md, fund_config.yaml, or state files
- State files (portfolio.json, objective_tracker.json, trade_journal.sqlite) are for
  current state. Memory is for learned patterns and observations that inform future decisions.
- Prefix each entry with a date (YYYY-MM-DD) for context
`,
};
```

- [ ] **Step 3: Add `ensureFundMemory()` function to `src/skills.ts`**

Add after the memory constants:

```typescript
/**
 * Write memory files and memory-usage rule to a fund directory.
 * Called during fund creation and upgrade. Idempotent — does not overwrite existing memory.
 */
export async function ensureFundMemory(fundRoot: string, fundClaudeDir: string): Promise<void> {
  const memoryDir = join(fundRoot, "memory");
  await mkdir(memoryDir, { recursive: true });

  for (const file of FUND_MEMORY_FILES) {
    const filePath = join(memoryDir, file.fileName);
    if (!existsSync(filePath)) {
      await writeFile(filePath, file.content, "utf-8");
    }
  }

  // Write the memory-usage rule
  const rulesDir = join(fundClaudeDir, "rules");
  await mkdir(rulesDir, { recursive: true });
  const rulePath = join(rulesDir, MEMORY_USAGE_RULE.fileName);
  await writeFile(rulePath, MEMORY_USAGE_RULE.content, "utf-8");
}
```

- [ ] **Step 4: Wire `ensureFundMemory()` into fund creation and upgrade in `src/services/fund.service.ts`**

Add import:
```typescript
import { ensureFundSkillFiles, ensureFundRules, ensureFundMemory, BUILTIN_SKILLS } from "../skills.js";
```

In `createFund()`, after `await ensureFundRules(...)` (line 130):
```typescript
  await ensureFundMemory(fundPaths(name).root, fundPaths(name).claudeDir);
```

In `upgradeFund()`, after `await ensureFundRules(...)` (line 208):
```typescript
  await ensureFundMemory(paths.root, paths.claudeDir);
```

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: PASS (no behavioral changes, just new file generation)

- [ ] **Step 6: Commit**

```bash
git add src/paths.ts src/skills.ts src/services/fund.service.ts
git commit -m "feat(scoping): add per-fund memory files and memory-usage rule"
```

---

## Task 2: Enhanced FundSelector Component

**Files:**
- Modify: `src/components/FundSelector.tsx`

- [ ] **Step 1: Update `FundSelector` to accept rich fund data**

Replace the entire file:

```typescript
import React from "react";
import { Box, Text } from "ink";
import { Select } from "@inkjs/ui";
import type { FundStatusData } from "../services/status.service.js";

interface FundSelectorProps {
  funds: FundStatusData[];
  onSelect: (fundName: string) => void;
  label?: string;
}

function formatTimeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function FundSelector({ funds, onSelect, label = "Select a fund:" }: FundSelectorProps) {
  if (funds.length === 0) {
    return <Text dimColor>No funds available. Press 'c' to create one.</Text>;
  }

  const options = funds.map((f) => {
    const pnlSign = f.pnl >= 0 ? "+" : "";
    const pnlStr = `${pnlSign}$${Math.abs(f.pnl).toFixed(0)} (${pnlSign}${f.pnlPct.toFixed(1)}%)`;
    const lastStr = f.lastSession ? formatTimeSince(f.lastSession.startedAt) : "never";
    const statusIcon = f.status === "active" ? "\u25CF" : f.status === "paused" ? "\u25CB" : "\u25A0";

    return {
      label: `${statusIcon} ${f.displayName} (${f.name})  $${f.currentValue.toLocaleString()} ${pnlStr}  Last: ${lastStr}`,
      value: f.name,
    };
  });

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Select options={options} onChange={onSelect} />
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/components/FundSelector.tsx
git commit -m "feat(scoping): enhance FundSelector with rich fund data display"
```

---

## Task 3: Fund Dashboard Components

**Files:**
- Create: `src/components/FundDashboardHeader.tsx`
- Create: `src/components/PortfolioPanel.tsx`
- Create: `src/components/ObjectiveProgressBar.tsx`

- [ ] **Step 1: Create `FundDashboardHeader.tsx`**

```typescript
import React from "react";
import { Box, Text } from "ink";

interface FundDashboardHeaderProps {
  displayName: string;
  status: string;
  brokerMode: string;
  model: string;
  width: number;
}

export function FundDashboardHeader({ displayName, status, brokerMode, model, width }: FundDashboardHeaderProps) {
  const statusColor = status === "active" ? "green" : status === "paused" ? "yellow" : "red";
  const modeColor = brokerMode === "live" ? "red" : "cyan";

  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Text bold>{displayName}</Text>
      <Box gap={2}>
        <Text color={statusColor}>{status}</Text>
        <Text color={modeColor}>{brokerMode}</Text>
        <Text dimColor>{model}</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Create `PortfolioPanel.tsx`**

```typescript
import React from "react";
import { Box, Text } from "ink";
import type { Portfolio } from "../types.js";

interface PortfolioPanelProps {
  portfolio: Portfolio | null;
  initialCapital: number;
  width: number;
}

export function PortfolioPanel({ portfolio, initialCapital, width }: PortfolioPanelProps) {
  if (!portfolio) {
    return (
      <Box width={width} paddingX={1}>
        <Text dimColor>No portfolio data</Text>
      </Box>
    );
  }

  const pnl = portfolio.total_value - initialCapital;
  const pnlPct = initialCapital > 0 ? (pnl / initialCapital) * 100 : 0;
  const pnlColor = pnl >= 0 ? "green" : "red";
  const pnlSign = pnl >= 0 ? "+" : "";

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Box justifyContent="space-between">
        <Text>Cash: ${portfolio.cash.toLocaleString()}</Text>
        <Text>Total: ${portfolio.total_value.toLocaleString()}</Text>
        <Text color={pnlColor}>{pnlSign}${pnl.toFixed(0)} ({pnlSign}{pnlPct.toFixed(1)}%)</Text>
      </Box>
      {portfolio.positions.length > 0 && (
        <Box flexDirection="column">
          {portfolio.positions.slice(0, 5).map((p) => (
            <Box key={p.symbol} justifyContent="space-between">
              <Text>{p.symbol} x{p.shares}</Text>
              <Text>${p.market_value.toFixed(0)}</Text>
              <Text color={p.unrealized_pnl >= 0 ? "green" : "red"}>
                {p.unrealized_pnl >= 0 ? "+" : ""}{p.unrealized_pnl_pct.toFixed(1)}%
              </Text>
            </Box>
          ))}
          {portfolio.positions.length > 5 && (
            <Text dimColor>...and {portfolio.positions.length - 5} more</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 3: Create `ObjectiveProgressBar.tsx`**

```typescript
import React from "react";
import { Box, Text } from "ink";
import type { ObjectiveTracker } from "../types.js";

interface ObjectiveProgressBarProps {
  tracker: ObjectiveTracker | null;
  objectiveType: string;
  width: number;
}

export function ObjectiveProgressBar({ tracker, objectiveType, width }: ObjectiveProgressBarProps) {
  if (!tracker) {
    return (
      <Box width={width} paddingX={1}>
        <Text dimColor>No objective data</Text>
      </Box>
    );
  }

  const pct = Math.min(100, Math.max(0, tracker.progress_pct));
  const barWidth = Math.max(10, width - 30);
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  const statusColor = tracker.status === "on_track" || tracker.status === "ahead" ? "green" : tracker.status === "behind" ? "yellow" : "cyan";

  return (
    <Box width={width} paddingX={1} gap={1}>
      <Text>{objectiveType}</Text>
      <Text color={statusColor}>{bar}</Text>
      <Text>{pct.toFixed(0)}%</Text>
      <Text dimColor>{tracker.status}</Text>
    </Box>
  );
}
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/FundDashboardHeader.tsx src/components/PortfolioPanel.tsx src/components/ObjectiveProgressBar.tsx
git commit -m "feat(scoping): add fund dashboard header, portfolio panel, and progress bar"
```

---

## Task 4: Refactor Default Command (Fund Selector + Fund Dashboard)

**Files:**
- Modify: `src/commands/index.tsx`

This is the largest task. Replace the current global multi-panel dashboard with a two-phase UI.

- [ ] **Step 1: Replace `src/commands/index.tsx`**

```typescript
import React, { useState, useEffect, useCallback, useMemo } from "react";
import zod from "zod";
import { Box, Text, useApp, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { useInterval } from "../hooks/useInterval.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { getAllFundStatuses } from "../services/status.service.js";
import { loadFundConfig } from "../services/fund.service.js";
import { readPortfolio, readTracker } from "../state.js";
import { forkSupervisor } from "../services/supervisor.service.js";
import { FundSelector } from "../components/FundSelector.js";
import { FundDashboardHeader } from "../components/FundDashboardHeader.js";
import { PortfolioPanel } from "../components/PortfolioPanel.js";
import { ObjectiveProgressBar } from "../components/ObjectiveProgressBar.js";
import { ChatView } from "../components/ChatView.js";
import { Logo } from "../components/Logo.js";
import type { FundStatusData } from "../services/status.service.js";
import type { FundConfig, Portfolio, ObjectiveTracker } from "../types.js";

export const description = "FundX — Autonomous AI Fund Manager powered by the Claude Agent SDK";

export const options = zod.object({
  fund: zod.string().optional().describe("Fund to open directly"),
  model: zod.string().optional().describe("Claude model (sonnet, opus, haiku)"),
  readonly: zod.boolean().default(false).describe("Read-only mode (no trades)"),
  maxBudget: zod.string().optional().describe("Maximum budget in USD for the session"),
});

type Phase =
  | { type: "loading" }
  | { type: "selecting"; funds: FundStatusData[] }
  | { type: "fund-dashboard"; fundName: string };

type Props = { options: zod.infer<typeof options> };

const PORTFOLIO_REFRESH_MS = 30_000;

export default function Index({ options: opts }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>({ type: "loading" });

  // Auto-start daemon
  useEffect(() => {
    forkSupervisor().catch(() => {});
  }, []);

  // Initial load: resolve fund or show selector
  useEffect(() => {
    (async () => {
      if (opts.fund) {
        // Direct fund access via --fund flag
        setPhase({ type: "fund-dashboard", fundName: opts.fund });
        return;
      }
      const funds = await getAllFundStatuses();
      if (funds.length === 1 && funds[0]) {
        // Single fund: skip selector
        setPhase({ type: "fund-dashboard", fundName: funds[0].name });
      } else {
        setPhase({ type: "selecting", funds });
      }
    })();
  }, []);

  // ── Loading ──
  if (phase.type === "loading") {
    return <Spinner label="Loading funds..." />;
  }

  // ── Fund Selector ──
  if (phase.type === "selecting") {
    return (
      <FundSelectorScreen
        funds={phase.funds}
        onSelect={(name) => setPhase({ type: "fund-dashboard", fundName: name })}
        onExit={exit}
        columns={columns}
      />
    );
  }

  // ── Fund Dashboard ──
  return (
    <FundDashboardScreen
      fundName={phase.fundName}
      onBack={() => {
        getAllFundStatuses().then((funds) => setPhase({ type: "selecting", funds }));
      }}
      onExit={exit}
      columns={columns}
      rows={rows}
      options={opts}
    />
  );
}

// ── Fund Selector Screen ──────────────────────────────────────

function FundSelectorScreen({
  funds,
  onSelect,
  onExit,
  columns,
}: {
  funds: FundStatusData[];
  onSelect: (name: string) => void;
  onExit: () => void;
  columns: number;
}) {
  useInput((input, key) => {
    if (input === "q") onExit();
    // 'c' for create fund could be added here in the future
  });

  return (
    <Box flexDirection="column" width={columns}>
      <Logo />
      <Box paddingX={1} marginBottom={1}>
        <Text dimColor>Select a fund to enter its dashboard. Press q to quit.</Text>
      </Box>
      <Box paddingX={1}>
        <FundSelector funds={funds} onSelect={onSelect} />
      </Box>
    </Box>
  );
}

// ── Fund Dashboard Screen ─────────────────────────────────────

function FundDashboardScreen({
  fundName,
  onBack,
  onExit,
  columns,
  rows,
  options: opts,
}: {
  fundName: string;
  onBack: () => void;
  onExit: () => void;
  columns: number;
  rows: number;
  options: { model?: string; readonly: boolean; maxBudget?: string };
}) {
  const [refreshKey, setRefreshKey] = useState(0);

  // Load fund data
  const configAction = useAsyncAction(() => loadFundConfig(fundName), [fundName]);
  const portfolioAction = useAsyncAction(() => readPortfolio(fundName).catch(() => null), [fundName, refreshKey]);
  const trackerAction = useAsyncAction(() => readTracker(fundName).catch(() => null), [fundName, refreshKey]);

  // Refresh portfolio periodically
  useInterval(() => setRefreshKey((k) => k + 1), PORTFOLIO_REFRESH_MS);

  const config = configAction.data;
  const portfolio = portfolioAction.data ?? null;
  const tracker = trackerAction.data ?? null;

  const handleExit = useCallback(() => onExit(), [onExit]);
  const handleBack = useCallback(() => onBack(), [onBack]);
  const chatOptions = useMemo(
    () => ({ model: opts.model, readonly: opts.readonly, maxBudget: opts.maxBudget }),
    [opts.model, opts.readonly, opts.maxBudget],
  );

  if (!config) {
    return <Spinner label={`Loading ${fundName}...`} />;
  }

  const panelsHeight = 5; // header + portfolio summary + progress bar + padding
  const chatHeight = Math.max(5, rows - panelsHeight);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* Fund header */}
      <FundDashboardHeader
        displayName={config.fund.display_name}
        status={config.fund.status}
        brokerMode={config.broker.mode}
        model={config.claude.model || "sonnet"}
        width={columns}
      />

      {/* Portfolio summary */}
      <PortfolioPanel
        portfolio={portfolio}
        initialCapital={config.capital.initial}
        width={columns}
      />

      {/* Objective progress */}
      <ObjectiveProgressBar
        tracker={tracker}
        objectiveType={config.objective.type}
        width={columns}
      />

      {/* Chat REPL (scoped to this fund) */}
      <ChatView
        key={fundName}
        fundName={fundName}
        width={columns}
        height={chatHeight}
        mode="static"
        onExit={handleExit}
        onSwitchFund={handleBack}
        options={chatOptions}
      />
    </Box>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (or minor type adjustments needed — ChatView props may need checking)

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 4: Manual smoke test**

```bash
pnpm dev
# Verify: shows fund selector if 2+ funds, auto-enters if 1 fund
# Select a fund → verify header, portfolio, progress, chat
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/index.tsx
git commit -m "feat(scoping): refactor default command to fund selector + fund dashboard"
```

---

## Task 5: Telegram — Fund Prefix Commands

**Files:**
- Modify: `src/services/gateway.service.ts`

- [ ] **Step 1: Simplify bot command registration in `startGateway()`**

In the `startGateway()` function, replace the message handler block (lines 455-495) — the `bot.on("message:text", ...)` handler — with:

```typescript
  // Add /ask command (new — replaces free-text and /ask_<fund>)
  bot.command("ask", async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const fundName = parts[0];
    const question = parts.slice(1).join(" ");
    if (!fundName || !question) {
      const names = await listFundNames();
      await ctx.reply(`Usage: /ask <fund> <question>\nAvailable funds: ${names.join(", ")}`);
      return;
    }
    const names = await listFundNames();
    if (!names.includes(fundName)) {
      await ctx.reply(`Fund '${fundName}' not found.\nAvailable funds: ${names.join(", ")}`);
      return;
    }
    await wakeClaudeForQuestion(ctx, fundName, question);
  });

  // Add /help command (new)
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `<b>FundX Commands</b>\n\n` +
      `<b>Global:</b>\n` +
      `/status — List all funds\n` +
      `/next — Upcoming scheduled sessions\n` +
      `/help — This message\n\n` +
      `<b>Per-fund (requires fund name):</b>\n` +
      `/status <fund>\n` +
      `/portfolio <fund>\n` +
      `/trades <fund> [today|week]\n` +
      `/pause <fund>\n` +
      `/resume <fund>\n` +
      `/ask <fund> <question>`,
      { parse_mode: "HTML" },
    );
  });

  // Remove free-text handler — all interaction must use explicit commands
  // (Previously: bot.on("message:text", ...) with detectFund and handleFreeQuestion)
```

- [ ] **Step 2: Add fund validation to `/portfolio` and `/pause` and `/resume` handlers**

The existing `/portfolio`, `/pause`, and `/resume` handlers already parse `ctx.match` and require a fund name. Add a validation step to each that checks the fund exists:

After parsing `fundName` in each handler, before calling the handler function, add:
```typescript
    const names = await listFundNames();
    if (!names.includes(fundName)) {
      await ctx.reply(`Fund '${fundName}' not found.\nAvailable funds: ${names.join(", ")}`);
      return;
    }
```

- [ ] **Step 3: Remove `handleFreeQuestion` and `detectFund` functions**

Delete or comment out these functions (they are no longer called):
- `handleFreeQuestion()` — was the catch-all for free-text messages
- `detectFund()` — was the auto-detection logic

If other functions still reference them, trace and remove those references too.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Manual test — send commands to Telegram bot**

```bash
pnpm dev -- gateway test
# Send: /help → verify command list
# Send: /status → verify all funds listed
# Send: /status growth → verify fund status
# Send: /portfolio → verify "Usage: /portfolio <fund>" message
# Send: /ask growth how is tech? → verify wakes Claude
# Send: free text → verify no response (ignored)
```

- [ ] **Step 6: Commit**

```bash
git add src/services/gateway.service.ts
git commit -m "feat(scoping): require fund prefix in Telegram, add /ask and /help, remove auto-detect"
```

---

## Task 6: Final Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 4: End-to-end smoke test**

```bash
# 1. Test fund selector
pnpm dev
# → Should show fund list, select one, enter dashboard

# 2. Test fund dashboard
pnpm dev -- --fund prueba
# → Should show header, portfolio, progress, chat

# 3. Test fund upgrade (memory generation)
pnpm dev -- fund upgrade --all
# → Check that ~/.fundx/funds/<name>/memory/ exists with files

# 4. Verify memory files exist
ls ~/.fundx/funds/prueba/memory/
# → MEMORY.md, market-lessons.md, trading-patterns.md, fund-notes.md

# 5. Verify memory rule exists
cat ~/.fundx/funds/prueba/.claude/rules/memory-usage.md
# → Should contain memory usage instructions
```

- [ ] **Step 5: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix(scoping): integration fixes"
```
