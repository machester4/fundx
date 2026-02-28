import React, { useState, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { Spinner } from "@inkjs/ui";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getDashboardData } from "../services/status.service.js";
import { HeaderBar } from "../components/HeaderBar.js";
import { KeyboardHint } from "../components/KeyboardHint.js";
import { FundCard } from "../components/FundCard.js";
import { AlertsPanel } from "../components/AlertsPanel.js";
import { FundDetailView } from "../components/FundDetailView.js";
import { ChatView } from "../components/ChatView.js";

export const description = "FundX — Autonomous AI Fund Manager powered by the Claude Agent SDK";

type View = "dashboard" | "detail" | "chat";

const CARD_HEIGHT = 8;
const HEADER_HEIGHT = 1;
const FOOTER_HEIGHT = 1;
const ALERTS_HEIGHT = 6;

export default function Index() {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [view, setView] = useState<View>("dashboard");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedFund, setSelectedFund] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const { data, isLoading, error } = useAsyncAction(
    () => getDashboardData(),
    [refreshKey],
  );

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // Keyboard handling
  useInput((input, key) => {
    if (view === "dashboard") {
      if (key.upArrow && data) {
        setSelectedIndex((i) => Math.max(0, i - 1));
      }
      if (key.downArrow && data) {
        setSelectedIndex((i) => Math.min((data.funds.length || 1) - 1, i + 1));
      }
      if (key.return && data && data.funds.length > 0) {
        setSelectedFund(data.funds[selectedIndex].name);
        setView("detail");
      }
      if (input === "c" && !key.ctrl && data && data.funds.length > 0) {
        setSelectedFund(data.funds[selectedIndex].name);
        setView("chat");
      }
      if (input === "r" && !key.ctrl) {
        handleRefresh();
      }
      if (input === "q" && !key.ctrl) {
        exit();
      }
    }
    if (view === "detail" && key.escape) {
      setView("dashboard");
      setSelectedFund(null);
    }
  });

  // Loading state
  if (isLoading) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <HeaderBar daemonRunning={false} width={columns} currentView="Loading" />
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Spinner label="Loading dashboard..." />
        </Box>
      </Box>
    );
  }

  // Error state
  if (error) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <HeaderBar daemonRunning={false} width={columns} />
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text color="red">Error: {error.message}</Text>
        </Box>
      </Box>
    );
  }

  // No funds
  if (!data || data.funds.length === 0) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <HeaderBar daemonRunning={data?.daemonRunning ?? false} width={columns} />
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text dimColor>No funds yet. Run &apos;fundx fund create&apos; to get started.</Text>
        </Box>
      </Box>
    );
  }

  // Chat view
  if (view === "chat" && selectedFund) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <HeaderBar
          daemonRunning={data.daemonRunning}
          width={columns}
          currentView="Chat"
        />
        <ChatView
          fundName={selectedFund}
          width={columns}
          height={rows - HEADER_HEIGHT - FOOTER_HEIGHT}
          onExit={() => {
            setView("dashboard");
            setSelectedFund(null);
          }}
          options={{ readonly: false }}
        />
        <KeyboardHint
          hints={[
            { key: "Esc", label: "Back" },
            { key: "Ctrl+C", label: "Cancel" },
          ]}
        />
      </Box>
    );
  }

  // Detail view
  if (view === "detail" && selectedFund) {
    return (
      <Box flexDirection="column" width={columns} height={rows}>
        <HeaderBar
          daemonRunning={data.daemonRunning}
          width={columns}
          currentView="Detail"
        />
        <FundDetailView
          fundName={selectedFund}
          width={columns}
          height={rows - HEADER_HEIGHT - FOOTER_HEIGHT}
        />
        <KeyboardHint
          hints={[
            { key: "Esc", label: "Back" },
          ]}
        />
      </Box>
    );
  }

  // Dashboard view
  const contentHeight = rows - HEADER_HEIGHT - FOOTER_HEIGHT - ALERTS_HEIGHT;
  const visibleCards = Math.max(1, Math.floor(contentHeight / CARD_HEIGHT));
  const useGrid = columns > 120;
  const cardWidth = useGrid ? Math.floor((columns - 2) / 2) : columns;

  // Scroll offset — in grid mode each row holds 2 funds
  const visibleSlots = useGrid ? visibleCards * 2 : visibleCards;
  let scrollOffset = 0;
  if (selectedIndex >= visibleSlots) {
    scrollOffset = useGrid
      ? (Math.floor(selectedIndex / 2) - visibleCards + 1) * 2
      : selectedIndex - visibleCards + 1;
  }

  const visibleFunds = useGrid
    ? data.funds.slice(scrollOffset, scrollOffset + visibleCards * 2)
    : data.funds.slice(scrollOffset, scrollOffset + visibleCards);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* Header */}
      <HeaderBar
        daemonRunning={data.daemonRunning}
        width={columns}
        currentView="Dashboard"
      />

      {/* Fund cards */}
      <Box flexDirection="column" flexGrow={1}>
        {useGrid ? (
          // Two-column grid
          <>
            {Array.from({ length: Math.ceil(visibleFunds.length / 2) }, (_, rowIdx) => {
              const left = visibleFunds[rowIdx * 2];
              const right = visibleFunds[rowIdx * 2 + 1];
              const leftIdx = scrollOffset + rowIdx * 2;
              const rightIdx = scrollOffset + rowIdx * 2 + 1;
              return (
                <Box key={rowIdx}>
                  {left && (
                    <FundCard
                      fund={left}
                      extras={data.fundExtras.get(left.name) ?? emptyExtras()}
                      isSelected={leftIdx === selectedIndex}
                      width={cardWidth}
                    />
                  )}
                  {right && (
                    <FundCard
                      fund={right}
                      extras={data.fundExtras.get(right.name) ?? emptyExtras()}
                      isSelected={rightIdx === selectedIndex}
                      width={cardWidth}
                    />
                  )}
                </Box>
              );
            })}
          </>
        ) : (
          // Single column
          visibleFunds.map((fund, i) => (
            <FundCard
              key={fund.name}
              fund={fund}
              extras={data.fundExtras.get(fund.name) ?? emptyExtras()}
              isSelected={scrollOffset + i === selectedIndex}
              width={cardWidth}
            />
          ))
        )}
      </Box>

      {/* Alerts */}
      <AlertsPanel alerts={data.alerts} width={columns} maxLines={3} />

      {/* Footer */}
      <KeyboardHint
        hints={[
          { key: "↑↓", label: "Navigate" },
          { key: "↵", label: "Details" },
          { key: "c", label: "Chat" },
          { key: "r", label: "Refresh" },
          { key: "q", label: "Quit" },
        ]}
        right={`${data.funds.length} fund${data.funds.length !== 1 ? "s" : ""}`}
      />
    </Box>
  );
}

function emptyExtras() {
  return {
    sparklineValues: [],
    topHoldings: [],
    objectiveType: "unknown",
    objectiveLabel: "Unknown",
    nextSession: null,
    lastSessionAgo: null,
    tradesInLastSession: 0,
  };
}
