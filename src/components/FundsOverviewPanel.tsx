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

function FundListSummary({ funds, height }: { funds: FundStatusData[]; height?: number }) {
  const maxRows = (height ?? 5) - 2; // subtract border rows
  const visible = funds.slice(0, maxRows);
  const overflow = funds.length - visible.length;

  return (
    <>
      {visible.map((f) => (
        <Box key={f.name} justifyContent="space-between">
          <Box gap={1}>
            <StatusBadge status={f.status} />
            <Text>{f.displayName}</Text>
            <Text bold color={f.brokerMode === "live" ? "red" : "yellow"}>
              [{f.brokerMode === "live" ? "LIVE" : "PAPER"}]
            </Text>
            <Text dimColor>${f.currentValue.toLocaleString()}</Text>
          </Box>
          <PnlText value={f.pnl} percentage={f.pnlPct} />
        </Box>
      ))}
      {overflow > 0 && <Text dimColor>+{overflow} more</Text>}
    </>
  );
}

export function FundsOverviewPanel({ funds, fundExtras, activeFund, width, height }: FundsOverviewPanelProps) {
  const fund = activeFund ? funds.find((f) => f.name === activeFund) : undefined;
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
      {fund ? (
        <>
          {/* Line 1: status + name + mode badge + value + P&L */}
          <Box justifyContent="space-between">
            <Box gap={1}>
              <StatusBadge status={fund.status} />
              <Text bold>{fund.displayName}</Text>
              <Text
                bold
                color={fund.brokerMode === "live" ? "red" : "yellow"}
              >
                [{fund.brokerMode === "live" ? "LIVE" : "PAPER"}]
              </Text>
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
      ) : funds.length > 0 ? (
        <FundListSummary funds={funds} height={height} />
      ) : (
        <Text dimColor>No funds yet — ask Claude to create one</Text>
      )}
    </Box>
  );
}
