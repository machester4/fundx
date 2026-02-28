import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { Spinner, TextInput } from "@inkjs/ui";
import {
  resolveChatModel,
  buildChatMcpServers,
  buildChatContext,
  buildCompactContext,
  loadChatWelcomeData,
} from "../services/chat.service.js";
import { listFundNames } from "../services/fund.service.js";
import { getPortfolioDisplay } from "../services/portfolio.service.js";
import { getTradesDisplay } from "../services/trades.service.js";
import { useStreaming } from "../hooks/useStreaming.js";
import { ChatMessage } from "./ChatMessage.js";
import { StreamingIndicator } from "./StreamingIndicator.js";
import { FundContextBar } from "./FundContextBar.js";
import { MarkdownView } from "./MarkdownView.js";
import type { ChatWelcomeData, CostTracker } from "../services/chat.service.js";

/** Estimate how many terminal lines a message will occupy. */
function estimateMessageLines(msg: { sender: string; content: string }, width: number): number {
  const contentWidth = Math.max(width - 2, 20); // paddingX=1 each side
  let lines = 1; // sender header line
  for (const line of msg.content.split("\n")) {
    lines += Math.max(1, Math.ceil((line.length || 1) / contentWidth));
  }
  lines += 1; // marginBottom
  return lines;
}

interface ChatViewProps {
  fundName: string;
  width: number;
  height: number;
  onExit?: () => void;
  onSwitchFund?: (fundName: string) => void;
  options: { model?: string; readonly: boolean; maxBudget?: string };
  mode?: "standalone" | "inline";
}

interface ChatMsg {
  id: number;
  sender: "you" | "claude" | "system";
  content: string;
  timestamp: Date;
  cost?: number;
  turns?: number;
}

export function ChatView({ fundName, width, height, onExit, onSwitchFund, options, mode = "standalone" }: ChatViewProps) {
  const isInline = mode === "inline";
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
  const [scrollOffset, setScrollOffset] = useState(0); // 0 = pinned to bottom
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
      addMessage("system", "**Chat Commands**\n- `/help` — Show this help\n- `/cost` — Show session cost\n- `/clear` — Reset conversation\n- `/portfolio` — Show portfolio\n- `/trades` — Show recent trades\n- `/fund` — List funds\n- `/fund <name>` — Switch to fund\n- `/q` — Exit");
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

    // /fund — list or switch
    if (trimmed === "/fund" || trimmed.startsWith("/fund ")) {
      const arg = trimmed.slice(5).trim();
      try {
        const allFunds = await listFundNames();
        if (!arg) {
          // List available funds
          const lines = [`**Funds** (current: ${fundName})`];
          for (const f of allFunds) {
            const marker = f === fundName ? " ← active" : "";
            lines.push(`  ${f}${marker}`);
          }
          lines.push("", "Switch with `/fund <name>`");
          addMessage("system", lines.join("\n"));
        } else {
          // Switch to specified fund
          const match = allFunds.find((f) => f.toLowerCase() === arg.toLowerCase());
          if (!match) {
            addMessage("system", `Fund '${arg}' not found. Available: ${allFunds.join(", ")}`);
          } else if (match === fundName) {
            addMessage("system", `Already on fund '${match}'`);
          } else if (onSwitchFund) {
            onSwitchFund(match);
          } else {
            addMessage("system", "Fund switching not available in this mode");
          }
        }
      } catch {
        addMessage("system", "Could not list funds");
      }
      return;
    }

    // Regular message
    addMessage("you", trimmed);
    await sendMessage(trimmed);
  }, [addMessage, costTracker, fundName, onExit, onSwitchFund, sendMessage]);

  // Reset scroll to bottom when new messages arrive or streaming updates
  useEffect(() => {
    setScrollOffset(0);
  }, [messages.length, streaming.buffer]);

  const isStreaming = phase === "streaming";

  // Calculate available height for messages area
  // Bottom section: context bar (3 lines) + cost (1 line if present) + input (1 line)
  const contextBarHeight = !isInline && welcomeData ? 4 : 0; // border + 2 lines + border
  const costBarHeight = !isInline && costTracker.messages > 0 ? 1 : 0;
  const inputHeight = 1;
  const bottomHeight = contextBarHeight + costBarHeight + inputHeight;
  const messagesAreaHeight = Math.max(3, height - bottomHeight);

  // Build visible messages with scroll support
  const visibleMessages = useMemo(() => {
    const msgLines = messages.map((msg) => ({
      msg,
      lines: estimateMessageLines(msg, width),
    }));

    let streamingLines = 0;
    if (isStreaming) {
      if (streaming.buffer) {
        streamingLines = 2 + streaming.buffer.split("\n").length;
      } else {
        streamingLines = 1;
      }
    }

    const availableLines = messagesAreaHeight - streamingLines;
    let usedLines = 0;
    let startIdx = messages.length;

    // Apply scroll offset (skip messages from the bottom)
    let skippedLines = 0;
    let skipEndIdx = messages.length;
    if (scrollOffset > 0) {
      for (let i = msgLines.length - 1; i >= 0 && skippedLines < scrollOffset; i--) {
        skippedLines += msgLines[i].lines;
        skipEndIdx = i;
      }
    }

    for (let i = skipEndIdx - 1; i >= 0; i--) {
      const needed = msgLines[i].lines;
      if (usedLines + needed > availableLines) break;
      usedLines += needed;
      startIdx = i;
    }

    return messages.slice(startIdx, skipEndIdx);
  }, [messages, width, messagesAreaHeight, isStreaming, streaming.buffer, scrollOffset]);

  const isScrolledUp = scrollOffset > 0;

  // Keyboard: Esc to go back (standalone only), arrows + PageUp/Down to scroll
  useInput((input, key) => {
    if (!isInline && key.escape && phase !== "streaming") {
      onExit?.();
    }
    if (input === "c" && key.ctrl && streaming.isStreaming) {
      streaming.cancel();
      setPhase("ready");
    }
    // Arrow keys: scroll 1 line at a time
    if (key.upArrow) {
      setScrollOffset((prev) => prev + 1);
    }
    if (key.downArrow) {
      setScrollOffset((prev) => Math.max(0, prev - 1));
    }
    // PageUp/Down: scroll by ~1/3 screen
    const scrollStep = Math.max(3, Math.floor(height / 3));
    if (key.pageUp) {
      setScrollOffset((prev) => prev + scrollStep);
    }
    if (key.pageDown) {
      setScrollOffset((prev) => Math.max(0, prev - scrollStep));
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

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Messages area — fills available space */}
      <Box flexDirection="column" flexGrow={1} overflowY="hidden">
        {!isInline && messages.length === 0 && !isStreaming && (
          <Box marginY={1} paddingX={1}>
            <Text dimColor>
              Chat with {welcomeData?.fundConfig.fund.display_name ?? fundName}. Type a message or /help for commands.
            </Text>
          </Box>
        )}
        {visibleMessages.map((msg) => (
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
        {isStreaming && !isScrolledUp && (
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
        {isScrolledUp && (
          <Box paddingX={1}>
            <Text dimColor italic>↑ Scrolled up — PgDn to go back ↓</Text>
          </Box>
        )}
      </Box>

      {/* === Bottom pinned section (standalone only) === */}

      {/* Context bar — always visible at bottom */}
      {!isInline && welcomeData && <FundContextBar welcome={welcomeData} />}

      {/* Cost summary */}
      {!isInline && costTracker.messages > 0 && (
        <Box paddingX={1}>
          <Text dimColor>
            ${costTracker.total_cost_usd.toFixed(4)} | {costTracker.messages} msgs | {costTracker.total_turns} turns
          </Text>
        </Box>
      )}

      {/* Input */}
      {!isStreaming && (
        isInline ? (
          <Box borderStyle="round" borderDimColor paddingX={1}>
            <Text color="green">{"> "}</Text>
            <TextInput
              placeholder="Message... (/help for commands)"
              onSubmit={handleSubmit}
            />
          </Box>
        ) : (
          <Box paddingX={1}>
            <Text color="green">{"❯ "}</Text>
            <TextInput
              placeholder="Message... (/help for commands)"
              onSubmit={handleSubmit}
            />
          </Box>
        )
      )}
    </Box>
  );
}
