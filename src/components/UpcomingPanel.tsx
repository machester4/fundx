import React from "react";
import { Text } from "ink";
import { SidebarPanel } from "./SidebarPanel.js";

export interface UpcomingItem {
  time: string;
  label: string;
  type: "session" | "event";
}

interface UpcomingPanelProps {
  items: UpcomingItem[];
  width: number;
}

export function UpcomingPanel({ items, width }: UpcomingPanelProps) {
  if (items.length === 0) {
    return (
      <SidebarPanel title="UPCOMING" width={width}>
        <Text dimColor>No upcoming sessions today</Text>
      </SidebarPanel>
    );
  }

  return (
    <SidebarPanel title="UPCOMING" width={width}>
      {items.map((item, i) => {
        if (item.type === "event") {
          return <Text key={i} color="yellow">{"▸ "}{item.label} {item.time}</Text>;
        }
        return <Text key={i} dimColor>{"◷ "}{item.time} — {item.label}</Text>;
      })}
    </SidebarPanel>
  );
}
