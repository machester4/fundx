import React from "react";
import { Text } from "ink";
import { SidebarPanel } from "./SidebarPanel.js";

export interface ScreenerItem {
  ticker: string;
  status: "candidate" | "watching";
  peak_score: number | null;
  screen_count: number;
}

interface ScreenersPanelProps {
  items: ScreenerItem[];
  width: number;
}

const STATUS_ICON: Record<ScreenerItem["status"], string> = {
  candidate: "●",
  watching: "◆",
};

const STATUS_COLOR: Record<ScreenerItem["status"], string> = {
  candidate: "cyan",
  watching: "green",
};

function formatScore(score: number | null): string {
  if (score == null) return "—";
  return score.toFixed(3);
}

export function ScreenersPanel({ items, width }: ScreenersPanelProps) {
  const count = items.length > 0 ? String(items.length) : undefined;

  if (items.length === 0) {
    return (
      <SidebarPanel title="SCREENERS" color="green" width={width}>
        <Text dimColor>No candidates</Text>
      </SidebarPanel>
    );
  }

  return (
    <SidebarPanel title="SCREENERS" color="green" value={count} width={width}>
      {items.map((item, i) => (
        <Text key={`${item.ticker}-${i}`}>
          <Text color={STATUS_COLOR[item.status]}>{STATUS_ICON[item.status]}</Text>
          <Text> {item.ticker.padEnd(6)}</Text>
          <Text dimColor>{formatScore(item.peak_score)}</Text>
          {item.screen_count > 1 && <Text dimColor> +{item.screen_count - 1}</Text>}
        </Text>
      ))}
    </SidebarPanel>
  );
}
