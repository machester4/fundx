import React from "react";
import zod from "zod";
import { argument, option } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { loadFundConfig, loadAllFundConfigs } from "../../services/fund.service.js";
import { loadGlobalConfig } from "../../config.js";
import { resolveUniverse } from "../../services/universe.service.js";
import type { UniverseResolution } from "../../types.js";

export const description = "Force re-resolution of a fund's universe (bypass cache)";

export const args = zod.tuple([
  zod.string().optional().describe(argument({ name: "name", description: "Fund name (omit with --all)" })),
]);

export const options = zod.object({
  all: zod.boolean().default(false).describe(option({ description: "Refresh all active funds", alias: "a" })),
});

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

interface RefreshResult {
  fundName: string;
  resolution: UniverseResolution;
}

export default function RefreshUniverse({ args: [name], options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const gcfg = await loadGlobalConfig();
    const apiKey = gcfg.market_data?.fmp_api_key ?? "";
    if (opts.all) {
      const configs = await loadAllFundConfigs();
      const active = configs.filter((c) => c.fund.status === "active");
      if (active.length === 0) throw new Error("No active funds found.");
      const results: RefreshResult[] = [];
      for (const cfg of active) {
        const resolution = await resolveUniverse(cfg.fund.name, cfg.universe, apiKey, { force: true });
        results.push({ fundName: cfg.fund.name, resolution });
      }
      return results;
    }
    if (!name) {
      throw new Error("Provide a fund name or use --all (-a).");
    }
    const cfg = await loadFundConfig(name);
    const resolution = await resolveUniverse(name, cfg.universe, apiKey, { force: true });
    return [{ fundName: name, resolution }];
  }, [name, opts.all]);

  if (isLoading) return <Spinner label="Refreshing universe..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      {data.map((r) => (
        <Text key={r.fundName} color="green">
          ✓ {r.fundName}: {r.resolution.count} tickers ({r.resolution.resolved_from})
        </Text>
      ))}
      {data.length > 1 && (
        <Text dimColor>{data.length} funds refreshed.</Text>
      )}
    </Box>
  );
}
