import React from "react";
import { Box, Text } from "ink";
import { StatusBadge } from "./StatusBadge.js";
import { PnlText } from "./PnlText.js";
import { Sparkline } from "./Sparkline.js";
import type { FundStatusData, FundExtras } from "../services/status.service.js";

interface FundsOverviewPanelProps {
  funds: FundStatusData[];
  fundExtras: Map<string, FundExtras>;
  activeFund?: string;
  width?: number;
  height?: number;
}

function ProgressBar({ pct, barWidth = 8 }: { pct: number; barWidth?: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * barWidth);
  const empty = barWidth - filled;
  return (
    <Text>
      <Text color="green">{"█".repeat(filled)}</Text>
      <Text dimColor>{"░".repeat(empty)}</Text>
      <Text dimColor> {clamped.toFixed(0)}%</Text>
    </Text>
  );
}

export function FundsOverviewPanel({ funds, fundExtras, activeFund, width, height }: FundsOverviewPanelProps) {
  // Find the active fund or fall back to first fund
  const fund = funds.find((f) => f.name === activeFund) ?? funds[0];
  const extras = fund ? fundExtras.get(fund.name) : undefined;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderDimColor
      width={width as number}
      height={height}
      paddingX={1}
    >
      {!fund ? (
        <Text dimColor>Run fundx fund create</Text>
      ) : (
        <>
          {/* Line 1: status + name + value + P&L */}
          <Box justifyContent="space-between">
            <Box gap={1}>
              <StatusBadge status={fund.status} />
              <Text bold>{fund.displayName}</Text>
              <Text dimColor>·</Text>
              <Text dimColor>${fund.currentValue.toLocaleString()}</Text>
            </Box>
            <PnlText value={fund.pnl} percentage={fund.pnlPct} />
          </Box>

          {/* Line 2: holdings + cash */}
          <Box gap={2}>
            {extras && extras.topHoldings.length > 0 ? (
              extras.topHoldings.map((h) => (
                <Text key={h.symbol} dimColor>
                  {h.symbol} {h.weightPct.toFixed(0)}%
                </Text>
              ))
            ) : (
              <Text dimColor>No positions</Text>
            )}
            <Text dimColor>Cash {fund.cashPct.toFixed(0)}%</Text>
          </Box>

          {/* Line 3: objective + progress + sparkline */}
          <Box justifyContent="space-between">
            <Box gap={1}>
              {extras && <Text dimColor>{extras.objectiveLabel}</Text>}
              {fund.progressPct !== null && <ProgressBar pct={fund.progressPct} />}
            </Box>
            {extras && extras.sparklineValues.length > 0 && (
              <Sparkline values={extras.sparklineValues.slice(-12)} color={fund.pnl >= 0 ? "green" : "red"} />
            )}
          </Box>
        </>
      )}
    </Box>
  );
}
