import React from "react";
import { Text } from "ink";
import type { StreamingActivity } from "../hooks/useStreaming.js";

interface TurnSummaryProps {
  metrics: StreamingActivity | null;
}

export function TurnSummary({ metrics }: TurnSummaryProps) {
  if (!metrics) return null;

  const parts: string[] = [];

  // Tokens
  if (metrics.tokensIn > 0 || metrics.tokensOut > 0) {
    parts.push(`tokens: ${metrics.tokensIn.toLocaleString()} in / ${metrics.tokensOut.toLocaleString()} out`);
  }

  // Tools (aggregate by name with count)
  if (metrics.toolHistory.length > 0) {
    const counts = new Map<string, number>();
    for (const t of metrics.toolHistory) {
      counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    }
    const toolStr = Array.from(counts.entries())
      .map(([name, count]) => count > 1 ? `${name}(${count})` : name)
      .join(", ");
    parts.push(`tools: ${toolStr}`);
  }

  // Thinking
  if (metrics.thinkingCount > 0) {
    const secs = (metrics.thinkingTotalMs / 1000).toFixed(1);
    parts.push(`thinking: ${metrics.thinkingCount} block${metrics.thinkingCount > 1 ? "s" : ""}, ${secs}s`);
  }

  if (parts.length === 0) return null;

  return <Text dimColor>{parts.join(" | ")}</Text>;
}
