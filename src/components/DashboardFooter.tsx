import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

interface DashboardFooterProps {
  hints: Array<{ key: string; label: string }>;
  model: string;
  marketOpen: boolean;
  width: number;
}

function formatClock(): string {
  const now = new Date();
  return now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function DashboardFooter({ hints, model, marketOpen, width }: DashboardFooterProps) {
  const [clock, setClock] = useState(formatClock);

  useEffect(() => {
    const id = setInterval(() => setClock(formatClock()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <Box width={width} justifyContent="space-between" paddingX={1}>
      {/* Left: keyboard hints */}
      <Box gap={1}>
        {hints.map((h) => (
          <Box key={h.key}>
            <Text dimColor>[</Text>
            <Text color="cyan">{h.key}</Text>
            <Text dimColor>]</Text>
          </Box>
        ))}
      </Box>

      {/* Center: model */}
      <Text dimColor>{model}</Text>

      {/* Right: clock + market status */}
      <Box gap={1}>
        <Text dimColor>{clock}</Text>
        <Text color={marketOpen ? "green" : "red"}>
          {marketOpen ? "[market open]" : "[market closed]"}
        </Text>
      </Box>
    </Box>
  );
}
