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
  // border(2) + paddingX(2) + "· "(2) + source + " "
  const innerWidth = typeof width === "number" ? width - 6 : 50;

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
        headlines.map((item) => {
          const sourceTag = item.source ? `${item.source.slice(0, 12)} ` : "";
          const headlineWidth = Math.max(10, innerWidth - sourceTag.length - 2);
          const headline =
            item.headline.length > headlineWidth
              ? item.headline.substring(0, headlineWidth - 1) + "…"
              : item.headline;

          return (
            <Box key={item.id}>
              <Text dimColor>· </Text>
              <Text dimColor>{sourceTag}</Text>
              <Text>{headline}</Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}
