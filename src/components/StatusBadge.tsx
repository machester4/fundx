import React from "react";
import { Text } from "ink";

interface StatusBadgeProps {
  status: "active" | "paused" | "closed" | string;
}

const STATUS_MAP: Record<string, { icon: string; color: string }> = {
  active: { icon: "●", color: "green" },
  paused: { icon: "◐", color: "yellow" },
  closed: { icon: "○", color: "red" },
};

export function StatusBadge({ status }: StatusBadgeProps) {
  const { icon, color } = STATUS_MAP[status] ?? { icon: "?", color: "gray" };
  return <Text color={color}>{icon}</Text>;
}
