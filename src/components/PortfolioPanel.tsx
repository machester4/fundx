import React from "react";
import { Box, Text } from "ink";
import type { Portfolio } from "../types.js";

interface PortfolioPanelProps {
  portfolio: Portfolio | null;
  initialCapital: number;
  width: number;
}

export function PortfolioPanel({ portfolio, initialCapital, width }: PortfolioPanelProps) {
  if (!portfolio) {
    return (
      <Box width={width} paddingX={1}>
        <Text dimColor>No portfolio data</Text>
      </Box>
    );
  }

  const pnl = portfolio.total_value - initialCapital;
  const pnlPct = initialCapital > 0 ? (pnl / initialCapital) * 100 : 0;
  const pnlColor = pnl >= 0 ? "green" : "red";
  const pnlSign = pnl >= 0 ? "+" : "";

  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Box justifyContent="space-between">
        <Text>Cash: ${portfolio.cash.toLocaleString()}</Text>
        <Text>Total: ${portfolio.total_value.toLocaleString()}</Text>
        <Text color={pnlColor}>{pnlSign}${pnl.toFixed(0)} ({pnlSign}{pnlPct.toFixed(1)}%)</Text>
      </Box>
      {portfolio.positions.length > 0 && (
        <Box flexDirection="column">
          {portfolio.positions.slice(0, 5).map((p) => (
            <Box key={p.symbol} justifyContent="space-between">
              <Text>{p.symbol} x{p.shares}</Text>
              <Text>${p.market_value.toFixed(0)}</Text>
              <Text color={p.unrealized_pnl >= 0 ? "green" : "red"}>
                {p.unrealized_pnl >= 0 ? "+" : ""}{p.unrealized_pnl_pct.toFixed(1)}%
              </Text>
            </Box>
          ))}
          {portfolio.positions.length > 5 && (
            <Text dimColor>...and {portfolio.positions.length - 5} more</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
