import React from "react";
import { Box, Text } from "ink";
import { LOGO_LINES } from "../services/chat.service.js";

interface LogoProps {
  color?: string;
  subtitle?: string;
}

export function Logo({ color = "cyan", subtitle }: LogoProps) {
  return (
    <Box flexDirection="column">
      {LOGO_LINES.map((line, i) => (
        <Text key={i} color={color}>
          {line}
        </Text>
      ))}
      {subtitle && (
        <Text dimColor>
          {"  "}
          {subtitle}
        </Text>
      )}
    </Box>
  );
}
