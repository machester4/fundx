import React from "react";
import { Text } from "ink";
import type { SwsSnowflake } from "../types.js";

function scoreColor(score: number): string {
  if (score <= 2) return "red";
  if (score <= 4) return "yellow";
  return "green";
}

interface SnowflakeScoresProps {
  scores: SwsSnowflake;
}

export function SnowflakeScores({ scores }: SnowflakeScoresProps) {
  const entries: Array<[string, number]> = [
    ["V", scores.value],
    ["F", scores.future],
    ["H", scores.health],
    ["P", scores.past],
    ["D", scores.dividend],
  ];

  return (
    <>
      {entries.map(([label, value]) => (
        <Text key={label} color={scoreColor(value)}>
          {String(value).padEnd(3)}
        </Text>
      ))}
    </>
  );
}
