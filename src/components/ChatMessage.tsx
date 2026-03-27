import React from "react";
import { Box, Text } from "ink";
import { MarkdownView } from "./MarkdownView.js";

interface ChatMessageProps {
  sender: "you" | "claude" | "system";
  content: string;
  timestamp?: Date;
  cost?: number;
  turns?: number;
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
      <Box marginBottom={1} flexDirection="column">
        <Text color="green" bold>{"❯ "}<Text color="white" bold>{content}</Text></Text>
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
