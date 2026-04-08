# Chat Multi-Panel Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right sidebar with 4 information panels (handoff, portfolio, upcoming, market) to the chat view, providing persistent context alongside the conversation.

**Architecture:** New sidebar components render alongside the existing chat in a horizontal flex layout. A `useSidebarData` hook loads data from state files and polls FMP prices every 5 minutes. Sidebar only shows when terminal width >= 120 columns and a fund is selected.

**Tech Stack:** TypeScript, React/Ink, FMP API (existing market.service.ts)

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/components/SidebarPanel.tsx` | Create | Reusable Unicode box-drawing panel wrapper |
| `src/components/HandoffPanel.tsx` | Create | Displays session handoff summary |
| `src/components/PortfolioPanel.tsx` | Create | Displays positions with P&L |
| `src/components/UpcomingPanel.tsx` | Create | Displays pending sessions + events |
| `src/components/MarketPanel.tsx` | Create | Displays market tickers |
| `src/components/ChatSidebar.tsx` | Create | Composes all 4 panels vertically |
| `src/hooks/useSidebarData.ts` | Create | Data loading + 5-min polling hook |
| `src/components/ChatView.tsx` | Modify | Add sidebar to layout |

---

### Task 1: SidebarPanel wrapper component

**Files:**
- Create: `src/components/SidebarPanel.tsx`

- [ ] **Step 1: Create SidebarPanel component**

```typescript
import React from "react";
import { Box, Text } from "ink";

interface SidebarPanelProps {
  title: string;
  value?: string;
  width: number;
  children: React.ReactNode;
}

export function SidebarPanel({ title, value, width, children }: SidebarPanelProps) {
  const innerWidth = width - 4; // account for "┌ " and " ┐"
  const titlePart = value ? `${title} ─ ${value}` : title;
  const dashCount = Math.max(0, innerWidth - titlePart.length - 1);
  const header = `┌ ${titlePart} ${"─".repeat(dashCount)}┐`;

  return (
    <Box flexDirection="column">
      <Text dimColor>{header}</Text>
      <Box flexDirection="column" paddingLeft={1}>
        {children}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/SidebarPanel.tsx
git commit -m "feat: add SidebarPanel Unicode box-drawing wrapper component"
```

---

### Task 2: HandoffPanel component

**Files:**
- Create: `src/components/HandoffPanel.tsx`

- [ ] **Step 1: Create HandoffPanel component**

The handoff is a markdown string. We extract key sections for a compact view.

```typescript
import React from "react";
import { Text } from "ink";
import { SidebarPanel } from "./SidebarPanel.js";

interface HandoffPanelProps {
  handoff: string | null;
  width: number;
}

function extractSection(content: string, header: string): string[] {
  const regex = new RegExp(`## ${header}\\n([\\s\\S]*?)(?=\\n## |$)`, "i");
  const match = content.match(regex);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((l) => l.replace(/^[-*] /, "").trim())
    .filter((l) => l.length > 0);
}

export function HandoffPanel({ handoff, width }: HandoffPanelProps) {
  if (!handoff) {
    return (
      <SidebarPanel title="HANDOFF" width={width}>
        <Text dimColor>No handoff yet</Text>
      </SidebarPanel>
    );
  }

  // Extract the date/type from the first line
  const firstLine = handoff.split("\n")[0] ?? "";
  const dateMatch = firstLine.match(/— (.+)$/);
  const sessionInfo = dateMatch ? dateMatch[1] : "";

  const contract = extractSection(handoff, "Session Contract");
  const concerns = extractSection(handoff, "Open Concerns");
  const nextShould = extractSection(handoff, "Next Session Should");

  return (
    <SidebarPanel title="HANDOFF" width={width}>
      {sessionInfo && <Text dimColor>{sessionInfo}</Text>}
      {contract.length > 0 && contract.map((line, i) => (
        <Text key={`c${i}`} dimColor>{line.length > width - 4 ? line.slice(0, width - 7) + "..." : line}</Text>
      ))}
      {concerns.length > 0 && concerns.map((line, i) => (
        <Text key={`w${i}`} color="yellow">{"▲ "}{line.length > width - 6 ? line.slice(0, width - 9) + "..." : line}</Text>
      ))}
      {nextShould.length > 0 && nextShould.slice(0, 2).map((line, i) => (
        <Text key={`n${i}`} dimColor>{"▸ "}{line.length > width - 6 ? line.slice(0, width - 9) + "..." : line}</Text>
      ))}
    </SidebarPanel>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/HandoffPanel.tsx
git commit -m "feat: add HandoffPanel sidebar component"
```

---

### Task 3: PortfolioPanel component

**Files:**
- Create: `src/components/PortfolioPanel.tsx`

- [ ] **Step 1: Create PortfolioPanel component**

```typescript
import React from "react";
import { Box, Text } from "ink";
import { SidebarPanel } from "./SidebarPanel.js";
import type { Portfolio } from "../types.js";

interface PortfolioPanelProps {
  portfolio: Portfolio | null;
  width: number;
}

export function PortfolioPanel({ portfolio, width }: PortfolioPanelProps) {
  if (!portfolio) {
    return (
      <SidebarPanel title="PORTFOLIO" width={width}>
        <Text dimColor>No portfolio data</Text>
      </SidebarPanel>
    );
  }

  const totalStr = `$${portfolio.total_value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const cashPct = portfolio.total_value > 0
    ? ((portfolio.cash / portfolio.total_value) * 100).toFixed(0)
    : "100";

  return (
    <SidebarPanel title="PORTFOLIO" value={totalStr} width={width}>
      {portfolio.positions.map((p) => {
        const arrow = p.unrealized_pnl_pct >= 0 ? "▲" : "▼";
        const color = p.unrealized_pnl_pct >= 0 ? "green" : "red";
        const pctStr = `${p.unrealized_pnl_pct >= 0 ? "+" : ""}${p.unrealized_pnl_pct.toFixed(1)}%`;
        return (
          <Box key={p.symbol} justifyContent="space-between">
            <Text dimColor>{p.symbol} {p.shares}×${p.current_price.toFixed(2)}</Text>
            <Text color={color}>{arrow} {pctStr}</Text>
          </Box>
        );
      })}
      <Box justifyContent="space-between" marginTop={0}>
        <Text dimColor>Cash ${portfolio.cash.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</Text>
        <Text dimColor>{cashPct}%</Text>
      </Box>
    </SidebarPanel>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/PortfolioPanel.tsx
git commit -m "feat: add PortfolioPanel sidebar component"
```

---

### Task 4: UpcomingPanel component

**Files:**
- Create: `src/components/UpcomingPanel.tsx`

- [ ] **Step 1: Create UpcomingPanel component**

```typescript
import React from "react";
import { Text } from "ink";
import { SidebarPanel } from "./SidebarPanel.js";

export interface UpcomingItem {
  time: string;
  label: string;
  type: "session" | "event";
}

interface UpcomingPanelProps {
  items: UpcomingItem[];
  width: number;
}

export function UpcomingPanel({ items, width }: UpcomingPanelProps) {
  if (items.length === 0) {
    return (
      <SidebarPanel title="UPCOMING" width={width}>
        <Text dimColor>No upcoming sessions today</Text>
      </SidebarPanel>
    );
  }

  return (
    <SidebarPanel title="UPCOMING" width={width}>
      {items.map((item, i) => {
        if (item.type === "event") {
          return (
            <Text key={i} color="yellow">{"▸ "}{item.label} {item.time}</Text>
          );
        }
        return (
          <Text key={i} dimColor>{"◷ "}{item.time} — {item.label}</Text>
        );
      })}
    </SidebarPanel>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/UpcomingPanel.tsx
git commit -m "feat: add UpcomingPanel sidebar component"
```

---

### Task 5: MarketPanel component

**Files:**
- Create: `src/components/MarketPanel.tsx`

- [ ] **Step 1: Create MarketPanel component**

```typescript
import React from "react";
import { Box, Text } from "ink";
import { SidebarPanel } from "./SidebarPanel.js";

export interface MarketTicker {
  symbol: string;
  price: number;
  changePct: number;
}

interface MarketPanelProps {
  tickers: MarketTicker[];
  isMarketOpen: boolean;
  width: number;
}

export function MarketPanel({ tickers, isMarketOpen, width }: MarketPanelProps) {
  if (tickers.length === 0) {
    return (
      <SidebarPanel title="MARKET" width={width}>
        <Text dimColor>No market data</Text>
      </SidebarPanel>
    );
  }

  return (
    <SidebarPanel title="MARKET" width={width}>
      {tickers.map((t) => {
        const arrow = t.changePct >= 0 ? "▲" : "▼";
        const color = t.changePct >= 0 ? "green" : "red";
        const pctStr = `${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(1)}%`;
        return (
          <Box key={t.symbol} justifyContent="space-between">
            <Text dimColor>{t.symbol} ${t.price.toFixed(2)}</Text>
            <Text color={color}>{arrow} {pctStr}</Text>
          </Box>
        );
      })}
      {!isMarketOpen && <Text dimColor italic>Market closed</Text>}
    </SidebarPanel>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/MarketPanel.tsx
git commit -m "feat: add MarketPanel sidebar component"
```

---

### Task 6: useSidebarData hook

**Files:**
- Create: `src/hooks/useSidebarData.ts`

- [ ] **Step 1: Create the hook**

This hook loads sidebar data on mount and polls market/portfolio every 5 minutes.

```typescript
import { useState, useEffect, useCallback } from "react";
import { readSessionHandoff, readPortfolio, readPendingSessions } from "../state.js";
import { loadFundConfig } from "../services/fund.service.js";
import { loadGlobalConfig } from "../config.js";
import { useInterval } from "./useInterval.js";
import type { Portfolio, FundConfig, PendingSession } from "../types.js";
import type { UpcomingItem } from "../components/UpcomingPanel.js";
import type { MarketTicker } from "../components/MarketPanel.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

export interface SidebarData {
  handoff: string | null;
  portfolio: Portfolio | null;
  upcoming: UpcomingItem[];
  market: MarketTicker[];
  isMarketOpen: boolean;
  isLoading: boolean;
}

async function fetchFmpQuotes(
  symbols: string[],
  apiKey: string,
): Promise<Array<{ symbol: string; price: number; changesPercentage: number }>> {
  if (symbols.length === 0) return [];
  try {
    const resp = await fetch(
      `${FMP_BASE}/quote/${symbols.join(",")}?apikey=${apiKey}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return [];
    return (await resp.json()) as Array<{ symbol: string; price: number; changesPercentage: number }>;
  } catch {
    return [];
  }
}

function buildUpcomingItems(
  pendingSessions: PendingSession[],
  config: FundConfig,
): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Pending sessions (self-scheduled)
  for (const ps of pendingSessions) {
    const scheduledDate = new Date(ps.scheduled_at);
    const isToday = scheduledDate.toDateString() === now.toDateString();
    if (!isToday) continue;
    const timeStr = scheduledDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    items.push({ time: timeStr, label: ps.focus.slice(0, 30), type: "session" });
  }

  // Scheduled sessions from config (remaining today)
  for (const [name, session] of Object.entries(config.schedule.sessions)) {
    if (!session.enabled) continue;
    const [h, m] = (session.time ?? "").split(":").map(Number);
    if (h === undefined || m === undefined) continue;
    const sessionMinutes = h * 60 + m;
    if (sessionMinutes <= nowMinutes) continue; // already passed
    const timeStr = new Date(2000, 0, 1, h, m).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    items.push({ time: timeStr, label: name.replace(/_/g, " "), type: "session" });
  }

  // Sort by time
  items.sort((a, b) => a.time.localeCompare(b.time));
  return items;
}

function isWithinMarketHours(): boolean {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export function useSidebarData(fundName: string | null): SidebarData {
  const [data, setData] = useState<SidebarData>({
    handoff: null,
    portfolio: null,
    upcoming: [],
    market: [],
    isMarketOpen: false,
    isLoading: true,
  });

  // Initial load
  useEffect(() => {
    if (!fundName) return;
    let cancelled = false;

    (async () => {
      try {
        const [handoff, portfolio, pending, config, globalConfig] = await Promise.all([
          readSessionHandoff(fundName).catch(() => null),
          readPortfolio(fundName).catch(() => null),
          readPendingSessions(fundName).catch(() => []),
          loadFundConfig(fundName).catch(() => null),
          loadGlobalConfig().catch(() => null),
        ]);

        if (cancelled) return;

        const upcoming = config ? buildUpcomingItems(pending, config) : [];
        const isMarketOpen = isWithinMarketHours();

        // Fetch market data
        let market: MarketTicker[] = [];
        const fmpKey = globalConfig?.market_data?.fmp_api_key;
        if (fmpKey) {
          const positionSymbols = portfolio?.positions.map((p) => p.symbol) ?? [];
          const allSymbols = [...new Set(["SPY", "^VIX", ...positionSymbols])];
          const quotes = await fetchFmpQuotes(allSymbols, fmpKey);

          // Update portfolio with live prices
          if (portfolio && quotes.length > 0) {
            for (const pos of portfolio.positions) {
              const q = quotes.find((qt) => qt.symbol === pos.symbol);
              if (q) {
                pos.current_price = q.price;
                pos.market_value = pos.shares * q.price;
                pos.unrealized_pnl = (q.price - pos.avg_cost) * pos.shares;
                pos.unrealized_pnl_pct = pos.avg_cost > 0 ? ((q.price - pos.avg_cost) / pos.avg_cost) * 100 : 0;
              }
            }
            const posValue = portfolio.positions.reduce((s, p) => s + p.market_value, 0);
            portfolio.total_value = portfolio.cash + posValue;
            for (const pos of portfolio.positions) {
              pos.weight_pct = portfolio.total_value > 0 ? (pos.market_value / portfolio.total_value) * 100 : 0;
            }
          }

          market = quotes
            .filter((q) => ["SPY", "^VIX"].includes(q.symbol) || positionSymbols.includes(q.symbol))
            .map((q) => ({
              symbol: q.symbol === "^VIX" ? "VIX" : q.symbol,
              price: q.price,
              changePct: q.changesPercentage,
            }));
        }

        if (!cancelled) {
          setData({ handoff, portfolio, upcoming, market, isMarketOpen, isLoading: false });
        }
      } catch {
        if (!cancelled) {
          setData((prev) => ({ ...prev, isLoading: false }));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [fundName]);

  // Poll market + portfolio every 5 min during market hours
  const refreshPrices = useCallback(async () => {
    if (!fundName) return;
    try {
      const [portfolio, globalConfig] = await Promise.all([
        readPortfolio(fundName).catch(() => null),
        loadGlobalConfig().catch(() => null),
      ]);

      const fmpKey = globalConfig?.market_data?.fmp_api_key;
      if (!fmpKey || !portfolio) return;

      const positionSymbols = portfolio.positions.map((p) => p.symbol);
      const allSymbols = [...new Set(["SPY", "^VIX", ...positionSymbols])];
      const quotes = await fetchFmpQuotes(allSymbols, fmpKey);
      if (quotes.length === 0) return;

      // Update portfolio positions with live prices
      for (const pos of portfolio.positions) {
        const q = quotes.find((qt) => qt.symbol === pos.symbol);
        if (q) {
          pos.current_price = q.price;
          pos.market_value = pos.shares * q.price;
          pos.unrealized_pnl = (q.price - pos.avg_cost) * pos.shares;
          pos.unrealized_pnl_pct = pos.avg_cost > 0 ? ((q.price - pos.avg_cost) / pos.avg_cost) * 100 : 0;
        }
      }
      const posValue = portfolio.positions.reduce((s, p) => s + p.market_value, 0);
      portfolio.total_value = portfolio.cash + posValue;
      for (const pos of portfolio.positions) {
        pos.weight_pct = portfolio.total_value > 0 ? (pos.market_value / portfolio.total_value) * 100 : 0;
      }

      const market = quotes
        .filter((q) => ["SPY", "^VIX"].includes(q.symbol) || positionSymbols.includes(q.symbol))
        .map((q) => ({
          symbol: q.symbol === "^VIX" ? "VIX" : q.symbol,
          price: q.price,
          changePct: q.changesPercentage,
        }));

      const isMarketOpen = isWithinMarketHours();
      setData((prev) => ({ ...prev, portfolio, market, isMarketOpen }));
    } catch {
      // best effort
    }
  }, [fundName]);

  useInterval(
    refreshPrices,
    fundName && data.isMarketOpen ? POLL_INTERVAL_MS : null,
  );

  return data;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/useSidebarData.ts
git commit -m "feat: add useSidebarData hook with 5-min market polling"
```

---

### Task 7: ChatSidebar composition component

**Files:**
- Create: `src/components/ChatSidebar.tsx`

- [ ] **Step 1: Create ChatSidebar component**

```typescript
import React from "react";
import { Box, Text } from "ink";
import { HandoffPanel } from "./HandoffPanel.js";
import { PortfolioPanel } from "./PortfolioPanel.js";
import { UpcomingPanel } from "./UpcomingPanel.js";
import { MarketPanel } from "./MarketPanel.js";
import type { SidebarData } from "../hooks/useSidebarData.js";

interface ChatSidebarProps {
  data: SidebarData;
  width: number;
}

export function ChatSidebar({ data, width }: ChatSidebarProps) {
  if (data.isLoading) {
    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} gap={0}>
      <HandoffPanel handoff={data.handoff} width={width} />
      <PortfolioPanel portfolio={data.portfolio} width={width} />
      <UpcomingPanel items={data.upcoming} width={width} />
      <MarketPanel tickers={data.market} isMarketOpen={data.isMarketOpen} width={width} />
    </Box>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ChatSidebar.tsx
git commit -m "feat: add ChatSidebar composition component"
```

---

### Task 8: Integrate sidebar into ChatView

**Files:**
- Modify: `src/components/ChatView.tsx`

- [ ] **Step 1: Add imports**

At the top of `src/components/ChatView.tsx`, add:

```typescript
import { ChatSidebar } from "./ChatSidebar.js";
import { useSidebarData } from "../hooks/useSidebarData.js";
```

- [ ] **Step 2: Add hook call and sidebar width computation**

Inside the `ChatView` function body (after existing hooks around line 52-55), add:

```typescript
  const sidebarData = useSidebarData(fundName);
  const MIN_SIDEBAR_WIDTH = 120;
  const showSidebar = !isWorkspaceMode && width >= MIN_SIDEBAR_WIDTH;
  const sidebarWidth = showSidebar ? Math.floor(width * 0.3) : 0;
  const chatWidth = showSidebar ? width - sidebarWidth : width;
```

- [ ] **Step 3: Modify the main layout**

Find the main return statement (around line 438) that renders the chat. Wrap the chat content and add the sidebar:

Change the outer `<Box>` from:

```tsx
  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Messages area — fills available space */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
```

To:

```tsx
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="row" flexGrow={1}>
        {/* Chat area */}
        <Box flexDirection="column" width={chatWidth} flexGrow={1}>
          {/* Messages area — fills available space */}
          <Box flexDirection="column" flexGrow={1} overflowY="hidden">
```

Then after the input section (after the `</Box>` that closes the `{/* Input */}` section, before the `{/* Context bar */}` section), close the chat column `</Box>`:

```tsx
        </Box>
        {/* Sidebar */}
        {showSidebar && (
          <Box borderLeft borderDimColor>
            <ChatSidebar data={sidebarData} width={sidebarWidth - 1} />
          </Box>
        )}
      </Box>
```

Also remove the old handoff display code that was previously added (the `welcomeData?.handoff` Box inside the messages area), since the sidebar now handles it.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 5: Run tests**

Run: `pnpm test --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/ChatView.tsx
git commit -m "feat: integrate sidebar into ChatView with responsive width"
```

---

### Task 9: Full verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test --reporter=verbose`
Expected: All tests pass.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Clean build.

- [ ] **Step 4: Visual test in dev mode**

Run: `pnpm dev -- --fund Growth`
Expected: Chat opens with sidebar showing 4 panels (handoff, portfolio, upcoming, market).

- [ ] **Step 5: Test responsive behavior**

Resize terminal to < 120 columns.
Expected: Sidebar disappears, chat uses full width.

- [ ] **Step 6: Final commit if fixes needed**

```bash
git add -A
git commit -m "fix: address issues from chat multi-panel integration"
```
