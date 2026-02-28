import React from "react";
import { Box, Text } from "ink";

interface HeaderBarProps {
  daemonRunning: boolean;
  brokerMode?: "paper" | "live";
  width: number;
  currentView?: string;
}

export function HeaderBar({ daemonRunning, brokerMode, width, currentView }: HeaderBarProps) {
  return (
    <Box width={width} justifyContent="space-between">
      <Text bold color="cyan">
        FundX v0.1.0
      </Text>
      <Box gap={2}>
        {currentView && <Text dimColor>{currentView}</Text>}
        {brokerMode && (
          <Text color={brokerMode === "live" ? "red" : "yellow"} bold>
            {brokerMode.toUpperCase()}
          </Text>
        )}
        <Box gap={1}>
          <Text color={daemonRunning ? "green" : "red"}>
            {daemonRunning ? "●" : "○"}
          </Text>
          <Text dimColor>daemon</Text>
        </Box>
      </Box>
    </Box>
  );
}
