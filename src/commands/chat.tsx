import React, { useState, useEffect, useCallback } from "react";
import zod from "zod";
import { Box, Text, useInput, useApp } from "ink";
import { Spinner, TextInput, Select } from "@inkjs/ui";
import {
  resolveChatFund,
  resolveChatModel,
  buildChatMcpServers,
  buildChatContext,
  buildCompactContext,
  loadChatWelcomeData,
} from "../services/chat.service.js";
import { useStreaming } from "../hooks/useStreaming.js";
import { Logo } from "../components/Logo.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { PnlText } from "../components/PnlText.js";
import { MarkdownView } from "../components/MarkdownView.js";
import type { ChatWelcomeData, CostTracker } from "../services/chat.service.js";

export const description = "Interactive chat with a fund's AI agent";

export const options = zod.object({
  fund: zod.string().optional().describe("Fund to chat with"),
  model: zod.string().optional().describe("Claude model (sonnet, opus, haiku)"),
  readonly: zod.boolean().default(false).describe("Read-only mode (no trades)"),
  maxBudget: zod.string().optional().describe("Maximum budget in USD for the session"),
});

type Props = { options: zod.infer<typeof options> };

type Phase =
  | { type: "resolving" }
  | { type: "selecting-fund"; funds: string[] }
  | { type: "loading-context"; fundName: string }
  | { type: "idle"; fundName: string; welcome: ChatWelcomeData }
  | { type: "streaming"; fundName: string }
  | { type: "error"; message: string };

export default function Chat({ options: opts }: Props) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>({ type: "resolving" });
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [turnCount, setTurnCount] = useState(0);
  const [costTracker, setCostTracker] = useState<CostTracker>({ total_cost_usd: 0, total_turns: 0, messages: 0 });
  const [responses, setResponses] = useState<Array<{ text: string; cost: number; turns: number }>>([]);
  const [model, setModel] = useState("sonnet");
  const [mcpServers, setMcpServers] = useState<Record<string, { command: string; args: string[]; env: Record<string, string> }>>({});
  const streaming = useStreaming();

  // Resolve fund on mount
  useEffect(() => {
    (async () => {
      try {
        const { fundName, allFunds } = await resolveChatFund(opts.fund);
        if (!fundName) {
          setPhase({ type: "selecting-fund", funds: allFunds });
          return;
        }
        await initChat(fundName);
      } catch (err: unknown) {
        setPhase({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, []);

  const initChat = async (fundName: string) => {
    setPhase({ type: "loading-context", fundName });
    const resolvedModel = await resolveChatModel(fundName, opts.model);
    const servers = await buildChatMcpServers(fundName);
    const welcome = await loadChatWelcomeData(fundName, resolvedModel, opts.readonly);
    setModel(resolvedModel);
    setMcpServers(servers);
    setPhase({ type: "idle", fundName, welcome });
  };

  const sendMessage = useCallback(async (fundName: string, message: string) => {
    setPhase({ type: "streaming", fundName });
    try {
      const context = turnCount === 0
        ? await buildChatContext(fundName)
        : await buildCompactContext(fundName);

      const result = await streaming.send(fundName, sessionId, message, context, {
        model,
        maxBudgetUsd: opts.maxBudget ? parseFloat(opts.maxBudget) : undefined,
        readonly: opts.readonly,
        mcpServers,
      });

      setSessionId(result.sessionId);
      setTurnCount((c) => c + 1);
      setCostTracker((t) => ({
        total_cost_usd: t.total_cost_usd + result.cost_usd,
        total_turns: t.total_turns + result.num_turns,
        messages: t.messages + 1,
      }));
      setResponses((r) => [...r, { text: result.responseText, cost: result.cost_usd, turns: result.num_turns }]);
      setPhase({ type: "idle", fundName, welcome: (phase as { welcome: ChatWelcomeData }).welcome });
    } catch (err: unknown) {
      setPhase({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [turnCount, sessionId, model, mcpServers, opts, streaming, phase]);

  // Ctrl+C handler
  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      if (streaming.isStreaming) {
        streaming.cancel();
      } else {
        exit();
      }
    }
  });

  // Render phases
  if (phase.type === "resolving") return <Spinner label="Resolving fund..." />;
  if (phase.type === "error") return <Text color="red">Error: {phase.message}</Text>;

  if (phase.type === "selecting-fund") {
    return (
      <Box flexDirection="column">
        <Text>Select a fund:</Text>
        <Select
          options={phase.funds.map((f) => ({ label: f, value: f }))}
          onChange={(value) => { initChat(value); }}
        />
      </Box>
    );
  }

  if (phase.type === "loading-context") {
    return <Spinner label={`Loading ${phase.fundName}...`} />;
  }

  if (phase.type === "streaming") {
    return (
      <Box flexDirection="column" paddingX={1}>
        {responses.map((r, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <MarkdownView content={r.text} />
            <Text dimColor>[${r.cost.toFixed(4)} | {r.turns} turns]</Text>
          </Box>
        ))}
        {streaming.buffer ? (
          <MarkdownView content={streaming.buffer} />
        ) : (
          <Spinner label="Thinking..." />
        )}
      </Box>
    );
  }

  // Idle — show welcome banner + input
  const w = phase.welcome;
  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Welcome banner (first render only) */}
      {responses.length === 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Box gap={4}>
            <Logo />
            <Box flexDirection="column">
              <Box gap={1}>
                <StatusBadge status={w.fundConfig.fund.status} />
                <Text bold>{w.fundConfig.fund.display_name}</Text>
                <Text dimColor>{w.isReadonly ? "[READ-ONLY]" : w.fundConfig.broker.mode === "live" ? "[LIVE]" : "[PAPER]"}</Text>
              </Box>
              <Text dimColor>{w.fundName} · {w.fundConfig.risk.profile} · {w.fundConfig.broker.provider}</Text>
              {w.portfolio && (
                <Box gap={1}>
                  <Text bold>${w.portfolio.total_value.toLocaleString()}</Text>
                  <PnlText
                    value={w.portfolio.total_value - (w.tracker?.initial_capital ?? w.portfolio.total_value)}
                    percentage={w.tracker ? ((w.portfolio.total_value - w.tracker.initial_capital) / w.tracker.initial_capital * 100) : undefined}
                  />
                </Box>
              )}
              <Text dimColor>Daemon: {w.daemon.running ? "running" : "stopped"} · Model: {w.model}</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Previous responses */}
      {responses.map((r, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <MarkdownView content={r.text} />
          <Text dimColor>[${r.cost.toFixed(4)} | {r.turns} turns]</Text>
        </Box>
      ))}

      {/* Cost summary */}
      {costTracker.messages > 0 && (
        <Text dimColor>
          Session: ${costTracker.total_cost_usd.toFixed(4)} | {costTracker.messages} messages | {costTracker.total_turns} turns
        </Text>
      )}

      {/* Input */}
      <Box marginTop={1}>
        <Text color="green">● </Text>
        <TextInput
          placeholder="Type a message... (/help for commands, /q to quit)"
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (!trimmed) return;
            if (trimmed === "/q" || trimmed === "exit" || trimmed === "quit") {
              exit();
              return;
            }
            if (trimmed === "/help") {
              setResponses((r) => [...r, { text: "**Chat Commands**\n- `/help` — Show this help\n- `/cost` — Show session cost\n- `/clear` — Reset conversation\n- `/q` — Exit chat", cost: 0, turns: 0 }]);
              return;
            }
            if (trimmed === "/cost") {
              setResponses((r) => [...r, { text: `**Session Cost:** $${costTracker.total_cost_usd.toFixed(4)} | Messages: ${costTracker.messages} | Turns: ${costTracker.total_turns}`, cost: 0, turns: 0 }]);
              return;
            }
            if (trimmed === "/clear") {
              setSessionId(undefined);
              setTurnCount(0);
              setResponses([]);
              return;
            }
            sendMessage(phase.fundName, trimmed);
          }}
        />
      </Box>
    </Box>
  );
}
