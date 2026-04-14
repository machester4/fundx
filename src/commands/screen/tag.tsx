import React from "react";
import { Text } from "ink";
import { z } from "zod";
import {
  openWatchlistDb,
  tagManually,
} from "../../services/watchlist.service.js";
import { watchlistStatusSchema } from "../../types.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";

export const description = "Manually set a ticker's watchlist status.";
export const args = z.tuple([
  z.string().describe("ticker"),
  watchlistStatusSchema.describe("new status"),
]);
export const options = z.object({
  reason: z.string().default("user override"),
});
type Props = {
  args: z.infer<typeof args>;
  options: z.infer<typeof options>;
};

export default function Tag({ args, options: opts }: Props) {
  const [ticker, status] = args;
  const { data, isLoading, error } = useAsyncAction(async () => {
    const db = openWatchlistDb();
    tagManually(
      db,
      ticker.toUpperCase(),
      status,
      `manual:cli:${opts.reason}`,
      Date.now(),
    );
    return { ticker, status };
  });
  if (isLoading) return <Text>Tagging {ticker}…</Text>;
  if (error) return <ErrorMessage>{error.message}</ErrorMessage>;
  if (!data) return null;
  return <SuccessMessage>{data.ticker} → {data.status}</SuccessMessage>;
}
