import React from "react";
import { Box, Text } from "ink";

interface WizardStepProps {
  step: number;
  totalSteps: number;
  title: string;
  children: React.ReactNode;
}

export function WizardStep({
  step,
  totalSteps,
  title,
  children,
}: WizardStepProps) {
  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        <Text dimColor>
          [{step}/{totalSteps}]
        </Text>{" "}
        <Text bold>{title}</Text>
      </Text>
      {children}
    </Box>
  );
}
