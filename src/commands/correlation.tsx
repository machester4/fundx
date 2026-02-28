import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { computeCorrelationMatrix } from "../services/correlation.service.js";
import { Header } from "../components/Header.js";
import type { CorrelationEntry } from "../types.js";

export const description = "Cross-fund correlation analysis";

export default function Correlation() {
  const { data, isLoading, error } = useAsyncAction(computeCorrelationMatrix);

  if (isLoading) return <Spinner label="Computing correlation matrix..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data || data.length === 0) {
    return <Text dimColor>Need at least 2 funds for correlation analysis.</Text>;
  }

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Cross-Fund Correlation</Header>
      <Box flexDirection="column">
        {(data as CorrelationEntry[]).map((entry, i) => {
          const color = Math.abs(entry.correlation) > 0.7 ? "red" : Math.abs(entry.correlation) > 0.3 ? "yellow" : "green";
          return (
            <Box key={i} gap={1}>
              <Text>{entry.fund_a.padEnd(15)}</Text>
              <Text>↔</Text>
              <Text>{entry.fund_b.padEnd(15)}</Text>
              <Text color={color}>{entry.correlation.toFixed(3)}</Text>
              {entry.overlapping_symbols.length > 0 && (
                <Text dimColor>overlap: {entry.overlapping_symbols.join(", ")}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
