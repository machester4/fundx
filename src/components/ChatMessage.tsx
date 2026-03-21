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

export function ChatMessage({ sender, content }: ChatMessageProps) {
  if (sender === "system") {
    return (
      <Box flexDirection="column" marginY={0}>
        <Text dimColor italic>
          {content}
        </Text>
      </Box>
    );
  }

  if (sender === "you") {
    return (
      <Box marginBottom={1}>
        <Text backgroundColor="#333333" color="white">{` ${content} `}</Text>
      </Box>
    );
  }

  // Claude response — just the text, no label
  return (
    <Box flexDirection="column" marginBottom={1}>
      <MarkdownView content={content} />
    </Box>
  );
}
