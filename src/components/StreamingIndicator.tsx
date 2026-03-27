import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import type { StreamingActivity } from "../hooks/useStreaming.js";

interface StreamingIndicatorProps {
  charCount: number;
  activity?: StreamingActivity;
  buffer?: string;
}

const DOTS = ["", ".", "..", "..."];

export function StreamingIndicator({ charCount, activity, buffer }: StreamingIndicatorProps) {
  const [dotIdx, setDotIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setDotIdx((i) => (i + 1) % DOTS.length);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  const dots = DOTS[dotIdx];
  const lines: React.ReactNode[] = [];

  // Error
  if (activity?.error) {
    lines.push(
      <Text key="error" color="red">{"\u25CF"} {activity.error}</Text>,
    );
  }

  // Sub-agent task
  if (activity?.taskLabel) {
    const toolInfo = activity.taskToolCount > 0 ? `, ${activity.taskToolCount} tools` : "";
    lines.push(
      <Text key="task" color="cyan">{"\u25CF"} Agent({activity.taskLabel}{toolInfo}){dots}</Text>,
    );
  }

  // Tool execution — green dot + name(input preview)
  if (activity?.toolName) {
    const elapsed = activity.toolElapsed > 0 ? ` (${activity.toolElapsed.toFixed(1)}s)` : "";
    const inputPreview = activity.toolInput ? `(${activity.toolInput})` : "";
    const indent = activity.taskLabel ? "  " : "";
    lines.push(
      <Text key="tool" color="green">
        {indent}{"\u25CF"} <Text bold>{activity.toolName}</Text>{inputPreview}{elapsed}{dots}
      </Text>,
    );
  }

  // Thinking
  if (activity?.thinking) {
    const elapsed = activity.thinkingStartedAt
      ? ((Date.now() - activity.thinkingStartedAt) / 1000).toFixed(1)
      : "0.0";
    lines.push(
      <Text key="thinking" color="magenta">{"\u25CF"} Thinking ({elapsed}s){dots}</Text>,
    );
  }

  // Fallback
  if (lines.length === 0) {
    if (charCount > 0 && buffer) {
      // Show last non-empty line as preview (truncated to ~100 chars)
      const lastLine = buffer.trimEnd().split("\n").filter((l) => l.trim()).pop() ?? "";
      const preview = lastLine.length > 100 ? lastLine.slice(0, 100) + "..." : lastLine;
      lines.push(
        <Text key="streaming" dimColor>{"\u25CF"} {preview}</Text>,
      );
    } else if (charCount > 0) {
      lines.push(
        <Text key="streaming" dimColor>{"\u25CF"} Streaming{dots}</Text>,
      );
    } else {
      lines.push(
        <Text key="init" dimColor>{"\u25CF"} Thinking{dots}</Text>,
      );
    }
  }

  return <Box flexDirection="column">{lines}</Box>;
}
