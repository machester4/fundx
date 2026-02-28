import React from "react";
import { Text } from "ink";

interface SuccessMessageProps {
  children: React.ReactNode;
}

export function SuccessMessage({ children }: SuccessMessageProps) {
  return (
    <Text color="green">
      {"✓ "}
      {children}
    </Text>
  );
}
