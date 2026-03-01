import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Box, Text, useApp } from "ink";
import { Spinner, Select } from "@inkjs/ui";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { useInterval } from "../hooks/useInterval.js";
import { getDashboardData } from "../services/status.service.js";
import { getDashboardMarketData } from "../services/market.service.js";
import { resolveChatFund } from "../services/chat.service.js";
import { forkDaemon } from "../services/daemon.service.js";
import { SystemStatusPanel } from "../components/SystemStatusPanel.js";
import { FundsOverviewPanel } from "../components/FundsOverviewPanel.js";
import { NewsPanel } from "../components/NewsPanel.js";
import { MarketTickerBanner } from "../components/MarketTickerBanner.js";
import { SectorHeatmapPanel } from "../components/SectorHeatmapPanel.js";
import { DashboardFooter } from "../components/DashboardFooter.js";
import { ChatView } from "../components/ChatView.js";

export const description = "FundX — Autonomous AI Fund Manager powered by the Claude Agent SDK";

const MARKET_REFRESH_MS = 60_000;
const DASHBOARD_REFRESH_MS = 30_000;
const TICKER_HEIGHT = 3; // 1 content row + 2 border rows (borderStyle="single")
const TOP_PANEL_HEIGHT = 5;
const BOTTOM_PANEL_HEIGHT = 8;
const SECTOR_ROW_HEIGHT = 3;

type Phase =
  | { type: "resolving" }
  | { type: "no-funds" }
  | { type: "selecting-fund"; funds: string[] }
  | { type: "ready"; fundName: string };

export default function Index() {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>({ type: "resolving" });
  const [dashboardRefreshKey, setDashboardRefreshKey] = useState(0);
  const [marketRefreshKey, setMarketRefreshKey] = useState(0);

  // Auto-start daemon in background if not running
  useEffect(() => {
    forkDaemon().catch(() => {});
  }, []);

  // Resolve fund on mount
  useEffect(() => {
    (async () => {
      try {
        const { fundName, allFunds } = await resolveChatFund();
        if (!fundName) {
          setPhase({ type: "selecting-fund", funds: allFunds });
        } else {
          setPhase({ type: "ready", fundName });
        }
      } catch {
        setPhase({ type: "no-funds" });
      }
    })();
  }, []);

  // Dashboard data (panels)
  const dashboard = useAsyncAction(() => getDashboardData(), [dashboardRefreshKey]);
  const market = useAsyncAction(() => getDashboardMarketData(), [marketRefreshKey]);

  // Auto-refresh dashboard (daemon, funds, cron) every 30s
  useInterval(() => setDashboardRefreshKey((k) => k + 1), DASHBOARD_REFRESH_MS);
  // Auto-refresh market data every 60s
  useInterval(() => setMarketRefreshKey((k) => k + 1), MARKET_REFRESH_MS);

  // ── Derived panel data ──────────────────────────────────────

  const data = dashboard.data;
  const marketData = market.data;
  const services = data?.services ?? { daemon: false, telegram: false, marketData: false, marketDataProvider: "none" as const };
  // Derive from provider detection, not from whether data arrived in this cycle
  const hasCredentials = services.marketDataProvider !== "none";
  const nextCron = data?.nextCron ?? null;
  const funds = data?.funds ?? [];
  const fundExtras = data?.fundExtras ?? new Map();
  const indices = marketData?.indices ?? [];
  const news = marketData?.news ?? [];
  const sectors = marketData?.sectors ?? [];
  const marketOpen = marketData?.marketOpen ?? false;
  const isShort = rows < 20;

  const innerWidth = columns - 2; // inside outer border
  const halfInner = Math.floor(innerWidth / 2);
  // Each news item is 1 line; subtract 2 for borders
  const newsItems = Math.max(1, BOTTOM_PANEL_HEIGHT - 2);

  // Active fund name (available once resolved)
  const activeFundName = phase.type === "ready" ? phase.fundName : undefined;

  // Stable references so ChatView's internal callbacks aren't recreated on every dashboard refresh.
  const handleExit = useCallback(() => exit(), [exit]);
  const handleSwitchFund = useCallback((name: string) => setPhase({ type: "ready", fundName: name }), []);
  const chatOptions = useMemo(() => ({ readonly: false }), []);

  // ── Panels block (reused in all states) ─────────────────────

  const panelsBlock = (
    <>
      {/* Market index bar - static, full width, hidden on short terminals */}
      {!isShort && (
        <MarketTickerBanner
          indices={indices}
          width={innerWidth}
          hasCredentials={hasCredentials}
          isLoading={market.isLoading}
        />
      )}

      {/* Top row: System Status | Fund Detail */}
      <Box>
        <SystemStatusPanel
          width={halfInner}
          height={TOP_PANEL_HEIGHT}
          services={services}
          nextCron={nextCron}
        />
        <FundsOverviewPanel
          funds={funds}
          fundExtras={fundExtras}
          activeFund={activeFundName}
          width={innerWidth - halfInner}
          height={TOP_PANEL_HEIGHT}
        />
      </Box>

      {/* News - full width (hidden on short terminals) */}
      {!isShort && (
        <NewsPanel
          headlines={news.slice(0, newsItems)}
          width={innerWidth}
          height={BOTTOM_PANEL_HEIGHT}
          hasCredentials={hasCredentials}
        />
      )}

      {/* Sector heatmap row (hidden on short terminals) */}
      {!isShort && (
        <SectorHeatmapPanel
          sectors={sectors}
          width={innerWidth}
          hasCredentials={hasCredentials}
        />
      )}
    </>
  );

  const footerBlock = (
    <DashboardFooter
      hints={[
        { key: "r", label: "" },
        { key: "q", label: "" },
      ]}
      model="claude-sonnet"
      marketOpen={marketOpen}
      width={columns}
    />
  );

  // ── Resolving state ─────────────────────────────────────────

  if (phase.type === "resolving") {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexDirection="column" borderStyle="round" borderDimColor flexGrow={1}>
          {panelsBlock}
          <Box flexGrow={1} justifyContent="center" alignItems="center">
            <Spinner label="Resolving fund..." />
          </Box>
        </Box>
        {footerBlock}
      </Box>
    );
  }

  // ── No funds state ──────────────────────────────────────────

  if (phase.type === "no-funds") {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexDirection="column" borderStyle="round" borderDimColor flexGrow={1}>
          {panelsBlock}
          <Box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column" gap={1}>
            <Text>No funds found.</Text>
            <Text dimColor>Run <Text color="cyan">fundx fund create</Text> to get started.</Text>
          </Box>
        </Box>
        {footerBlock}
      </Box>
    );
  }

  // ── Fund selection state ────────────────────────────────────

  if (phase.type === "selecting-fund") {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <Box flexDirection="column" borderStyle="round" borderDimColor flexGrow={1}>
          {panelsBlock}
          <Box flexGrow={1} flexDirection="column" paddingX={2} paddingY={1}>
            <Text bold>Select a fund:</Text>
            <Select
              options={phase.funds.map((f) => ({ label: f, value: f }))}
              onChange={(value) => setPhase({ type: "ready", fundName: value })}
            />
          </Box>
        </Box>
        {footerBlock}
      </Box>
    );
  }

  // ── REPL (main state) ───────────────────────────────────────

  const panelsHeight = isShort
    ? TOP_PANEL_HEIGHT
    : TICKER_HEIGHT + TOP_PANEL_HEIGHT + BOTTOM_PANEL_HEIGHT + SECTOR_ROW_HEIGHT;
  const footerHeight = 1;
  const outerBorderHeight = 2; // top + bottom border
  const chatHeight = Math.max(5, rows - panelsHeight - footerHeight - outerBorderHeight);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* Outer border */}
      <Box flexDirection="column" borderStyle="round" borderDimColor flexGrow={1}>
        {panelsBlock}

        {/* Chat REPL — always active */}
        <ChatView
          key={phase.fundName}
          fundName={phase.fundName}
          width={innerWidth}
          height={chatHeight}
          mode="inline"
          onExit={handleExit}
          onSwitchFund={handleSwitchFund}
          options={chatOptions}
        />
      </Box>

      {/* Footer (outside border) */}
      {footerBlock}
    </Box>
  );
}
