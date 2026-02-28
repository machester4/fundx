import React from "react";
import { Box, Text } from "ink";
import { Panel } from "./Panel.js";
import type { DashboardAlerts } from "../services/status.service.js";

interface AlertsPanelProps {
  alerts: DashboardAlerts;
  width: number;
  maxLines?: number;
}

export function AlertsPanel({ alerts, width, maxLines = 5 }: AlertsPanelProps) {
  const items: Array<{ icon: string; color: string; text: string }> = [];

  for (const ow of alerts.overweight) {
    items.push({
      icon: "⚠",
      color: "yellow",
      text: `${ow.fund}: ${ow.symbol} at ${ow.weightPct.toFixed(1)}% (max ${ow.maxPct}%)`,
    });
  }

  for (const c of alerts.highCorrelations) {
    items.push({
      icon: "↔",
      color: "red",
      text: `${c.fundA} ↔ ${c.fundB} correlation ${c.correlation.toFixed(2)}`,
    });
  }

  for (const e of alerts.upcomingEvents) {
    items.push({
      icon: "📅",
      color: "blue",
      text: e.name,
    });
  }

  if (items.length === 0) {
    return (
      <Panel title="Alerts" borderDimColor width={width} padding={1}>
        <Text dimColor>No alerts</Text>
      </Panel>
    );
  }

  const visible = items.slice(0, maxLines);
  const remaining = items.length - visible.length;

  return (
    <Panel title="Alerts" borderDimColor width={width} padding={1}>
      {visible.map((item, i) => (
        <Box key={i} gap={1}>
          <Text color={item.color}>{item.icon}</Text>
          <Text>{item.text}</Text>
        </Box>
      ))}
      {remaining > 0 && (
        <Text dimColor>+{remaining} more</Text>
      )}
    </Panel>
  );
}
