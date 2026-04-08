# Chat Multi-Panel Layout

**Date:** 2026-04-08
**Status:** Draft

## Summary

Redesign the chat screen from a single-column message view to a two-panel layout: chat (70% left) + sidebar (30% right) with 4 information panels. The sidebar shows session handoff, portfolio, upcoming sessions/events, and market data — giving the user immediate context without asking Claude.

## Layout

```
┌─────────────── Chat (70%) ──────────────┬──── Sidebar (30%) ────┐
│                                         │ ┌ HANDOFF ──────────┐ │
│ ❯ Como abrio el mercado?                │ │ Intent: Wait FOMC  │ │
│                                         │ │ ▲ AAPL near stop   │ │
│ Claude response...                      │ └────────────────────┘ │
│                                         │ ┌ PORTFOLIO ─ $10,024┐ │
│                                         │ │ URA 6×$51  ▲+6.97% │ │
│                                         │ │ ITA 1×$232 ▲+4.14% │ │
│ ❯ _                                    │ │ Cash $9,483  94.6%  │ │
│─────────────────────────────────────────│ └────────────────────┘ │
│                                         │ ┌ UPCOMING ──────────┐ │
│                                         │ │ ◷ 2:15 FOMC review │ │
│                                         │ │ ▸ FOMC Minutes 2PM │ │
│                                         │ └────────────────────┘ │
│                                         │ ┌ MARKET ────────────┐ │
│                                         │ │ SPY $674  ▲+2.37%  │ │
│                                         │ │ VIX 22.4  ▼-8.2%   │ │
├─────────────────────────────────────────┴────────────────────────┤
│ ● Growth · [PAPER] · sonnet    $10,024 +$24 (+0.2%) ██░░░░░ 0% │
└─────────────────────────────────────────────────────────────────┘
```

The sidebar shows when a fund is selected. In workspace mode (no fund), the chat uses full width as today.

## Sidebar Panels

### 1. Handoff Panel

**Source:** `state/session-handoff.md`
**Refresh:** Once on load (static between sessions)

Displays a compact summary of the last session's handoff:
- Session date and type
- Intent (from Session Contract)
- Open concerns (highlighted in yellow if present)
- Next session priorities

If no handoff exists (new fund, first session), show "No handoff yet — run a session first."

### 2. Portfolio Panel

**Source:** `state/portfolio.json` + FMP prices
**Refresh:** Every 5 minutes (FMP API polling)

Displays:
- Total portfolio value in header
- Each position: symbol, shares × price, P&L % (green/red with ▲/▼)
- Cash amount and percentage
- Separator line between positions and cash

P&L colors: green (`▲`) for positive, red (`▼`) for negative.

On refresh, fetch current prices from FMP for all position symbols, recompute market values and P&L, update the display. Do NOT write back to `portfolio.json` — the sidebar is read-only display. Portfolio writes are only done by broker-local MCP and the daemon.

### 3. Upcoming Panel

**Source:** `state/pending_sessions.json` + `fund_config.yaml` schedule + special sessions
**Refresh:** Once on load (static)

Displays:
- Pending self-scheduled sessions with time and focus (prefix: `◷`)
- Today's remaining scheduled sessions from config (prefix: `◷`)
- Upcoming calendar events — FOMC, CPI, earnings (prefix: `▸`, yellow)

Only show sessions/events for the rest of today. If nothing upcoming, show "No upcoming sessions today."

### 4. Market Panel

**Source:** FMP API (indices + fund universe tickers)
**Refresh:** Every 5 minutes (same polling cycle as portfolio)

Displays:
- SPY, VIX as base indices (always shown)
- Fund's universe tickers that have positions (from portfolio)
- Each ticker: symbol, price, change % (green ▲ / red ▼)

Combine the market and portfolio price fetches into a single FMP API call to minimize quota usage.

## Iconography (Unicode Box Drawing)

All panels use Unicode box drawing characters for a professional terminal aesthetic:

```
Panel headers:  ┌ TITLE ────────────────┐
P&L positive:   ▲ +6.97%  (green)
P&L negative:   ▼ -8.2%   (red)
Time markers:   ◷ 2:15 PM
Events/alerts:  ▸ FOMC Minutes 2PM ET
Warnings:       ▲ AAPL near stop  (yellow)
Panel content:  │ content line
```

## Components

### New Components

| Component | File | Purpose |
|-----------|------|---------|
| `SidebarPanel` | `src/components/SidebarPanel.tsx` | Reusable wrapper that renders Unicode box-drawing border + title. Takes `title` string and `children`. Computes border width from available space. |
| `HandoffPanel` | `src/components/HandoffPanel.tsx` | Reads handoff string, extracts key sections (intent, concerns, next), renders compact view. |
| `PortfolioPanel` | `src/components/PortfolioPanel.tsx` | Renders positions with P&L and cash from portfolio data. |
| `UpcomingPanel` | `src/components/UpcomingPanel.tsx` | Renders pending sessions + today's schedule + events. |
| `MarketPanel` | `src/components/MarketPanel.tsx` | Renders market tickers with prices and change %. |
| `ChatSidebar` | `src/components/ChatSidebar.tsx` | Composes all 4 panels in a vertical stack. Takes sidebar data as props. |

### New Hook

| Hook | File | Purpose |
|------|------|---------|
| `useSidebarData` | `src/hooks/useSidebarData.ts` | Loads initial sidebar data (handoff, portfolio, pending, market), sets up 5-minute polling for portfolio + market prices. Returns `{ handoff, portfolio, upcoming, market, isLoading }`. |

### Modified Components

| Component | File | Changes |
|-----------|------|---------|
| `ChatView` | `src/components/ChatView.tsx` | Wrap main content in a horizontal flex row: chat (flexGrow) + sidebar (fixed width ~30%). Pass sidebar data via `useSidebarData`. Only render sidebar when `fundName` is set. |

## Data Flow

```
ChatView
├── useSidebarData(fundName)     ← loads data + polling
│   ├── readSessionHandoff()     ← once on mount
│   ├── readPortfolio()          ← once + every 5 min
│   ├── readPendingSessions()    ← once on mount
│   ├── loadFundConfig()         ← once (for schedule + universe)
│   └── fetchFmpPrices()         ← once + every 5 min (market + positions)
│
├── Chat area (70%)              ← existing ChatView content
│   ├── Messages
│   ├── StreamingIndicator
│   └── Input
│
└── ChatSidebar (30%)            ← new
    ├── HandoffPanel
    ├── PortfolioPanel
    ├── UpcomingPanel
    └── MarketPanel
```

## Polling Strategy

- Use the existing `useInterval` hook (already in `src/hooks/useInterval.ts`) for 5-minute polling
- Single FMP API call per refresh: combine all position symbols + SPY + VIX into one `fetchFmpPrices()` call
- Polling only active during market hours (9:30 AM - 4:00 PM ET). Outside market hours, show stale prices with a "Market closed" indicator
- FMP quota impact: ~48 calls per 4-hour session (well within 250/day free tier, shared with daemon)

## Responsive Behavior

- **Terminal width >= 120 columns:** Full sidebar (30%)
- **Terminal width < 120 columns:** Sidebar hidden, chat uses full width (current behavior)
- The `useTerminalSize` hook (already exists) provides the width

## Files to Create

| File | Purpose |
|------|---------|
| `src/components/SidebarPanel.tsx` | Unicode box-drawing panel wrapper |
| `src/components/HandoffPanel.tsx` | Handoff display |
| `src/components/PortfolioPanel.tsx` | Portfolio positions + P&L |
| `src/components/UpcomingPanel.tsx` | Pending sessions + events |
| `src/components/MarketPanel.tsx` | Market tickers |
| `src/components/ChatSidebar.tsx` | Sidebar composition |
| `src/hooks/useSidebarData.ts` | Data loading + polling hook |

## Files to Modify

| File | Changes |
|------|---------|
| `src/components/ChatView.tsx` | Add sidebar to layout, use `useSidebarData`, responsive width check |
