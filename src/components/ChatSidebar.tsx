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
    <Box flexDirection="column" width={width} flexGrow={1}>
      <HandoffPanel handoff={data.handoff} width={width} />
      <PortfolioPanel portfolio={data.portfolio} width={width} />
      <UpcomingPanel items={data.upcoming} width={width} />
      <MarketPanel tickers={data.market} isMarketOpen={data.isMarketOpen} width={width} />
      {/* Spacer fills remaining height */}
      <Box flexGrow={1} />
    </Box>
  );
}
