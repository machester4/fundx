import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { getPnlData } from "../../services/chart.service.js";
import { BarChart } from "../../components/BarChart.js";
import { Header } from "../../components/Header.js";

export const description = "P&L chart by position";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function ChartPnl({ args: [fundName] }: Props) {
  const { data, isLoading, error } = useAsyncAction(
    () => getPnlData(fundName),
    [fundName],
  );

  if (isLoading) return <Spinner label="Loading P&L data..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data || data.items.length === 0) return <Text dimColor>No positions to chart.</Text>;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>P&amp;L by Position: {data.fundDisplayName}</Header>
      <BarChart
        data={data.items.map((d) => ({
          label: d.label,
          value: d.value,
        }))}
        title="Unrealized P&L %"
      />
    </Box>
  );
}
