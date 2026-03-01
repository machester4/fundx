import React from "react";
import { Box, Text } from "ink";
import { StatusBadge } from "./StatusBadge.js";
import { PnlText } from "./PnlText.js";
import type { ChatWelcomeData } from "../services/chat.service.js";

interface FundContextBarProps {
  welcome: ChatWelcomeData | null;
  model: string;
  workspaceFunds?: string[];
}

function ProgressBar({ pct, width = 10 }: { pct: number; width?: number }) {
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

export function FundContextBar({ welcome: w, model, workspaceFunds = [] }: FundContextBarProps) {
  if (!w) {
    // Workspace mode — no fund selected
    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Box justifyContent="space-between">
          <Box gap={1}>
            <Text bold>FundX</Text>
            <Text dimColor>·</Text>
            <Text dimColor>{model}</Text>
          </Box>
        </Box>
        <Box gap={2}>
          {workspaceFunds.length > 0 ? (
            workspaceFunds.map((f) => (
              <Text key={f} dimColor>{f}</Text>
            ))
          ) : (
            <Text dimColor>No funds yet</Text>
          )}
        </Box>
      </Box>
    );
  }

  const modeLabel = w.isReadonly ? "READ-ONLY" : w.fundConfig.broker.mode === "live" ? "LIVE" : "PAPER";
  const modeColor = w.isReadonly ? "gray" : w.fundConfig.broker.mode === "live" ? "red" : "yellow";

  const pnl = w.portfolio
    ? w.portfolio.total_value - (w.tracker?.initial_capital ?? w.portfolio.total_value)
    : 0;
  const pnlPct = w.tracker
    ? ((w.portfolio?.total_value ?? 0) - w.tracker.initial_capital) / w.tracker.initial_capital * 100
    : undefined;

  const topHoldings = w.portfolio?.positions
    .sort((a, b) => b.weight_pct - a.weight_pct)
    .slice(0, 4) ?? [];

  const cashPct = w.portfolio && w.portfolio.total_value > 0
    ? (w.portfolio.cash / w.portfolio.total_value) * 100
    : 100;

  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      {/* Line 1: fund info + value + progress */}
      <Box justifyContent="space-between">
        <Box gap={1}>
          <StatusBadge status={w.fundConfig.fund.status} />
          <Text bold>{w.fundConfig.fund.display_name}</Text>
          <Text dimColor>·</Text>
          <Text color={modeColor} bold>[{modeLabel}]</Text>
          <Text dimColor>·</Text>
          <Text dimColor>{model}</Text>
        </Box>
        <Box gap={2}>
          {w.portfolio && (
            <Box gap={1}>
              <Text bold>${w.portfolio.total_value.toLocaleString()}</Text>
              <PnlText value={pnl} percentage={pnlPct} />
            </Box>
          )}
          {w.tracker && <ProgressBar pct={w.tracker.progress_pct} />}
        </Box>
      </Box>

      {/* Line 2: top holdings */}
      <Box gap={2}>
        {topHoldings.map((h) => (
          <Text key={h.symbol} dimColor>
            {h.symbol} {h.weight_pct.toFixed(0)}%
          </Text>
        ))}
        <Text dimColor>Cash {cashPct.toFixed(0)}%</Text>
      </Box>
    </Box>
  );
}
