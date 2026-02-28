import React from "react";
import { Box, Text } from "ink";
import { StatusBadge } from "./StatusBadge.js";
import { PnlText } from "./PnlText.js";
import { Sparkline } from "./Sparkline.js";
import type { FundStatusData, FundExtras } from "../services/status.service.js";

interface FundCardProps {
  fund: FundStatusData;
  extras: FundExtras;
  isSelected: boolean;
  width: number;
}

function ProgressBar({ pct, width = 20 }: { pct: number; width?: number }) {
  const filled = Math.round((Math.min(pct, 100) / 100) * width);
  const empty = width - filled;
  return (
    <Text>
      <Text color="green">{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(empty)}</Text>
      <Text dimColor> {pct.toFixed(0)}%</Text>
    </Text>
  );
}

export function FundCard({ fund, extras, isSelected, width }: FundCardProps) {
  const borderColor = isSelected ? "cyan" : undefined;
  const borderStyle = isSelected ? "bold" : "round";

  const holdingsStr = extras.topHoldings
    .map((h) => `${h.symbol} ${h.weightPct.toFixed(0)}%`)
    .join("  ");

  const cashPct = fund.cashPct;
  const holdingsWithCash = holdingsStr
    ? `${holdingsStr}  Cash ${cashPct.toFixed(0)}%`
    : `Cash ${cashPct.toFixed(0)}%`;

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle as "bold" | "round"}
      borderColor={borderColor}
      width={width}
      paddingX={1}
    >
      {/* Line 1: status dot + name + objective */}
      <Box justifyContent="space-between">
        <Box gap={1}>
          <StatusBadge status={fund.status} />
          <Text bold>{fund.displayName}</Text>
        </Box>
        <Text dimColor>
          {extras.objectiveType} ({extras.objectiveLabel})
        </Text>
      </Box>

      {/* Line 2: progress bar + value + P&L */}
      <Box gap={2}>
        {fund.progressPct !== null && (
          <ProgressBar pct={fund.progressPct} width={16} />
        )}
        <Box gap={1}>
          <Text>${fund.initialCapital.toLocaleString()} →</Text>
          <Text bold>${fund.currentValue.toLocaleString()}</Text>
          <PnlText value={fund.pnl} percentage={fund.pnlPct} />
        </Box>
      </Box>

      {/* Line 3: holdings */}
      <Text dimColor>{holdingsWithCash}</Text>

      {/* Line 4: sparkline + next session */}
      <Box justifyContent="space-between">
        {extras.sparklineValues.length > 0 ? (
          <Sparkline values={extras.sparklineValues} />
        ) : (
          <Text dimColor>No trade history</Text>
        )}
        {extras.nextSession && (
          <Text dimColor>Next: {extras.nextSession}</Text>
        )}
      </Box>

      {/* Line 5: last session info */}
      {extras.lastSessionAgo && (
        <Text dimColor>
          Last: {extras.lastSessionAgo}
          {extras.tradesInLastSession > 0 && ` — ${extras.tradesInLastSession} trades`}
        </Text>
      )}
    </Box>
  );
}
