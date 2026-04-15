import React from "react";
import zod from "zod";
import { argument, option } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { loadFundConfig } from "../../services/fund.service.js";
import { loadGlobalConfig } from "../../config.js";
import {
  resolveUniverse,
  readCachedUniverse,
} from "../../services/universe.service.js";

export const description =
  "Show a fund's resolved universe (source, count, freshness, sample tickers)";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "name", description: "Fund name" })),
]);

export const options = zod.object({
  limit: zod
    .number()
    .int()
    .positive()
    .default(20)
    .describe(option({ description: "Sample size to print" })),
});

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

export default function ShowUniverse({ args: [fundName], options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const cfg = await loadFundConfig(fundName);
    const gcfg = await loadGlobalConfig();
    const apiKey = gcfg.market_data?.fmp_api_key ?? "";
    // Prefer cache — no network call unless stale or missing
    const cached = await readCachedUniverse(fundName);
    const resolution = cached ?? (await resolveUniverse(fundName, cfg.universe, apiKey));
    return { resolution };
  }, [fundName]);

  if (isLoading) return <Spinner label="Loading universe..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  const { resolution } = data;
  const ageHours = Math.round((Date.now() - resolution.resolved_at) / 3600_000);
  const source =
    resolution.source.kind === "preset"
      ? `preset: ${resolution.source.preset}`
      : "filters";
  const sampleCount = Math.min(opts.limit, resolution.final_tickers.length);
  const sample = resolution.final_tickers.slice(0, sampleCount).join(", ");

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Universe for {fundName}</Text>
      <Text>Source: {source}</Text>
      <Text>
        Resolved from: {resolution.resolved_from} ({ageHours}h ago)
      </Text>
      <Text>Count: {resolution.count}</Text>
      {resolution.exclude_tickers_config.length > 0 && (
        <Text>
          Excluded tickers: {resolution.exclude_tickers_config.join(", ")}
        </Text>
      )}
      {resolution.exclude_sectors_config.length > 0 && (
        <Text>
          Excluded sectors: {resolution.exclude_sectors_config.join(", ")}
        </Text>
      )}
      {resolution.include_applied.length > 0 && (
        <Text>
          Always-included: {resolution.include_applied.join(", ")}
        </Text>
      )}
      <Text> </Text>
      <Text>
        First {sampleCount} tickers:
      </Text>
      <Text>{sample}</Text>
    </Box>
  );
}
