import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { getPortfolioDisplay } from "../services/portfolio.service.js";
import { swsEnrichPortfolio, swsTokenStatus } from "../services/sws.service.js";
import { PnlText } from "../components/PnlText.js";
import { Header } from "../components/Header.js";
import { SnowflakeScores } from "../components/SnowflakeScores.js";
import type { SwsSnowflake } from "../types.js";

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
  const { columns } = useTerminalSize();
  const [swsScores, setSwsScores] = useState<Map<string, SwsSnowflake>>(new Map());

  useEffect(() => {
    if (!data || data.positions.length === 0) return;

    let cancelled = false;

    (async () => {
      try {
        const status = await swsTokenStatus();
        if (!status.valid) return;

        const symbols = data.positions.map((p) => p.symbol);
        const scores = await swsEnrichPortfolio(symbols);
        if (!cancelled) {
          setSwsScores(scores);
        }
      } catch {
        // Graceful degradation — SWS columns simply not shown
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data]);

  if (isLoading) return <Spinner label="Loading portfolio..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  const showSws = columns >= 100 && swsScores.size > 0;
  const separatorWidth = showSws ? 109 : 94;

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
              {"Symbol".padEnd(8)}
              {"Shares".padEnd(8)}
              {"Avg Cost".padEnd(10)}
              {"Price".padEnd(10)}
              {"Mkt Value".padEnd(12)}
              {"P&L".padEnd(12)}
              {"P&L %".padEnd(8)}
              {"Weight".padEnd(8)}
              {"Stop".padEnd(8)}
              {showSws ? "V  F  H  P  D" : ""}
            </Text>
          </Box>
          <Text dimColor>{"─".repeat(separatorWidth)}</Text>
          {data.positions.map((pos) => {
            const pnlColor = pos.unrealizedPnl >= 0 ? "green" : "red";
            const stopStr = pos.stopLoss ? `$${pos.stopLoss.toFixed(2)}` : "—";
            const scores = swsScores.get(pos.symbol);
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
                {showSws && scores && <SnowflakeScores scores={scores} />}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
