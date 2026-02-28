import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { getAllocationData } from "../../services/chart.service.js";
import { BarChart } from "../../components/BarChart.js";
import { Header } from "../../components/Header.js";

export const description = "Portfolio allocation chart";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function ChartAllocation({ args: [fundName] }: Props) {
  const { data, isLoading, error } = useAsyncAction(
    () => getAllocationData(fundName),
    [fundName],
  );

  if (isLoading) return <Spinner label="Loading allocation data..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data || data.items.length === 0) return <Text dimColor>No positions to chart.</Text>;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Portfolio Allocation: {data.fundDisplayName}</Header>
      <BarChart
        data={data.items.map((d) => ({
          label: d.label,
          value: d.pct,
          color: d.isCash ? "yellow" : "cyan",
        }))}
        title="Weight %"
      />
    </Box>
  );
}
