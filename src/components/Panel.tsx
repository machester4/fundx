import React from "react";
import { Box, Text } from "ink";

interface PanelProps {
  title?: string;
  titleColor?: string;
  borderStyle?: "single" | "double" | "round" | "bold" | "singleDouble" | "doubleSingle" | "classic";
  borderColor?: string;
  borderDimColor?: boolean;
  width?: number | string;
  height?: number;
  flexGrow?: number;
  flexShrink?: number;
  padding?: number;
  children: React.ReactNode;
}

export function Panel({
  title,
  titleColor = "white",
  borderStyle = "round",
  borderColor,
  borderDimColor,
  width,
  height,
  flexGrow,
  flexShrink,
  padding = 0,
  children,
}: PanelProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={borderColor}
      borderDimColor={borderDimColor}
      width={width as number}
      height={height}
      flexGrow={flexGrow}
      flexShrink={flexShrink}
      paddingX={padding}
    >
      {title && (
        <Text bold color={titleColor}>
          {title}
        </Text>
      )}
      {children}
    </Box>
  );
}
