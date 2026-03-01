import React from "react";
import { Box, Text } from "ink";
import type { MarketIndexSnapshot } from "../types.js";

function formatPrice(price: number): string {
  if (price >= 10_000) return `$${(price / 1000).toFixed(1)}k`;
  if (price >= 1_000) return `$${price.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

interface MarketTickerBannerProps {
  indices: MarketIndexSnapshot[];
  width: number;
  hasCredentials: boolean;
}

export function MarketTickerBanner({ indices, width, hasCredentials }: MarketTickerBannerProps) {
  if (!hasCredentials) {
    return (
      <Box width={width} borderStyle="single" borderDimColor paddingX={1}>
        <Text dimColor>Configure market data provider to enable ticker</Text>
      </Box>
    );
  }

  if (indices.length === 0) {
    return (
      <Box width={width} borderStyle="single" borderDimColor paddingX={1}>
        <Text dimColor>Loading market data...</Text>
      </Box>
    );
  }

  return (
    <Box width={width} borderStyle="single" borderDimColor paddingX={1} gap={3}>
      {indices.map((idx) => {
        const up = idx.changePct >= 0;
        return (
          <Box key={idx.symbol} gap={1}>
            <Text bold>{idx.name}</Text>
            <Text>{formatPrice(idx.price)}</Text>
            <Text color={up ? "green" : "red"}>
              {up ? "▲" : "▼"} {formatChange(idx.changePct)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
