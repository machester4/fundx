import React from "react";
import { Box, Text } from "ink";

interface FundDashboardHeaderProps {
  displayName: string;
  status: string;
  brokerMode: string;
  model: string;
  width: number;
}

export function FundDashboardHeader({ displayName, status, brokerMode, model, width }: FundDashboardHeaderProps) {
  const statusColor = status === "active" ? "green" : status === "paused" ? "yellow" : "red";
  const modeColor = brokerMode === "live" ? "red" : "cyan";

  return (
    <Box width={width} paddingX={1} justifyContent="space-between">
      <Text bold>{displayName}</Text>
      <Box gap={2}>
        <Text color={statusColor}>{status}</Text>
        <Text color={modeColor}>{brokerMode}</Text>
        <Text dimColor>{model}</Text>
      </Box>
    </Box>
  );
}
