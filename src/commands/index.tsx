import React, { useState, useEffect, useCallback, useMemo } from "react";
import zod from "zod";
import { Box, Text, useApp, useInput } from "ink";
import { Spinner } from "@inkjs/ui";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getAllFundStatuses } from "../services/status.service.js";
import type { FundStatusData } from "../services/status.service.js";
import { forkSupervisor } from "../services/supervisor.service.js";
import { FundSelector } from "../components/FundSelector.js";
import { ChatView } from "../components/ChatView.js";
import { Logo } from "../components/Logo.js";

export const description = "FundX — Autonomous AI Fund Manager powered by the Claude Agent SDK";

export const options = zod.object({
  fund: zod.string().optional().describe("Fund to chat with"),
  model: zod.string().optional().describe("Claude model (sonnet, opus, haiku)"),
  readonly: zod.boolean().default(false).describe("Read-only mode (no trades)"),
  maxBudget: zod.string().optional().describe("Maximum budget in USD for the session"),
});

const PORTFOLIO_REFRESH_MS = 30_000;

type Phase =
  | { type: "loading" }
  | { type: "selecting" }
  | { type: "fund-dashboard"; fundName: string };

type Props = { options: zod.infer<typeof options> };

// ── Fund Dashboard Screen ────────────────────────────────────────

interface FundDashboardScreenProps {
  fundName: string;
  width: number;
  height: number;
  onBack: () => void;
  onExit: () => void;
  chatOptions: { model?: string; readonly: boolean; maxBudget?: string };
}

function FundDashboardScreen({ fundName, width, height, onBack, onExit, chatOptions }: FundDashboardScreenProps) {
  const handleSwitchFund = useCallback((_fundName: string) => {
    // Always go back to selector — direct switching not yet supported
    onBack();
  }, [onBack]);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  return (
    <ChatView
      key={fundName}
      fundName={fundName}
      width={width}
      height={height}
      mode="static"
      onExit={onExit}
      onSwitchFund={handleSwitchFund}
      options={chatOptions}
    />
  );
}

// ── Main Command ─────────────────────────────────────────────────

export default function Index({ options: opts }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>({ type: "loading" });
  const [fundStatusRefreshKey, setFundStatusRefreshKey] = useState(0);

  // Auto-start daemon in background if not running
  useEffect(() => {
    forkSupervisor().catch(() => {});
  }, []);

  // Load fund list on mount
  const fundStatuses = useAsyncAction(
    () => getAllFundStatuses(),
    [fundStatusRefreshKey],
  );

  // When fund statuses load, transition from loading to selecting (or fund-dashboard)
  useEffect(() => {
    if (phase.type !== "loading") return;
    if (fundStatuses.isLoading) return;

    const funds = fundStatuses.data ?? [];

    // If --fund flag provided, go directly to fund-dashboard
    if (opts.fund) {
      const match = funds.find((f) => f.name === opts.fund);
      if (match) {
        setPhase({ type: "fund-dashboard", fundName: match.name });
      } else {
        // Fund not found — still try, loadFundConfig will fail gracefully in dashboard
        setPhase({ type: "fund-dashboard", fundName: opts.fund });
      }
      return;
    }

    // Auto-select if only 1 fund
    if (funds.length === 1) {
      setPhase({ type: "fund-dashboard", fundName: funds[0].name });
      return;
    }

    // Otherwise show selector
    setPhase({ type: "selecting" });
  }, [phase.type, fundStatuses.isLoading, fundStatuses.data, opts.fund]);

  const handleSelectFund = useCallback((fundName: string) => {
    setPhase({ type: "fund-dashboard", fundName });
  }, []);

  const handleBackToSelector = useCallback(() => {
    // Refresh fund statuses when returning to selector
    setFundStatusRefreshKey((k) => k + 1);
    setPhase({ type: "loading" });
  }, []);

  const handleExit = useCallback(() => exit(), [exit]);

  const chatOptions = useMemo(
    () => ({ model: opts.model, readonly: opts.readonly, maxBudget: opts.maxBudget }),
    [opts.model, opts.readonly, opts.maxBudget],
  );

  // ── Phase: loading ──────────────────────────────────────────────

  if (phase.type === "loading") {
    return (
      <Box flexDirection="column" width={columns} height={rows} justifyContent="center" alignItems="center">
        <Spinner label="Loading funds..." />
      </Box>
    );
  }

  // ── Phase: selecting ────────────────────────────────────────────

  if (phase.type === "selecting") {
    const funds = fundStatuses.data ?? [];

    return (
      <FundSelectorScreen
        funds={funds}
        columns={columns}
        rows={rows}
        onSelect={handleSelectFund}
        onExit={handleExit}
      />
    );
  }

  // ── Phase: fund-dashboard ───────────────────────────────────────

  return (
    <FundDashboardScreen
      fundName={phase.fundName}
      width={columns}
      height={rows}
      onBack={handleBackToSelector}
      onExit={handleExit}
      chatOptions={chatOptions}
    />
  );
}

// ── Fund Selector Screen ─────────────────────────────────────────

interface FundSelectorScreenProps {
  funds: FundStatusData[];
  columns: number;
  rows: number;
  onSelect: (fundName: string) => void;
  onExit: () => void;
}

function FundSelectorScreen({ funds, columns, rows, onSelect, onExit }: FundSelectorScreenProps) {
  useInput((input, key) => {
    if (input === "q" && !key.ctrl && !key.meta) {
      onExit();
    }
  });

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1} paddingY={1}>
      <Logo subtitle="Autonomous AI Fund Manager" />
      <Box marginTop={1}>
        <Text> </Text>
      </Box>
      {funds.length === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>No funds found.</Text>
          <Text dimColor>Run <Text bold>fundx fund create</Text> to create your first fund.</Text>
        </Box>
      ) : (
        <FundSelector
          funds={funds}
          onSelect={onSelect}
          label="Select a fund to manage:"
        />
      )}
      <Box marginTop={1}>
        <Text dimColor>q: quit  c: create fund (coming soon)</Text>
      </Box>
    </Box>
  );
}
