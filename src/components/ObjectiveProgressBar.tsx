import React from "react";
import { Box, Text } from "ink";
import type { ObjectiveTracker } from "../types.js";

interface ObjectiveProgressBarProps {
  tracker: ObjectiveTracker | null;
  objectiveType: string;
  width: number;
}

export function ObjectiveProgressBar({ tracker, objectiveType, width }: ObjectiveProgressBarProps) {
  if (!tracker) {
    return (
      <Box width={width} paddingX={1}>
        <Text dimColor>No objective data</Text>
      </Box>
    );
  }

  const pct = Math.min(100, Math.max(0, tracker.progress_pct));
  const barWidth = Math.max(10, width - 30);
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  const statusColor = tracker.status === "on_track" || tracker.status === "ahead" ? "green" : tracker.status === "behind" ? "yellow" : "cyan";

  return (
    <Box width={width} paddingX={1} gap={1}>
      <Text>{objectiveType}</Text>
      <Text color={statusColor}>{bar}</Text>
      <Text>{pct.toFixed(0)}%</Text>
      <Text dimColor>{tracker.status}</Text>
    </Box>
  );
}
