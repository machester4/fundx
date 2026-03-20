import React from "react";
import { Box, Text } from "ink";
import { Select } from "@inkjs/ui";
import type { FundStatusData } from "../services/status.service.js";

interface FundSelectorProps {
  funds: FundStatusData[];
  onSelect: (fundName: string) => void;
  label?: string;
}

function formatTimeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Note: @inkjs/ui Select only accepts string labels, so StatusBadge/PnlText components
// cannot be used here. Status icons and P&L are formatted as inline strings instead.
export function FundSelector({ funds, onSelect, label = "Select a fund:" }: FundSelectorProps) {
  if (funds.length === 0) {
    return <Text dimColor>No funds available. Press 'c' to create one.</Text>;
  }

  const options = funds.map((f) => {
    const pnlSign = f.pnl >= 0 ? "+" : "";
    const pnlStr = `${pnlSign}$${Math.abs(f.pnl).toFixed(0)} (${pnlSign}${f.pnlPct.toFixed(1)}%)`;
    const lastStr = f.lastSession ? formatTimeSince(f.lastSession.startedAt) : "never";
    const statusIcon = f.status === "active" ? "\u25CF" : f.status === "paused" ? "\u25CB" : "\u25A0";

    return {
      label: `${statusIcon} ${f.displayName} (${f.name})  $${f.currentValue.toLocaleString()} ${pnlStr}  Last: ${lastStr}`,
      value: f.name,
    };
  });

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Select options={options} onChange={onSelect} />
    </Box>
  );
}
