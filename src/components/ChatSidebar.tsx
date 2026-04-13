import React from "react";
import { Box, Text } from "ink";
import { HandoffPanel } from "./HandoffPanel.js";
import { PortfolioPanel } from "./PortfolioPanel.js";
import { UpcomingPanel } from "./UpcomingPanel.js";
import { MarketPanel } from "./MarketPanel.js";
import { NewsSidebarPanel } from "./NewsSidebarPanel.js";
import type { SidebarData } from "../hooks/useSidebarData.js";

interface ChatSidebarProps {
  data: SidebarData;
  width: number;
  height: number;
}

export function ChatSidebar({ data, width, height }: ChatSidebarProps) {
  if (data.isLoading) {
    return (
      <Box flexDirection="column" width={width} height={height} paddingX={1}>
        <Text dimColor>Loading...</Text>
      </Box>
    );
  }

  // Handoff gets ~40% of height; remaining 4 panels split the rest equally.
  const handoffHeight = Math.floor(height * 0.4);
  const remainingHeight = height - handoffHeight;
  const panelHeight = Math.floor(remainingHeight / 4);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="column" height={handoffHeight} overflowY="hidden">
        <HandoffPanel handoff={data.handoff} width={width} />
      </Box>
      <Box flexDirection="column" height={panelHeight} overflowY="hidden">
        <PortfolioPanel portfolio={data.portfolio} width={width} />
      </Box>
      <Box flexDirection="column" height={panelHeight} overflowY="hidden">
        <UpcomingPanel items={data.upcoming} width={width} />
      </Box>
      <Box flexDirection="column" height={panelHeight} overflowY="hidden">
        <MarketPanel tickers={data.market} isMarketOpen={data.isMarketOpen} width={width} />
      </Box>
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        <NewsSidebarPanel
          articles={data.newsArticles}
          status={data.newsStatus}
          reason={data.newsReason}
          newestAgeMinutes={data.newsNewestAgeMinutes}
          width={width}
        />
      </Box>
    </Box>
  );
}
