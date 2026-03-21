import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, Static } from "ink";
import { Spinner, TextInput } from "@inkjs/ui";
import { basename } from "node:path";
import {
  resolveChatModel,
  buildChatMcpServers,
  buildChatContext,
  buildCompactContext,
  loadChatWelcomeData,
  persistChatSession,
  loadActiveSessionId,
  completeFundSetup,
  extractImagePaths,
  loadImageAttachment,
} from "../services/chat.service.js";
import type { ImageAttachment } from "../services/chat.service.js";
import { listFundNames, upgradeFund } from "../services/fund.service.js";
import { clearActiveSession, readChatHistory, writeChatHistory, clearChatHistory } from "../state.js";
import { getPortfolioDisplay } from "../services/portfolio.service.js";
import { getTradesDisplay } from "../services/trades.service.js";
import { useStreaming } from "../hooks/useStreaming.js";
import { ChatMessage } from "./ChatMessage.js";
import { StreamingIndicator } from "./StreamingIndicator.js";
import { FundContextBar } from "./FundContextBar.js";
import { MarkdownView } from "./MarkdownView.js";
import { TurnSummary } from "./TurnSummary.js";
import type { ChatWelcomeData, CostTracker } from "../services/chat.service.js";

interface ChatViewProps {
  fundName: string | null;
  width: number;
  height: number;
  onExit?: () => void;
  onSwitchFund?: (fundName: string) => void;
  options: { model?: string; readonly: boolean; maxBudget?: string };
  mode?: "standalone" | "inline" | "static";
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
  const isStatic = mode === "static";
  const isWorkspaceMode = fundName === null;
  const [phase, setPhase] = useState<"loading" | "ready" | "streaming" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [welcomeData, setWelcomeData] = useState<ChatWelcomeData | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const nextIdRef = useRef(1);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [turnCount, setTurnCount] = useState(0);
  const [costTracker, setCostTracker] = useState<CostTracker>({ total_cost_usd: 0, total_turns: 0, messages: 0 });
  const [model, setModel] = useState("sonnet");
  const [mcpServers, setMcpServers] = useState<Record<string, { command: string; args: string[]; env: Record<string, string> }>>({});
  const streaming = useStreaming();
  // Track known fund names to detect when Claude creates a new fund in workspace mode
  const knownFundsRef = useRef<string[]>([]);
  const [workspaceFunds, setWorkspaceFunds] = useState<string[]>([]);

  const addMessage = useCallback((sender: ChatMsg["sender"], content: string, cost?: number, turns?: number) => {
    setMessages((prev) => [...prev, {
      id: nextIdRef.current++,
      sender,
      content,
      timestamp: new Date(),
      cost,
      turns,
    }]);
  }, []);

  // Initialize
  useEffect(() => {
    (async () => {
      try {
        const resolvedModel = await resolveChatModel(fundName, options.model);
        const servers = await buildChatMcpServers(fundName);
        setModel(resolvedModel);
        setMcpServers(servers);

        if (isWorkspaceMode) {
          // Workspace mode: no fund data to load
          const allFunds = await listFundNames();
          knownFundsRef.current = allFunds;
          setWorkspaceFunds(allFunds);
          setPhase("ready");
          return;
        }

        const welcome = await loadChatWelcomeData(fundName, resolvedModel, options.readonly);
        setWelcomeData(welcome);

        // Resume from a previous chat or daemon session if one exists
        const activeSessionId = await loadActiveSessionId(fundName);
        if (activeSessionId) {
          setSessionId(activeSessionId);
          setTurnCount(1); // Skip full context injection since history is in the resumed session

          // Restore persisted messages that belong to this session
          const history = await readChatHistory(fundName).catch(() => null);
          if (history && history.session_id === activeSessionId && history.messages.length > 0) {
            setMessages(
              history.messages.map((m) => ({
                ...m,
                timestamp: new Date(m.timestamp),
              })),
            );
            // Derive the next ID from the maximum stored ID to avoid duplicates
            const maxId = history.messages.reduce((max, m) => Math.max(max, m.id), 0);
            nextIdRef.current = maxId + 1;
          }
        }

        setPhase("ready");
      } catch (err: unknown) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
  }, [fundName]);

  const sendMessage = useCallback(async (message: string, images?: ImageAttachment[]) => {
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
        images,
      });

      setSessionId(result.sessionId);
      if (result.sessionId) {
        try {
          await persistChatSession(fundName, result.sessionId);
        } catch (err) {
          console.error("[ChatView] Failed to persist session:", err);
          addMessage("system", "Warning: could not save session state — conversation will not resume after restart.");
        }
      }
      setTurnCount((c) => c + 1);
      setCostTracker((t) => ({
        total_cost_usd: t.total_cost_usd + result.cost_usd,
        total_turns: t.total_turns + result.num_turns,
        messages: t.messages + 1,
      }));

      setMessages((prev) => [...prev, {
        id: nextIdRef.current++,
        sender: "claude",
        content: result.responseText,
        timestamp: new Date(),
        cost: result.cost_usd,
        turns: result.num_turns,
      }]);

      // In workspace mode, check if Claude created a new fund
      if (isWorkspaceMode) {
        try {
          const currentFunds = await listFundNames();
          const newFunds = currentFunds.filter((f) => !knownFundsRef.current.includes(f));
          for (const newFund of newFunds) {
            try {
              await completeFundSetup(newFund);
              addMessage("system", `Fund **${newFund}** created. Type \`/fund ${newFund}\` to switch to it.`);
            } catch (err) {
              console.error("[ChatView] completeFundSetup failed for", newFund, err);
              addMessage("system", `Fund directory detected for **${newFund}**, but setup failed: ${err instanceof Error ? err.message : String(err)}. Run \`fundx fund info ${newFund}\` to verify.`);
            }
          }
          knownFundsRef.current = currentFunds;
          setWorkspaceFunds(currentFunds);
        } catch (err) {
          console.error("[ChatView] Fund detection failed after response:", err);
          addMessage("system", "Warning: could not check for new funds after this response.");
        }
      }

      setPhase("ready");
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [turnCount, sessionId, model, mcpServers, options, streaming, fundName, addMessage, isWorkspaceMode]);

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // Slash commands
    if (trimmed === "/q" || trimmed === "exit" || trimmed === "quit") {
      onExit?.();
      return;
    }
    if (trimmed === "/help") {
      addMessage("system", "**Chat Commands**\n- `/help` — Show this help\n- `/cost` — Show session cost\n- `/clear` — Reset conversation\n- `/portfolio` — Show portfolio\n- `/trades` — Show recent trades\n- `/upgrade` — Regenerate CLAUDE.md & skills\n- `/fund` — List funds\n- `/fund <name>` — Switch to fund\n- `/q` — Exit");
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
      nextIdRef.current = 1;
      streaming.reset();
      if (fundName) {
        try {
          await clearActiveSession(fundName);
        } catch (err) {
          addMessage("system", `Warning: could not clear session state. (${err instanceof Error ? err.message : String(err)})`);
        }
        try {
          await clearChatHistory(fundName);
        } catch (err) {
          addMessage("system", `Warning: could not clear chat history. (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      return;
    }
    if (trimmed === "/portfolio") {
      if (!fundName) {
        addMessage("system", "No fund selected. Describe your investment goal to create one.");
        return;
      }
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
      if (!fundName) {
        addMessage("system", "No fund selected. Describe your investment goal to create one.");
        return;
      }
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

    // /upgrade — regenerate CLAUDE.md and skills for current fund
    if (trimmed === "/upgrade") {
      if (!fundName) {
        addMessage("system", "No fund selected. Switch to a fund first with `/fund <name>`.");
        return;
      }
      try {
        const result = await upgradeFund(fundName);
        addMessage("system", `**Upgraded ${result.fundName}** — CLAUDE.md regenerated, ${result.skillCount} skills written.`);
      } catch (err) {
        addMessage("system", `Upgrade failed: ${err instanceof Error ? err.message : String(err)}`);
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
          const lines = fundName ? [`**Funds** (current: ${fundName})`] : [`**Funds** (workspace mode — no fund selected)`];
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

    // Check for image file paths (drag-and-drop from macOS Finder)
    const { cleanText, imagePaths } = extractImagePaths(trimmed);
    let images: ImageAttachment[] | undefined;

    if (imagePaths.length > 0) {
      const loaded: ImageAttachment[] = [];
      for (const imgPath of imagePaths) {
        try {
          loaded.push(await loadImageAttachment(imgPath));
          addMessage("system", `Attached: ${basename(imgPath)}`);
        } catch (err) {
          addMessage("system", `Could not attach ${basename(imgPath)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (loaded.length > 0) images = loaded;
    }

    const messageText = cleanText || (images ? "Analyze this image." : trimmed);
    addMessage("you", messageText);
    await sendMessage(messageText, images);
  }, [addMessage, costTracker, fundName, onExit, onSwitchFund, sendMessage, streaming]);

  // Persist chat history to disk whenever messages or sessionId change.
  // Write errors are logged but not surfaced — persistence is best-effort and must not interrupt the UI.
  useEffect(() => {
    if (!fundName || !sessionId || messages.length === 0) return;
    const persistable = messages.filter(
      (m): m is ChatMsg & { sender: "you" | "claude" } =>
        m.sender === "you" || m.sender === "claude",
    );
    if (persistable.length === 0) return;
    writeChatHistory(fundName, {
      session_id: sessionId,
      messages: persistable.map((m) => ({
        id: m.id,
        sender: m.sender,
        content: m.content,
        timestamp: m.timestamp.toISOString(),
        cost: m.cost,
        turns: m.turns,
      })),
      updated_at: new Date().toISOString(),
    }).catch((err) => {
      console.error("[ChatView] Failed to write chat history:", err);
    });
  }, [messages, sessionId, fundName]);

  const isStreaming = phase === "streaming";


  useInput((input, key) => {
    if (!isInline && !isStatic && key.escape && phase !== "streaming") {
      onExit?.();
    }
    if (input === "c" && key.ctrl && streaming.isStreaming) {
      streaming.cancel();
      setPhase("ready");
    }
  });

  if (phase === "loading") {
    return <Spinner label={fundName ? `Loading ${fundName}...` : "Loading FundX..."} />;
  }

  if (isStatic) {
    return (
      <>
        {/* Completed messages — written permanently to terminal scrollback */}
        <Static items={messages}>
          {(msg) => (
            <Box key={msg.id} paddingX={1}>
              <ChatMessage
                sender={msg.sender}
                content={msg.content}
                timestamp={msg.timestamp}
                cost={msg.cost}
                turns={msg.turns}
              />
            </Box>
          )}
        </Static>

        {/* Dynamic bottom section — re-renders as streaming progresses */}
        <Box flexDirection="column">
          {isStreaming && (
            <Box paddingX={1} flexDirection="column" marginTop={1}>
              {streaming.buffer ? (
                <Box flexDirection="column">
                  <StreamingIndicator charCount={streaming.charCount} activity={streaming.activity} />
                  <MarkdownView content={streaming.buffer} />
                </Box>
              ) : (
                <StreamingIndicator charCount={0} activity={streaming.activity} />
              )}
            </Box>
          )}
          {!streaming.isStreaming && streaming.lastTurnMetrics && (
            <Box paddingX={1} marginTop={1}>
              <TurnSummary metrics={streaming.lastTurnMetrics} />
            </Box>
          )}

          {phase === "error" && (
            <Box paddingX={1} marginTop={1}>
              <Text color="red">Error: {errorMsg}</Text>
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{"\u2500".repeat(width)}</Text>
            {!isStreaming && phase !== "error" && (
              <Box paddingX={1}>
                <Text color="green">{"❯ "}</Text>
                <TextInput
                  placeholder="Message... (/help for commands)"
                  onSubmit={handleSubmit}
                />
              </Box>
            )}
            <Text dimColor>{"\u2500".repeat(width)}</Text>
          </Box>
        </Box>
      </>
    );
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
          <Box marginY={1} paddingX={1} flexDirection="column" gap={1}>
            {isWorkspaceMode ? (
              <Text dimColor>Type a message or /help for commands.</Text>
            ) : (
              <Text dimColor>
                Chat with {welcomeData?.fundConfig.fund.display_name ?? fundName}. Type a message or /help for commands.
              </Text>
            )}
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
                <StreamingIndicator charCount={streaming.charCount} activity={streaming.activity} />
                <MarkdownView content={streaming.buffer} />
              </Box>
            ) : (
              <StreamingIndicator charCount={0} activity={streaming.activity} />
            )}
          </Box>
        )}
        {!streaming.isStreaming && streaming.lastTurnMetrics && (
          <Box paddingX={1}>
            <TurnSummary metrics={streaming.lastTurnMetrics} />
          </Box>
        )}
      </Box>

      {/* Input */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>{"\u2500".repeat(width)}</Text>
        {!isStreaming && (
          <Box paddingX={1}>
            <Text color="green">{"❯ "}</Text>
            <TextInput
              placeholder="Message... (/help for commands)"
              onSubmit={handleSubmit}
            />
          </Box>
        )}
        <Text dimColor>{"\u2500".repeat(width)}</Text>
      </Box>

      {/* Context bar — below input */}
      {!isInline && (welcomeData || isWorkspaceMode) && (
        <FundContextBar welcome={welcomeData} model={model} workspaceFunds={workspaceFunds} />
      )}
    </Box>
  );
}
