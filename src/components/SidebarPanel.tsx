import React from "react";
import { Box, Text } from "ink";

interface SidebarPanelProps {
  title: string;
  value?: string;
  width: number;
  children: React.ReactNode;
}

export function SidebarPanel({ title, value, width, children }: SidebarPanelProps) {
  const innerWidth = width - 4; // account for "┌ " and " ┐"
  const titlePart = value ? `${title} ─ ${value}` : title;
  const dashCount = Math.max(0, innerWidth - titlePart.length - 1);
  const header = `┌ ${titlePart} ${"─".repeat(dashCount)}┐`;

  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor>{header}</Text>
      <Box flexDirection="column" paddingLeft={1} width={width - 1}>
        {children}
      </Box>
    </Box>
  );
}
