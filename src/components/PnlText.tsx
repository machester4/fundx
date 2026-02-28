import React from "react";
import { Text } from "ink";

interface PnlTextProps {
  value: number;
  percentage?: number;
  showSign?: boolean;
}

export function PnlText({ value, percentage, showSign = true }: PnlTextProps) {
  const color = value >= 0 ? "green" : "red";
  const sign = showSign && value >= 0 ? "+" : "";
  const dollarStr = `${sign}$${Math.abs(value).toFixed(2)}`;
  const pctStr = percentage !== undefined ? ` (${sign}${percentage.toFixed(1)}%)` : "";

  return (
    <Text color={color}>
      {dollarStr}
      {pctStr}
    </Text>
  );
}
