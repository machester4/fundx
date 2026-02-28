import React from "react";
import { Box, Text } from "ink";
import type { SectorSnapshot } from "../types.js";

interface SectorHeatmapPanelProps {
  sectors: SectorSnapshot[];
  width?: number;
  hasCredentials: boolean;
}

function SectorCell({ sector }: { sector: SectorSnapshot }) {
  const sign = sector.changePct >= 0 ? "+" : "";
  const color = sector.changePct >= 1 ? "green" : sector.changePct <= -1 ? "red" : "yellow";
  return (
    <Box gap={0} marginRight={2}>
      <Text dimColor>{sector.name} </Text>
      <Text color={color} bold={Math.abs(sector.changePct) >= 1.5}>
        {sign}{sector.changePct.toFixed(1)}%
      </Text>
    </Box>
  );
}

export function SectorHeatmapPanel({ sectors, width, hasCredentials }: SectorHeatmapPanelProps) {
  return (
    <Box
      flexDirection="row"
      borderStyle="round"
      borderDimColor
      width={width as number}
      paddingX={1}
      flexWrap="nowrap"
      alignItems="center"
    >
      {!hasCredentials ? (
        <Text dimColor>Configure market data provider to see sectors</Text>
      ) : sectors.length === 0 ? (
        <Text dimColor>Loading sector data...</Text>
      ) : (
        sectors.map((s) => <SectorCell key={s.symbol} sector={s} />)
      )}
    </Box>
  );
}
