import React from "react";
import { Box, Text } from "ink";
import { z } from "zod";
import {
  openWatchlistDb,
  queryWatchlist,
} from "../../services/watchlist.service.js";
import { watchlistStatusSchema, screenNameSchema } from "../../types.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";

export const description =
  "Show current watchlist (optionally filtered by fund or status).";
export const options = z.object({
  fund: z.string().optional(),
  status: z.array(watchlistStatusSchema).optional(),
  screen: screenNameSchema.optional(),
  limit: z.number().int().positive().max(200).default(50),
});
type Props = { options: z.infer<typeof options> };

export default function Watchlist({ options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const db = openWatchlistDb();
    try {
      return queryWatchlist(db, opts);
    } finally {
      db.close();
    }
  });
  if (isLoading) return <Text>Loading watchlist…</Text>;
  if (error) return <ErrorMessage>{error.message}</ErrorMessage>;
  if (!data || data.length === 0) return <Text>No entries.</Text>;

  return (
    <Box flexDirection="column">
      <Text bold>
        {"TICKER".padEnd(8)} {"STATUS".padEnd(12)} {"SCREENS".padEnd(20)}{" "}
        {"PEAK".padEnd(10)} LAST EVAL
      </Text>
      {data.map((e) => (
        <Text key={e.ticker}>
          {e.ticker.padEnd(8)} {e.status.padEnd(12)}{" "}
          {e.current_screens.join(",").padEnd(20)}{" "}
          {(e.peak_score != null
            ? (e.peak_score * 100).toFixed(1) + "%"
            : "—"
          ).padEnd(10)}{" "}
          {new Date(e.last_evaluated_at).toISOString().slice(0, 10)}
        </Text>
      ))}
    </Box>
  );
}
