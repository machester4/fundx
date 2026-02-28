import React from "react";
import { Box, Text } from "ink";
import { Select } from "@inkjs/ui";

interface FundSelectorProps {
  funds: string[];
  onSelect: (fundName: string) => void;
  label?: string;
}

export function FundSelector({
  funds,
  onSelect,
  label = "Select a fund:",
}: FundSelectorProps) {
  if (funds.length === 0) {
    return <Text dimColor>No funds available.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text>{label}</Text>
      <Select
        options={funds.map((f) => ({ label: f, value: f }))}
        onChange={onSelect}
      />
    </Box>
  );
}
