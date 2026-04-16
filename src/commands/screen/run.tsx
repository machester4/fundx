import React from "react";
import { Box, Text } from "ink";
import { z } from "zod";
import { openWatchlistDb } from "../../services/watchlist.service.js";
import { openPriceCache } from "../../services/price-cache.service.js";
import { getHistoricalDaily } from "../../services/market.service.js";
import { resolveUniverse } from "../../services/universe.service.js";
import { runScreen } from "../../services/screening.service.js";
import { loadGlobalConfig } from "../../config.js";
import { loadAllFundConfigs } from "../../services/fund.service.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";
import { screenNameSchema } from "../../types.js";

export const description = "Run a screen for a fund using its configured universe.";
export const options = z.object({
  screen: screenNameSchema.default("momentum-12-1").describe("Screen name"),
  fund: z.string().optional().describe("Fund name (defaults to first active fund)"),
});
type Props = { options: z.infer<typeof options> };

export default function ScreenRun({ options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const config = await loadGlobalConfig();
    const apiKey = config.market_data?.fmp_api_key ?? "";
    const configs = await loadAllFundConfigs();
    const active = configs.filter((c) => c.fund.status === "active");
    if (active.length === 0) throw new Error("no active funds");
    const fundName = opts.fund ?? active[0].fund.name;
    const cfg = active.find((c) => c.fund.name === fundName);
    if (!cfg) throw new Error(`fund not found or not active: ${fundName}`);
    const resolution = await resolveUniverse(fundName, cfg.universe, apiKey);
    const universeLabel =
      resolution.source.kind === "preset"
        ? `${resolution.source.preset} (${resolution.resolved_from})`
        : `filters (${resolution.resolved_from})`;
    const wdb = openWatchlistDb();
    const pcdb = openPriceCache();
    try {
      return await runScreen({
        watchlistDb: wdb,
        priceCacheDb: pcdb,
        universe: resolution.final_tickers,
        universeLabel,
        fetchBars: (t) => getHistoricalDaily(t, 273, apiKey),
        fundConfigs: [cfg],
        resolutions: new Map([[fundName, resolution]]),
        now: Date.now(),
        screenName: opts.screen,
      });
    } finally {
      wdb.close();
      pcdb.close();
    }
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
