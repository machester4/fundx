import React from "react";
import { Box, Text } from "ink";
import { ConfirmInput } from "@inkjs/ui";

interface ConfirmActionProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmAction({
  message,
  onConfirm,
  onCancel,
}: ConfirmActionProps) {
  return (
    <Box flexDirection="column">
      <Text>{message}</Text>
      <ConfirmInput onConfirm={onConfirm} onCancel={onCancel} />
    </Box>
  );
}
