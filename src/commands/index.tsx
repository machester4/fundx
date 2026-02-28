import React, { useState, useEffect } from "react";
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
import { MarketIndicesPanel } from "../components/MarketIndicesPanel.js";
import { DashboardFooter } from "../components/DashboardFooter.js";
import { ChatView } from "../components/ChatView.js";

export const description = "FundX — Autonomous AI Fund Manager powered by the Claude Agent SDK";

const MARKET_REFRESH_MS = 60_000;
const DASHBOARD_REFRESH_MS = 30_000;
const PANEL_HEIGHT = 5;

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
  const hasCredentials = marketData ? (marketData.indices.length > 0 || marketData.news.length > 0) : false;

  const services = data?.services ?? { daemon: false, telegram: false, marketData: false, marketDataProvider: "none" as const };
  const nextCron = data?.nextCron ?? null;
  const funds = data?.funds ?? [];
  const fundExtras = data?.fundExtras ?? new Map();
  const indices = marketData?.indices ?? [];
  const news = marketData?.news ?? [];
  const marketOpen = marketData?.marketOpen ?? false;
  const isShort = rows < 20;

  const innerWidth = columns - 2; // inside outer border
  const halfInner = Math.floor(innerWidth / 2);
  const newsItems = Math.max(1, Math.floor((PANEL_HEIGHT - 2) * 0.6));

  // Active fund name (available once resolved)
  const activeFundName = phase.type === "ready" ? phase.fundName : undefined;

  // ── Panels block (reused in all states) ─────────────────────

  const panelsBlock = (
    <>
      {/* Top row: System Status | Fund Detail */}
      <Box>
        <SystemStatusPanel
          width={halfInner}
          height={PANEL_HEIGHT}
          services={services}
          nextCron={nextCron}
        />
        <FundsOverviewPanel
          funds={funds}
          fundExtras={fundExtras}
          activeFund={activeFundName}
          width={innerWidth - halfInner}
          height={PANEL_HEIGHT}
        />
      </Box>

      {/* Middle row: News | Markets (hidden on short terminals) */}
      {!isShort && (
        <Box>
          <NewsPanel
            headlines={news.slice(0, newsItems)}
            width={halfInner}
            height={PANEL_HEIGHT}
            hasCredentials={hasCredentials || services.marketData}
          />
          <MarketIndicesPanel
            indices={indices}
            width={innerWidth - halfInner}
            height={PANEL_HEIGHT}
            hasCredentials={hasCredentials || services.marketData}
          />
        </Box>
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

  const panelsHeight = isShort ? PANEL_HEIGHT : PANEL_HEIGHT * 2;
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
          onExit={() => exit()}
          onSwitchFund={(name) => setPhase({ type: "ready", fundName: name })}
          options={{ readonly: false }}
        />
      </Box>

      {/* Footer (outside border) */}
      {footerBlock}
    </Box>
  );
}
