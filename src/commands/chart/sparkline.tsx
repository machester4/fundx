import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { getHistoryData } from "../../services/chart.service.js";
import { renderSparkline } from "../../services/chart.service.js";
import { Header } from "../../components/Header.js";

export const description = "Portfolio value history sparkline";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

export const options = zod.object({
  days: zod.number().default(30).describe("Number of days to look back"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function ChartSparkline({ args: [fundName], options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(
    () => getHistoryData(fundName, opts.days),
    [fundName, opts.days],
  );

  if (isLoading) return <Spinner label="Loading history..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data || data.volumes.length === 0) return <Text dimColor>No history data available.</Text>;

  const spark = renderSparkline(data.volumes);

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Trade Activity History ({opts.days}d): {data.fundDisplayName}</Header>
      <Text>{spark}</Text>
      <Text dimColor>Total trades: {data.totalTrades} | Dates: {data.sortedDates.length}</Text>
    </Box>
  );
}
