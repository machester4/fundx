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
      <SidebarPanel title="MARKET" color="cyanBright" width={width}>
        <Text dimColor>No market data</Text>
      </SidebarPanel>
    );
  }

  return (
    <SidebarPanel title="MARKET" color="cyanBright" width={width}>
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
