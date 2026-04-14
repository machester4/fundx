import React from "react";
import { Box, Text } from "ink";
import { z } from "zod";
import { openWatchlistDb } from "../../services/watchlist.service.js";
import { openPriceCache } from "../../services/price-cache.service.js";
import {
  getHistoricalDaily,
  getSp500Constituents,
} from "../../services/market.service.js";
import { runScreen } from "../../services/screening.service.js";
import { loadGlobalConfig } from "../../config.js";
import { loadAllFundConfigs } from "../../services/fund.service.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Run a screen across the configured universe.";
export const options = z.object({
  screen: z.string().default("momentum-12-1").describe("Screen name"),
  universe: z.string().default("sp500").describe("Universe label"),
});
type Props = { options: z.infer<typeof options> };

export default function ScreenRun({ options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const config = await loadGlobalConfig();
    const apiKey = config.market_data?.fmp_api_key ?? "";
    const wdb = openWatchlistDb();
    const pcdb = openPriceCache();
    const universe = await getSp500Constituents(apiKey);
    const fundConfigs = await loadAllFundConfigs();
    return runScreen({
      watchlistDb: wdb,
      priceCacheDb: pcdb,
      universe,
      universeLabel: opts.universe,
      fetchBars: (t) => getHistoricalDaily(t, 273, apiKey),
      fundConfigs,
      now: Date.now(),
      screenName: "momentum-12-1",
    });
  });

  if (isLoading) return <Text>Running screen {opts.screen}…</Text>;
  if (error) return <ErrorMessage>{error.message}</ErrorMessage>;
  if (!data) return null;

  return (
    <Box flexDirection="column">
      <SuccessMessage>
        Screen {data.screen_name} complete in {data.duration_ms}ms.
      </SuccessMessage>
      <Text>
        Universe: {data.universe} · Scored: {data.tickers_scored} · Passed:{" "}
        {data.tickers_passed}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Top 10 by score:</Text>
        {data.top_ten.map((t) => (
          <Text key={t.ticker}>
            {t.ticker.padEnd(6)} {(t.score * 100).toFixed(2)}%
          </Text>
        ))}
      </Box>
    </Box>
  );
}
