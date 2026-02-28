import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { Spinner, TextInput } from "@inkjs/ui";
import {
  resolveChatModel,
  buildChatMcpServers,
  buildChatContext,
  buildCompactContext,
  loadChatWelcomeData,
} from "../services/chat.service.js";
import { getPortfolioDisplay } from "../services/portfolio.service.js";
import { getTradesDisplay } from "../services/trades.service.js";
import { useStreaming } from "../hooks/useStreaming.js";
import { ChatMessage } from "./ChatMessage.js";
import { StreamingIndicator } from "./StreamingIndicator.js";
import { FundContextBar } from "./FundContextBar.js";
import { MarkdownView } from "./MarkdownView.js";
import type { ChatWelcomeData, CostTracker } from "../services/chat.service.js";

interface ChatViewProps {
  fundName: string;
  width: number;
  height: number;
  onExit?: () => void;
  options: { model?: string; readonly: boolean; maxBudget?: string };
}

interface ChatMsg {
  id: number;
  sender: "you" | "claude" | "system";
  content: string;
  timestamp: Date;
  cost?: number;
  turns?: number;
}

export function ChatView({ fundName, width, height, onExit, options }: ChatViewProps) {
  const [phase, setPhase] = useState<"loading" | "ready" | "streaming" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [welcomeData, setWelcomeData] = useState<ChatWelcomeData | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [nextId, setNextId] = useState(1);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [turnCount, setTurnCount] = useState(0);
  const [costTracker, setCostTracker] = useState<CostTracker>({ total_cost_usd: 0, total_turns: 0, messages: 0 });
  const [model, setModel] = useState("sonnet");
  const [mcpServers, setMcpServers] = useState<Record<string, { command: string; args: string[]; env: Record<string, string> }>>({});
  const streaming = useStreaming();

  const addMessage = useCallback((sender: ChatMsg["sender"], content: string, cost?: number, turns?: number) => {
    setMessages((prev) => [...prev, {
      id: nextId,
      sender,
      content,
      timestamp: new Date(),
      cost,
      turns,
    }]);
    setNextId((n) => n + 1);
  }, [nextId]);

  // Initialize
  useEffect(() => {
    (async () => {
      try {
        const resolvedModel = await resolveChatModel(fundName, options.model);
        const servers = await buildChatMcpServers(fundName);
        const welcome = await loadChatWelcomeData(fundName, resolvedModel, options.readonly);
        setModel(resolvedModel);
        setMcpServers(servers);
        setWelcomeData(welcome);
        setPhase("ready");
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
  }, [fundName]);

  const sendMessage = useCallback(async (message: string) => {
    setPhase("streaming");
    try {
      const context = turnCount === 0
        ? await buildChatContext(fundName)
        : await buildCompactContext(fundName);

      const result = await streaming.send(fundName, sessionId, message, context, {
        model,
        maxBudgetUsd: options.maxBudget ? parseFloat(options.maxBudget) : undefined,
        readonly: options.readonly,
        mcpServers,
      });

      setSessionId(result.sessionId);
      setTurnCount((c) => c + 1);
      setCostTracker((t) => ({
        total_cost_usd: t.total_cost_usd + result.cost_usd,
        total_turns: t.total_turns + result.num_turns,
        messages: t.messages + 1,
      }));

      setMessages((prev) => [...prev, {
        id: nextId + 1,
        sender: "claude",
        content: result.responseText,
        timestamp: new Date(),
        cost: result.cost_usd,
        turns: result.num_turns,
      }]);
      setNextId((n) => n + 2);
      setPhase("ready");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [turnCount, sessionId, model, mcpServers, options, streaming, fundName, nextId]);

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // Slash commands
    if (trimmed === "/q" || trimmed === "exit" || trimmed === "quit") {
      onExit?.();
      return;
    }
    if (trimmed === "/help") {
      addMessage("system", "**Chat Commands**\n- `/help` — Show this help\n- `/cost` — Show session cost\n- `/clear` — Reset conversation\n- `/portfolio` — Show portfolio\n- `/trades` — Show recent trades\n- `/fund` — Switch fund\n- `/q` — Exit chat");
      return;
    }
    if (trimmed === "/cost") {
      addMessage("system", `**Session Cost:** $${costTracker.total_cost_usd.toFixed(4)} | Messages: ${costTracker.messages} | Turns: ${costTracker.total_turns}`);
      return;
    }
    if (trimmed === "/clear") {
      setSessionId(undefined);
      setTurnCount(0);
      setMessages([]);
      setNextId(1);
      return;
    }
    if (trimmed === "/portfolio") {
      try {
        const p = await getPortfolioDisplay(fundName);
        const lines = [`**Portfolio — ${p.fundDisplayName}**`, `Total: $${p.totalValue.toLocaleString()} | Cash: $${p.cash.toFixed(2)} (${p.cashPct.toFixed(1)}%)`];
        for (const pos of p.positions) {
          const sign = pos.unrealizedPnl >= 0 ? "+" : "";
          lines.push(`  ${pos.symbol}  ${pos.shares} shares  $${pos.currentPrice.toFixed(2)}  ${sign}${pos.unrealizedPnlPct.toFixed(1)}%  ${pos.weightPct.toFixed(0)}%`);
        }
        addMessage("system", lines.join("\n"));
      } catch {
        addMessage("system", "Portfolio data unavailable");
      }
      return;
    }
    if (trimmed === "/trades") {
      try {
        const t = await getTradesDisplay(fundName, { limit: 10 });
        const lines = [`**Recent Trades — ${t.fundDisplayName}** (${t.label})`];
        for (const trade of t.trades) {
          lines.push(`  ${trade.side.toUpperCase()} ${trade.symbol} ×${trade.quantity} $${trade.price.toFixed(2)}${trade.pnl !== null ? ` P&L: $${trade.pnl.toFixed(2)}` : ""}`);
        }
        addMessage("system", lines.join("\n"));
      } catch {
        addMessage("system", "Trade data unavailable");
      }
      return;
    }

    // Regular message
    addMessage("you", trimmed);
    await sendMessage(trimmed);
  }, [addMessage, costTracker, fundName, onExit, sendMessage]);

  // Keyboard: Esc to go back
  useInput((input, key) => {
    if (key.escape && phase !== "streaming") {
      onExit?.();
    }
    if (input === "c" && key.ctrl && streaming.isStreaming) {
      streaming.cancel();
      setPhase("ready");
    }
  });

  if (phase === "loading") {
    return <Spinner label={`Loading ${fundName}...`} />;
  }

  if (phase === "error") {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {errorMsg}</Text>
        <Text dimColor>Press Esc to go back</Text>
      </Box>
    );
  }

  const isStreaming = phase === "streaming";

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Context bar */}
      {welcomeData && <FundContextBar welcome={welcomeData} />}

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {messages.length === 0 && !isStreaming && (
          <Box marginY={1} paddingX={1}>
            <Text dimColor>
              Chat with {welcomeData?.fundConfig.fund.display_name ?? fundName}. Type a message or /help for commands.
            </Text>
          </Box>
        )}
        {messages.map((msg) => (
          <Box key={msg.id} paddingX={1}>
            <ChatMessage
              sender={msg.sender}
              content={msg.content}
              timestamp={msg.timestamp}
              cost={msg.cost}
              turns={msg.turns}
            />
          </Box>
        ))}
        {isStreaming && (
          <Box paddingX={1} flexDirection="column">
            {streaming.buffer ? (
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text bold color="blue">claude</Text>
                  <StreamingIndicator charCount={streaming.charCount} />
                </Box>
                <MarkdownView content={streaming.buffer} />
              </Box>
            ) : (
              <StreamingIndicator charCount={0} />
            )}
          </Box>
        )}
      </Box>

      {/* Cost summary */}
      {costTracker.messages > 0 && (
        <Box paddingX={1}>
          <Text dimColor>
            ${costTracker.total_cost_usd.toFixed(4)} | {costTracker.messages} msgs | {costTracker.total_turns} turns
          </Text>
        </Box>
      )}

      {/* Input */}
      {!isStreaming && (
        <Box paddingX={1}>
          <Text color="green">❯ </Text>
          <TextInput
            placeholder="Message... (/help for commands)"
            onSubmit={handleSubmit}
          />
        </Box>
      )}
    </Box>
  );
}
