import React from "react";
import { Box, Text } from "ink";
import type { ServiceStatus, NextCronInfo } from "../types.js";

interface SystemStatusPanelProps {
  width?: number;
  height?: number;
  services: ServiceStatus;
  nextCron: NextCronInfo | null;
}

function ServiceDot({ label, active }: { label: string; active: boolean }) {
  return (
    <Box gap={1}>
      <Text dimColor>{label}</Text>
      <Text color={active ? "green" : "red"}>{active ? "●" : "○"}</Text>
    </Box>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  fmp: "FMP",
  alpaca: "Alpaca",
  none: "Market",
};

export function SystemStatusPanel({ width, height, services, nextCron }: SystemStatusPanelProps) {
  const cronLabel = nextCron
    ? `Cron in ${nextCron.minutesUntil}m`
    : "No crons";

  const marketLabel = PROVIDER_LABELS[services.marketDataProvider] ?? "Market";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      width={width as number}
      height={height}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color="cyan">FUNDX</Text>
        <ServiceDot label="Daemon" active={services.daemon} />
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>v0.1.0</Text>
        <ServiceDot label="Telegram" active={services.telegram} />
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>{cronLabel}</Text>
        <ServiceDot label={marketLabel} active={services.marketData} />
      </Box>
    </Box>
  );
}
