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
      <Box justifyContent="space-between">
        <Text dimColor>Cash ${portfolio.cash.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</Text>
        <Text dimColor>{cashPct}%</Text>
      </Box>
    </SidebarPanel>
  );
}
