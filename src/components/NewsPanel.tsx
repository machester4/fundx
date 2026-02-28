import React from "react";
import { Box, Text } from "ink";
import type { NewsHeadline } from "../types.js";

interface NewsPanelProps {
  headlines: NewsHeadline[];
  width?: number;
  height?: number;
  hasCredentials: boolean;
}

export function NewsPanel({ headlines, width, height, hasCredentials }: NewsPanelProps) {
  // Inner width for truncating headlines
  const innerWidth = typeof width === "number" ? width - 6 : 50; // border(2) + paddingX(2) + "- "(2)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      width={width as number}
      height={height}
      paddingX={1}
    >
      {!hasCredentials ? (
        <Text dimColor>Configure broker to see news</Text>
      ) : headlines.length === 0 ? (
        <Text dimColor>No headlines available</Text>
      ) : (
        headlines.map((item, i) => {
          const maxLen = Math.max(10, innerWidth);
          const headline =
            item.headline.length > maxLen
              ? item.headline.substring(0, maxLen - 1) + "…"
              : item.headline;

          return (
            <Box key={item.id} flexDirection="column">
              <Text>
                <Text dimColor>- </Text>
                <Text>{headline}</Text>
              </Text>
              {i < headlines.length - 1 && (
                <Text dimColor>{"─".repeat(Math.max(1, innerWidth))}</Text>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
}
