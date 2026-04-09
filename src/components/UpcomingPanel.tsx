import React from "react";
import { Box, Text } from "ink";
import { SidebarPanel } from "./SidebarPanel.js";

export interface UpcomingItem {
  time: string;
  label: string;
  type: "session" | "event" | "past";
  status?: "success" | "error";
}

interface UpcomingPanelProps {
  items: UpcomingItem[];
  width: number;
}

export function UpcomingPanel({ items, width }: UpcomingPanelProps) {
  const past = items.filter((i) => i.type === "past");
  const upcoming = items.filter((i) => i.type !== "past");

  if (past.length === 0 && upcoming.length === 0) {
    return (
      <SidebarPanel title="SESSIONS" width={width}>
        <Text dimColor>No sessions today</Text>
      </SidebarPanel>
    );
  }

  return (
    <SidebarPanel title="SESSIONS" width={width}>
      {past.length > 0 && (
        <Box flexDirection="column">
          {past.map((item, i) => {
            const icon = item.status === "error" ? "✗" : "✓";
            const color = item.status === "error" ? "red" : "green";
            return (
              <Text key={`p${i}`} dimColor>
                <Text color={color}>{icon}</Text> {item.time} — {item.label}
              </Text>
            );
          })}
        </Box>
      )}
      {upcoming.length > 0 && past.length > 0 && (
        <Text dimColor>{"─".repeat(Math.min(width - 4, 20))}</Text>
      )}
      {upcoming.map((item, i) => {
        if (item.type === "event") {
          return <Text key={`u${i}`} color="yellow">{"▸ "}{item.label} {item.time}</Text>;
        }
        return <Text key={`u${i}`} dimColor>{"◷ "}{item.time} — {item.label}</Text>;
      })}
    </SidebarPanel>
  );
}
