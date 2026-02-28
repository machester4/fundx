import React, { useState, useEffect } from "react";
import { Text } from "ink";

interface StreamingIndicatorProps {
  charCount: number;
}

const DOTS = ["", ".", "..", "..."];

export function StreamingIndicator({ charCount }: StreamingIndicatorProps) {
  const [dotIdx, setDotIdx] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setDotIdx((i) => (i + 1) % DOTS.length);
    }, 200);
    return () => clearInterval(timer);
  }, []);

  if (charCount > 0) {
    return (
      <Text color="blue">
        Streaming{DOTS[dotIdx]} ({charCount.toLocaleString()} chars)
      </Text>
    );
  }

  return (
    <Text color="blue">
      Thinking{DOTS[dotIdx]}
    </Text>
  );
}
