import React from "react";
import { Box, Text } from "ink";
import { z } from "zod";
import {
  openWatchlistDb,
  getTrajectory,
} from "../../services/watchlist.service.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";

export const description =
  "Show full score history and status transitions for one ticker.";
export const args = z.tuple([z.string().describe("ticker")]);
export const options = z.object({});
type Props = { args: z.infer<typeof args> };

export default function Trajectory({ args }: Props) {
  const [ticker] = args;
  const { data, isLoading, error } = useAsyncAction(async () => {
    const db = openWatchlistDb();
    try {
      return getTrajectory(db, ticker.toUpperCase());
    } finally {
      db.close();
    }
  });
  if (isLoading) return <Text>Loading {ticker}…</Text>;
  if (error) return <ErrorMessage>{error.message}</ErrorMessage>;
  if (!data) return null;
  const entry = data.entry;
  return (
    <Box flexDirection="column">
      <Text bold>
        {data.ticker} {entry ? `(${entry.status})` : "(not on watchlist)"}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Transitions:</Text>
        {data.transitions.length === 0 && <Text>  — none —</Text>}
        {data.transitions.map((t) => (
          <Text key={t.id}>
            {new Date(t.transitioned_at).toISOString().slice(0, 10)}{"  "}
            {(t.from_status ?? "ø") + " → " + t.to_status}{"  "}
            {t.reason}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Scores (most recent 20):</Text>
        {data.scores.slice(-20).map((s, i) => (
          <Text key={i}>
            {new Date(s.scored_at).toISOString().slice(0, 10)}{"  "}
            {(s.score * 100).toFixed(2) + "%"}{"  "}
            {s.passed ? "PASS" : "fail"}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
