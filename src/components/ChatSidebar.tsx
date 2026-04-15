import React from "react";
import { Box, Text } from "ink";
import { HandoffPanel } from "./HandoffPanel.js";
import { PortfolioPanel } from "./PortfolioPanel.js";
import { UpcomingPanel } from "./UpcomingPanel.js";
import { ScreenersPanel } from "./ScreenersPanel.js";
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

  // Handoff gets ~30% of height; remaining 5 panels split the rest, with News
  // absorbing leftover via flexGrow. Each non-final panel has a 1-line bottom
  // margin so adjacent panels never visually collide when their content fills
  // the allotted height.
  const GAP = 1;
  const handoffHeight = Math.floor(height * 0.3);
  const remainingHeight = height - handoffHeight - GAP * 5;
  const panelHeight = Math.max(2, Math.floor(remainingHeight / 5));

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexDirection="column" height={handoffHeight} marginBottom={GAP} overflowY="hidden">
        <HandoffPanel handoff={data.handoff} width={width} />
      </Box>
      <Box flexDirection="column" height={panelHeight} marginBottom={GAP} overflowY="hidden">
        <PortfolioPanel portfolio={data.portfolio} width={width} />
      </Box>
      <Box flexDirection="column" height={panelHeight} marginBottom={GAP} overflowY="hidden">
        <UpcomingPanel items={data.upcoming} width={width} />
      </Box>
      <Box flexDirection="column" height={panelHeight} marginBottom={GAP} overflowY="hidden">
        <ScreenersPanel items={data.screeners} width={width} />
      </Box>
      <Box flexDirection="column" height={panelHeight} marginBottom={GAP} overflowY="hidden">
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
