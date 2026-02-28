import React from "react";
import { Text } from "ink";

interface SparklineProps {
  values: number[];
  color?: string;
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function Sparkline({ values, color = "cyan" }: SparklineProps) {
  if (values.length === 0) {
    return <Text dimColor>—</Text>;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const spark = values
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[idx];
    })
    .join("");

  return <Text color={color}>{spark}</Text>;
}
