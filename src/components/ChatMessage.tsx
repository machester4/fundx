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
        <Text color="blueBright" bold>YOU</Text>
        <Box borderLeft borderColor="blueBright" paddingLeft={1}>
          <Text color="white" bold>{content}</Text>
        </Box>
      </Box>
    );
  }

  // Claude response
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="magentaBright" bold>CLAUDE</Text>
      <Box borderLeft borderColor="magentaBright" paddingLeft={1} flexDirection="column">
        <MarkdownView content={content} />
      </Box>
    </Box>
  );
}
