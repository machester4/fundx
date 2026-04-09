import React from "react";
import { Box, Text } from "ink";

interface SidebarPanelProps {
  title: string;
  value?: string;
  color?: string;
  width: number;
  children: React.ReactNode;
}

export function SidebarPanel({ title, value, color, width, children }: SidebarPanelProps) {
  const innerWidth = width - 4; // account for "┌ " and " ┐"
  const titlePart = value ? `${title} ─ ${value}` : title;
  const dashCount = Math.max(0, innerWidth - titlePart.length - 1);
  const dashes = "─".repeat(dashCount);

  return (
    <Box flexDirection="column" width={width}>
      <Text>
        <Text dimColor>┌ </Text>
        <Text color={color} bold>{titlePart}</Text>
        <Text dimColor> {dashes}┐</Text>
      </Text>
      <Box flexDirection="column" paddingX={1} width={width - 2}>
        {children}
      </Box>
    </Box>
  );
}
