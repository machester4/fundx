import React from "react";
import { Box, Text } from "ink";

interface Hint {
  key: string;
  label: string;
}

interface KeyboardHintProps {
  hints: Hint[];
  right?: string;
}

export function KeyboardHint({ hints, right }: KeyboardHintProps) {
  return (
    <Box justifyContent="space-between">
      <Box gap={2}>
        {hints.map((h) => (
          <Box key={h.key} gap={0}>
            <Text dimColor>[</Text>
            <Text color="cyan">{h.key}</Text>
            <Text dimColor>] </Text>
            <Text>{h.label}</Text>
          </Box>
        ))}
      </Box>
      {right && <Text dimColor>{right}</Text>}
    </Box>
  );
}
