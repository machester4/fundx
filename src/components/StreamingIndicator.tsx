import React, { useState, useEffect } from "react";
import { Text } from "ink";
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

  // Priority: task > tool > thinking > streaming text
  if (activity?.taskLabel) {
    return (
      <Text color="cyan">
        Agent: {activity.taskLabel}{dots}
      </Text>
    );
  }

  if (activity?.toolName) {
    const elapsed = activity.toolElapsed > 0 ? ` (${Math.round(activity.toolElapsed)}s)` : "";
    return (
      <Text color="yellow">
        Tool: {activity.toolName}{elapsed}{dots}
      </Text>
    );
  }

  if (activity?.thinking) {
    return (
      <Text color="magenta">
        Thinking{dots}
      </Text>
    );
  }

  if (charCount > 0) {
    return (
      <Text color="blue">
        Streaming{dots} ({charCount.toLocaleString()} chars)
      </Text>
    );
  }

  return (
    <Text color="blue">
      Thinking{dots}
    </Text>
  );
}
