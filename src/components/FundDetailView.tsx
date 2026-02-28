import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { Panel } from "./Panel.js";
import { PnlText } from "./PnlText.js";
import { StatusBadge } from "./StatusBadge.js";
import { BarChart } from "./BarChart.js";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getPortfolioDisplay } from "../services/portfolio.service.js";
import { getPerformanceData } from "../services/performance.service.js";
import { getOverviewData } from "../services/chart.service.js";
import { getTradesDisplay } from "../services/trades.service.js";

interface FundDetailViewProps {
  fundName: string;
  width: number;
  height: number;
}

export function FundDetailView({ fundName, width, height }: FundDetailViewProps) {
  const portfolio = useAsyncAction(() => getPortfolioDisplay(fundName), [fundName]);
  const performance = useAsyncAction(() => getPerformanceData(fundName), [fundName]);
  const overview = useAsyncAction(() => getOverviewData(fundName), [fundName]);
  const trades = useAsyncAction(() => getTradesDisplay(fundName, { limit: 8 }), [fundName]);

  if (portfolio.isLoading || performance.isLoading) {
    return <Spinner label={`Loading ${fundName}...`} />;
  }

  const p = portfolio.data;
  const perf = performance.data;
  const ov = overview.data;
  const t = trades.data;

  const halfWidth = Math.floor((width - 2) / 2);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Title */}
      <Box gap={1} marginBottom={0}>
        <StatusBadge status={perf?.objective?.status === "on_track" ? "active" : "paused"} />
        <Text bold>{p?.fundDisplayName ?? fundName}</Text>
        <Text dimColor>({fundName})</Text>
        {p && (
          <Box gap={1}>
            <Text bold>${p.totalValue.toLocaleString()}</Text>
            <PnlText value={p.pnl} percentage={p.pnlPct} />
          </Box>
        )}
      </Box>

      {/* Two-column layout */}
      <Box flexGrow={1}>
        {/* Left column */}
        <Box flexDirection="column" width={halfWidth}>
          {/* Portfolio */}
          <Panel title="Portfolio" borderDimColor flexGrow={1} padding={1}>
            {p && p.positions.length > 0 ? (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text bold dimColor>{"Symbol".padEnd(8)}</Text>
                  <Text bold dimColor>{"Shares".padEnd(8)}</Text>
                  <Text bold dimColor>{"Price".padEnd(10)}</Text>
                  <Text bold dimColor>{"P&L".padEnd(10)}</Text>
                  <Text bold dimColor>{"Wt%"}</Text>
                </Box>
                {p.positions.map((pos) => (
                  <Box key={pos.symbol} gap={1}>
                    <Text>{pos.symbol.padEnd(8)}</Text>
                    <Text>{String(pos.shares).padEnd(8)}</Text>
                    <Text>${pos.currentPrice.toFixed(2).padEnd(8)}</Text>
                    <PnlText value={pos.unrealizedPnl} percentage={pos.unrealizedPnlPct} />
                    <Text dimColor> {pos.weightPct.toFixed(0)}%</Text>
                  </Box>
                ))}
                <Text dimColor>Cash: ${p.cash.toFixed(2)} ({p.cashPct.toFixed(1)}%)</Text>
              </Box>
            ) : (
              <Text dimColor>No positions</Text>
            )}
          </Panel>

          {/* Allocation */}
          {ov && ov.allocation.length > 0 && (
            <Panel title="Allocation" borderDimColor padding={1}>
              <BarChart
                data={ov.allocation.map((a) => ({
                  label: a.label,
                  value: a.pct,
                  color: a.isCash ? "gray" : undefined,
                }))}
                width={Math.max(halfWidth - 20, 10)}
              />
            </Panel>
          )}
        </Box>

        {/* Right column */}
        <Box flexDirection="column" width={halfWidth}>
          {/* Performance */}
          <Panel title="Performance" borderDimColor flexGrow={1} padding={1}>
            {perf ? (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text>Return:</Text>
                  <PnlText value={perf.totalReturn} percentage={perf.totalReturnPct} />
                </Box>
                {perf.tradeStats && (
                  <>
                    <Text>
                      Win Rate: {perf.tradeStats.winRate.toFixed(0)}% ({perf.tradeStats.winningTrades}/{perf.tradeStats.totalTrades})
                    </Text>
                    <Box gap={1}>
                      <Text>Best:</Text>
                      <PnlText value={perf.tradeStats.bestTradePnl} />
                      <Text> Worst:</Text>
                      <PnlText value={perf.tradeStats.worstTradePnl} />
                    </Box>
                  </>
                )}
                <Text>Risk: {perf.risk.profile}</Text>
                {perf.objective && (
                  <Text dimColor>
                    Objective: {perf.objective.type} — {perf.objective.progressPct.toFixed(1)}% ({perf.objective.status})
                  </Text>
                )}
              </Box>
            ) : (
              <Text dimColor>No performance data</Text>
            )}
          </Panel>

          {/* Recent Trades */}
          <Panel title="Recent Trades" borderDimColor padding={1}>
            {t && t.trades.length > 0 ? (
              <Box flexDirection="column">
                {t.trades.slice(0, 6).map((trade, i) => (
                  <Box key={i} gap={1}>
                    <Text color={trade.side === "buy" ? "green" : "red"}>
                      {trade.side.toUpperCase().padEnd(4)}
                    </Text>
                    <Text>{trade.symbol.padEnd(6)}</Text>
                    <Text dimColor>×{trade.quantity}</Text>
                    <Text dimColor>${trade.price.toFixed(2)}</Text>
                    {trade.pnl !== null && <PnlText value={trade.pnl} />}
                  </Box>
                ))}
              </Box>
            ) : (
              <Text dimColor>No trades yet</Text>
            )}
          </Panel>
        </Box>
      </Box>
    </Box>
  );
}
