import React from "react";
import { Box, Text } from "ink";

interface BarChartItem {
  label: string;
  value: number;
  color?: string;
}

interface BarChartProps {
  data: BarChartItem[];
  title?: string;
  width?: number;
}

const BLOCK = "█";

export function BarChart({ data, title, width = 40 }: BarChartProps) {
  if (data.length === 0) {
    return <Text dimColor>No data</Text>;
  }

  const maxValue = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const maxLabelLen = Math.max(...data.map((d) => d.label.length));

  return (
    <Box flexDirection="column">
      {title && (
        <Box marginBottom={1}>
          <Text bold>{title}</Text>
        </Box>
      )}
      {data.map((item) => {
        const barLen = Math.round((Math.abs(item.value) / maxValue) * width);
        const bar = BLOCK.repeat(Math.max(barLen, 1));
        const color = item.color ?? (item.value >= 0 ? "green" : "red");
        const sign = item.value >= 0 ? "+" : "";
        const valueStr = `${sign}${item.value.toFixed(1)}%`;

        return (
          <Box key={item.label} gap={1}>
            <Text>{item.label.padEnd(maxLabelLen)}</Text>
            <Text color={color}>{bar}</Text>
            <Text dimColor>{valueStr}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
