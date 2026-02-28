import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getTradesDisplay } from "../services/trades.service.js";
import { Header } from "../components/Header.js";

export const description = "View trade history";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

export const options = zod.object({
  today: zod.boolean().default(false).describe("Show only today's trades"),
  week: zod.boolean().default(false).describe("Show trades from the last 7 days"),
  month: zod.boolean().default(false).describe("Show trades from the last 30 days"),
  limit: zod.number().default(20).describe("Number of trades to show"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function Trades({ args: [fundName], options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(
    () => getTradesDisplay(fundName, {
      today: opts.today || undefined,
      week: opts.week || undefined,
      month: opts.month || undefined,
      limit: opts.limit,
    }),
    [fundName],
  );

  if (isLoading) return <Spinner label="Loading trades..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Trades: {data.fundDisplayName} ({data.label})</Header>

      {data.trades.length === 0 ? (
        <Text dimColor>No trades found.</Text>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Text bold>
              {"Date".padEnd(20)} {"Side".padEnd(6)} {"Symbol".padEnd(8)} {"Qty".padEnd(8)} {"Price".padEnd(10)} {"Total".padEnd(12)} {"Type".padEnd(8)} {"P&L".padEnd(12)}
            </Text>
          </Box>
          <Text dimColor>{"─".repeat(84)}</Text>
          {data.trades.map((trade, i) => {
            const sideColor = trade.side === "buy" ? "green" : "red";
            const date = trade.timestamp.replace("T", " ").slice(0, 19);
            const pnlStr = trade.pnl !== null
              ? `${trade.pnl >= 0 ? "+" : ""}$${trade.pnl.toFixed(2)}`
              : "open";
            const pnlColor = trade.pnl !== null ? (trade.pnl >= 0 ? "green" : "red") : undefined;
            return (
              <Box key={i} flexDirection="column">
                <Box>
                  <Text>{date.padEnd(20)}</Text>
                  <Text color={sideColor}>{trade.side.toUpperCase().padEnd(6)}</Text>
                  <Text>{trade.symbol.padEnd(8)}</Text>
                  <Text>{String(trade.quantity).padEnd(8)}</Text>
                  <Text>{`$${trade.price.toFixed(2)}`.padEnd(10)}</Text>
                  <Text>{`$${trade.totalValue.toFixed(2)}`.padEnd(12)}</Text>
                  <Text>{trade.orderType.padEnd(8)}</Text>
                  <Text color={pnlColor} dimColor={trade.pnl === null}>{pnlStr}</Text>
                </Box>
                {trade.reasoning && (
                  <Text dimColor>    {trade.reasoning.slice(0, 100)}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
