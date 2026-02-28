import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getPerformanceData } from "../services/performance.service.js";
import { Header } from "../components/Header.js";
import { PnlText } from "../components/PnlText.js";

export const description = "View fund performance metrics";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function Performance({ args: [fundName] }: Props) {
  const { data, isLoading, error } = useAsyncAction(
    () => getPerformanceData(fundName),
    [fundName],
  );

  if (isLoading) return <Spinner label="Loading performance..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Performance: {data.fundDisplayName}</Header>

      <Box flexDirection="column">
        <Text bold>Portfolio</Text>
        <Text>  Initial Capital: ${data.initialCapital.toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
        <Text>  Current Value:   ${data.currentValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
        <Box>
          <Text>  Total Return:    </Text>
          <PnlText value={data.totalReturn} percentage={data.totalReturnPct} />
        </Box>
        <Text>  Cash:            ${data.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })} ({data.cashPct.toFixed(1)}%)</Text>
        <Text>  Positions:       {data.positionCount}</Text>
      </Box>

      {data.objective && (
        <Box flexDirection="column">
          <Text bold>Objective Progress</Text>
          <Text>  Type:     {data.objective.type}</Text>
          <Text>  Progress: {data.objective.progressPct.toFixed(1)}%</Text>
          <Text>  Status:   <Text color={data.objective.status === "behind" ? "yellow" : "green"}>{data.objective.status}</Text></Text>
        </Box>
      )}

      {data.tradeStats && (
        <Box flexDirection="column">
          <Text bold>Trade Statistics (Closed Trades)</Text>
          <Text>  Total Trades: {data.tradeStats.totalTrades}</Text>
          <Text>  Winning:      <Text color="green">{data.tradeStats.winningTrades}</Text></Text>
          <Text>  Losing:       <Text color="red">{data.tradeStats.losingTrades}</Text></Text>
          <Text>  Win Rate:     {data.tradeStats.winRate.toFixed(1)}%</Text>
          <Box>
            <Text>  Total P&amp;L:    </Text>
            <PnlText value={data.tradeStats.totalPnl} />
          </Box>
          <Box>
            <Text>  Best Trade:   </Text>
            <PnlText value={data.tradeStats.bestTradePnl} />
          </Box>
          <Box>
            <Text>  Worst Trade:  </Text>
            <PnlText value={data.tradeStats.worstTradePnl} />
          </Box>
        </Box>
      )}

      {data.recentActivity && (
        <Box flexDirection="column">
          <Text bold>Recent Activity</Text>
          <Text>  Trades (7d):  {data.recentActivity.weekTrades}</Text>
          <Text>  Trades (30d): {data.recentActivity.monthTrades}</Text>
        </Box>
      )}

      <Box flexDirection="column">
        <Text bold>Risk Profile</Text>
        <Text>  Profile:      {data.risk.profile}</Text>
        <Text>  Max Drawdown: {data.risk.maxDrawdownPct}%</Text>
        <Text>  Max Position: {data.risk.maxPositionPct}%</Text>
        <Text>  Stop Loss:    {data.risk.stopLossPct}%</Text>
      </Box>

      {data.overweightPositions.length > 0 && (
        <Box flexDirection="column">
          <Text color="yellow">Overweight positions:</Text>
          {data.overweightPositions.map((p) => (
            <Text key={p.symbol} color="yellow">  {p.symbol}: {p.weightPct.toFixed(1)}% (max: {p.maxPct}%)</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
