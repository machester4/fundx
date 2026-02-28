import React from "react";
import { Box, Text } from "ink";
import { MarkdownView } from "./MarkdownView.js";

interface ChatMessageProps {
  sender: "you" | "claude" | "system";
  content: string;
  timestamp: Date;
  cost?: number;
  turns?: number;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatMessage({ sender, content, timestamp, cost, turns }: ChatMessageProps) {
  if (sender === "system") {
    return (
      <Box flexDirection="column" marginY={0}>
        <Text dimColor italic>
          {content}
        </Text>
      </Box>
    );
  }

  const isUser = sender === "you";
  const nameColor = isUser ? "green" : "blue";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box gap={1}>
        <Text bold color={nameColor}>
          {sender}
        </Text>
        <Text dimColor>{formatTime(timestamp)}</Text>
        {!isUser && cost !== undefined && cost > 0 && (
          <Text dimColor>
            · ${cost.toFixed(4)}
            {turns !== undefined && turns > 0 ? ` · ${turns} turns` : ""}
          </Text>
        )}
      </Box>
      {isUser ? (
        <Text>{content}</Text>
      ) : (
        <MarkdownView content={content} />
      )}
    </Box>
  );
}
