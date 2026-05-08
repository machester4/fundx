import React from "react";
import { Box, Text } from "ink";
import { StatusBadge } from "./StatusBadge.js";
import { PnlText } from "./PnlText.js";
import { Sparkline } from "./Sparkline.js";
import type { FundStatusData, FundExtras, FundDailyUsage } from "../services/status.service.js";

interface FundsOverviewPanelProps {
  funds: FundStatusData[];
  fundExtras: Map<string, FundExtras>;
  activeFund?: string;
  width?: number;
  height?: number;
  dailyUsage?: Map<string, FundDailyUsage>;
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

function TodayUsageCell({ usage, compact }: { usage: FundDailyUsage; compact?: boolean }) {
  const pctRounded = Math.round(usage.pct);
  let color: "redBright" | "yellow" | "white" | "gray" = "gray";
  if (usage.capped) color = "redBright";
  else if (usage.pct >= 80) color = "yellow";
  else if (usage.pct >= 50) color = "white";

  if (compact) {
    // List summary: short form "$X.XX/$Y" with color, plus 🔴 when capped
    const text = `$${usage.totalUsd.toFixed(2)}/$${usage.cap}`;
    return <Text color={color}>{usage.capped ? `🔴 ${text}` : text}</Text>;
  }

  // Focused view: full "today: $X.XX/$Y (Z%)" with color and ⚠️/🔴 indicators
  if (usage.capped) {
    return <Text color={color}>🔴 today: CAPPED ${usage.totalUsd.toFixed(2)}/${usage.cap}</Text>;
  }
  const indicator = usage.pct >= 80 ? " ⚠️" : "";
  return <Text color={color}>today: ${usage.totalUsd.toFixed(2)}/${usage.cap} ({pctRounded}%){indicator}</Text>;
}

function FundListSummary({
  funds,
  height,
  dailyUsage,
}: {
  funds: FundStatusData[];
  height?: number;
  dailyUsage?: Map<string, FundDailyUsage>;
}) {
  const maxRows = (height ?? 5) - 2; // subtract border rows
  const visible = funds.slice(0, maxRows);
  const overflow = funds.length - visible.length;

  return (
    <>
      {visible.map((f) => {
        const usage = dailyUsage?.get(f.name);
        return (
          <Box key={f.name} justifyContent="space-between">
            <Box gap={1}>
              <StatusBadge status={f.status} />
              <Text>{f.displayName}</Text>
              <Text bold color={f.brokerMode === "live" ? "red" : "yellow"}>
                [{f.brokerMode === "live" ? "LIVE" : "PAPER"}]
              </Text>
              <Text dimColor>${f.currentValue.toLocaleString()}</Text>
            </Box>
            <Box gap={1}>
              <PnlText value={f.pnl} percentage={f.pnlPct} />
              {usage && <TodayUsageCell usage={usage} compact />}
            </Box>
          </Box>
        );
      })}
      {overflow > 0 && <Text dimColor>+{overflow} more</Text>}
    </>
  );
}

export function FundsOverviewPanel({ funds, fundExtras, activeFund, width, height, dailyUsage }: FundsOverviewPanelProps) {
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

          {/* Line 4 (Phase 4): today's USD usage vs daily cap */}
          {dailyUsage && (() => {
            const usage = dailyUsage.get(fund.name);
            if (!usage) return null;
            return (
              <Box>
                <TodayUsageCell usage={usage} />
              </Box>
            );
          })()}
        </>
      ) : funds.length > 0 ? (
        <FundListSummary funds={funds} height={height} dailyUsage={dailyUsage} />
      ) : (
        <Text dimColor>No funds yet — ask Claude to create one</Text>
      )}
    </Box>
  );
}
