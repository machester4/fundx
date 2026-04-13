import React from "react";
import { Box, Text } from "ink";
import { StatusBadge } from "./StatusBadge.js";
import { PnlText } from "./PnlText.js";
import type { ChatWelcomeData } from "../services/chat.service.js";

interface FundContextBarProps {
  welcome: ChatWelcomeData | null;
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

export function FundContextBar({ welcome: w, workspaceFunds = [] }: FundContextBarProps) {
  if (!w) {
    // Workspace mode — no fund selected. Show available funds so the user knows
    // what they can /fund switch to. Model is intentionally omitted here (it's
    // already shown in the chat reply header, e.g., "> sonnet 4.6").
    return (
      <Box justifyContent="space-between" borderStyle="round" borderDimColor paddingX={1}>
        <Text bold>FundX</Text>
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

  const modeLabel = w.isReadonly ? "READ-ONLY" : "PAPER";
  const modeColor = w.isReadonly ? "gray" : "yellow";

  const pnl = w.portfolio
    ? w.portfolio.total_value - (w.tracker?.initial_capital ?? w.portfolio.total_value)
    : 0;
  const pnlPct = w.tracker
    ? ((w.portfolio?.total_value ?? 0) - w.tracker.initial_capital) / w.tracker.initial_capital * 100
    : undefined;

  // Slim single-line layout: identity (status + name + mode) on the left,
  // unique aggregate metrics (total P&L + objective progress) on the right.
  // Total value, holdings, cash %, and model are intentionally omitted —
  // they're already shown in PortfolioPanel and the chat reply header.
  return (
    <Box justifyContent="space-between" borderStyle="round" borderDimColor paddingX={1}>
      <Box gap={1}>
        <StatusBadge status={w.fundConfig.fund.status} />
        <Text bold>{w.fundConfig.fund.display_name}</Text>
        <Text dimColor>·</Text>
        <Text color={modeColor} bold>[{modeLabel}]</Text>
      </Box>
      <Box gap={2}>
        {w.portfolio && w.tracker && <PnlText value={pnl} percentage={pnlPct} />}
        {w.tracker && <ProgressBar pct={w.tracker.progress_pct} />}
      </Box>
    </Box>
  );
}
