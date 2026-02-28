import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getPortfolioDisplay } from "../services/portfolio.service.js";
import { PnlText } from "../components/PnlText.js";
import { Header } from "../components/Header.js";

export const description = "View fund portfolio holdings";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

export const options = zod.object({
  sync: zod.boolean().default(false).describe("Sync from broker before displaying"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function Portfolio({ args: [fundName], options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(
    () => getPortfolioDisplay(fundName, { sync: opts.sync }),
    [fundName, opts.sync],
  );

  if (isLoading) return <Spinner label="Loading portfolio..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Portfolio: {data.fundDisplayName}</Header>
      <Text dimColor>Last updated: {data.lastUpdated}</Text>
      {opts.sync && data.synced && <Text dimColor>Synced from broker.</Text>}

      <Box flexDirection="column">
        <Box gap={2}>
          <Text>Total Value: ${data.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}</Text>
        </Box>
        <Box gap={2}>
          <Text>Cash: ${data.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })} ({data.cashPct.toFixed(1)}%)</Text>
        </Box>
        <Box gap={2}>
          <Text>P&amp;L: </Text>
          <PnlText value={data.pnl} percentage={data.pnlPct} />
        </Box>
      </Box>

      {data.positions.length === 0 ? (
        <Text dimColor>No open positions.</Text>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text bold>
              {"Symbol".padEnd(8)} {"Shares".padEnd(8)} {"Avg Cost".padEnd(10)} {"Price".padEnd(10)} {"Mkt Value".padEnd(12)} {"P&L".padEnd(12)} {"P&L %".padEnd(8)} {"Weight".padEnd(8)} {"Stop".padEnd(8)}
            </Text>
          </Box>
          <Text dimColor>{"─".repeat(94)}</Text>
          {data.positions.map((pos) => {
            const pnlColor = pos.unrealizedPnl >= 0 ? "green" : "red";
            const stopStr = pos.stopLoss ? `$${pos.stopLoss.toFixed(2)}` : "—";
            return (
              <Box key={pos.symbol}>
                <Text bold>{pos.symbol.padEnd(8)}</Text>
                <Text>{String(pos.shares).padEnd(8)}</Text>
                <Text>{`$${pos.avgCost.toFixed(2)}`.padEnd(10)}</Text>
                <Text>{`$${pos.currentPrice.toFixed(2)}`.padEnd(10)}</Text>
                <Text>{`$${pos.marketValue.toFixed(2)}`.padEnd(12)}</Text>
                <Text color={pnlColor}>{`$${pos.unrealizedPnl.toFixed(2)}`.padEnd(12)}</Text>
                <Text color={pnlColor}>{`${pos.unrealizedPnlPct.toFixed(1)}%`.padEnd(8)}</Text>
                <Text>{`${pos.weightPct.toFixed(1)}%`.padEnd(8)}</Text>
                <Text>{stopStr.padEnd(8)}</Text>
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
