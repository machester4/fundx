import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StreamingActivity } from "../hooks/useStreaming.js";

interface StreamingIndicatorProps {
  charCount: number;
  activity?: StreamingActivity;
}

const DOTS = ["", ".", "..", "..."];

export function StreamingIndicator({ charCount, activity }: StreamingIndicatorProps) {
  const [dotIdx, setDotIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setDotIdx((i) => (i + 1) % DOTS.length);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  const dots = DOTS[dotIdx];
  const lines: React.ReactNode[] = [];

  // Error (persists until next tool starts)
  if (activity?.error) {
    lines.push(
      <Text key="error" color="red">[error] {activity.error}</Text>,
    );
  }

  // Sub-agent task
  if (activity?.taskLabel) {
    const toolInfo = activity.taskToolCount > 0 ? `, ${activity.taskToolCount} tools` : "";
    lines.push(
      <Text key="task" color="cyan">[agent] {activity.taskLabel}{toolInfo}{dots}</Text>,
    );
  }

  // Tool execution
  if (activity?.toolName) {
    const elapsed = activity.toolElapsed > 0 ? ` (${activity.toolElapsed.toFixed(1)}s)` : "";
    lines.push(
      <Text key="tool" color="yellow">
        {activity.taskLabel ? "  " : ""}[tool] {activity.toolName}{elapsed}{dots}
      </Text>,
    );
    if (activity.toolInput) {
      lines.push(
        <Text key="toolInput" dimColor>
          {activity.taskLabel ? "  " : ""}       {activity.toolInput}
        </Text>,
      );
    }
  }

  // Thinking
  if (activity?.thinking) {
    const elapsed = activity.thinkingStartedAt
      ? ((Date.now() - activity.thinkingStartedAt) / 1000).toFixed(1)
      : "0.0";
    lines.push(
      <Text key="thinking" color="magenta">[thinking] {elapsed}s{dots}</Text>,
    );
  }

  // Fallback: streaming text or initial thinking
  if (lines.length === 0) {
    if (charCount > 0) {
      lines.push(
        <Text key="streaming" color="blue">Streaming{dots} ({charCount.toLocaleString()} chars)</Text>,
      );
    } else {
      lines.push(
        <Text key="init" color="blue">Thinking{dots}</Text>,
      );
    }
  }

  return <Box flexDirection="column">{lines}</Box>;
}
