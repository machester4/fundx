import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getAllFundStatuses } from "../services/status.service.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { PnlText } from "../components/PnlText.js";

export const description = "Dashboard of all funds";

export default function Status() {
  const { data, isLoading, error } = useAsyncAction(getAllFundStatuses);

  if (isLoading) return <Spinner label="Loading dashboard..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data?.length) {
    return <Text dimColor>No funds yet. Run &apos;fundx fund create&apos;.</Text>;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>FundX Dashboard</Text>
      <Text> </Text>
      {data.map((fund) => (
        <Box key={fund.name} flexDirection="column" marginBottom={1}>
          <Box gap={1}>
            <StatusBadge status={fund.status} />
            <Text bold>{fund.displayName}</Text>
            <Text dimColor>({fund.name})</Text>
          </Box>
          <Box paddingLeft={2} gap={1}>
            <Text>Capital: ${fund.initialCapital.toLocaleString()} → ${fund.currentValue.toLocaleString()}</Text>
            <PnlText value={fund.pnl} percentage={fund.pnlPct} />
          </Box>
          {fund.progressPct !== null && (
            <Box paddingLeft={2}>
              <Text dimColor>Progress: {fund.progressPct.toFixed(1)}% — {fund.progressStatus}</Text>
            </Box>
          )}
          {fund.positions > 0 && (
            <Box paddingLeft={2}>
              <Text dimColor>Positions: {fund.positions} | Cash: {fund.cashPct.toFixed(0)}%</Text>
            </Box>
          )}
          {fund.lastSession && (
            <Box paddingLeft={2}>
              <Text dimColor>Last session: {fund.lastSession.type} ({fund.lastSession.startedAt})</Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
