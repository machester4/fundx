import React from "react";
import { Box, Text } from "ink";

interface HeaderProps {
  children: React.ReactNode;
  rule?: boolean;
  width?: number;
}

export function Header({ children, rule = false, width = 50 }: HeaderProps) {
  return (
    <Box flexDirection="column">
      <Text bold>{children}</Text>
      {rule && <Text dimColor>{"─".repeat(width)}</Text>}
    </Box>
  );
}
