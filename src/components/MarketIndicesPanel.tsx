import React from "react";
import { Box, Text } from "ink";
import { Sparkline } from "./Sparkline.js";
import type { MarketIndexSnapshot } from "../types.js";

interface MarketIndicesPanelProps {
  indices: MarketIndexSnapshot[];
  width?: number;
  height?: number;
  hasCredentials: boolean;
}

function formatPrice(price: number): string {
  if (price >= 10_000) {
    return `$${(price / 1000).toFixed(1)}k`;
  }
  return `$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatChange(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export function MarketIndicesPanel({ indices, width, height, hasCredentials }: MarketIndicesPanelProps) {
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
        <Text dimColor>Configure market data provider</Text>
      ) : indices.length === 0 ? (
        <Text dimColor>Loading market data...</Text>
      ) : (
        indices.map((idx) => (
          <Box key={idx.symbol} justifyContent="space-between" gap={1}>
            <Text bold>{idx.name}</Text>
            <Box gap={1}>
              <Text>{formatPrice(idx.price)}</Text>
              <Text color={idx.changePct >= 0 ? "green" : "red"}>
                {formatChange(idx.changePct)}
              </Text>
              {idx.sparklineValues.length > 0 ? (
                <Sparkline
                  values={idx.sparklineValues.slice(-12)}
                  color={idx.changePct >= 0 ? "green" : "red"}
                />
              ) : (
                <Text dimColor>—</Text>
              )}
            </Box>
          </Box>
        ))
      )}
    </Box>
  );
}
