import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { loadFundConfig } from "../../services/fund.service.js";
import { loadGlobalConfig } from "../../config.js";
import { resolveUniverse } from "../../services/universe.service.js";

export const description = "Force re-resolution of a fund's universe (bypass cache)";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "name", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function RefreshUniverse({ args: [fundName] }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const cfg = await loadFundConfig(fundName);
    const gcfg = await loadGlobalConfig();
    const apiKey = gcfg.market_data?.fmp_api_key ?? "";
    return resolveUniverse(fundName, cfg.universe, apiKey, { force: true });
  }, [fundName]);

  if (isLoading) return <Spinner label="Refreshing universe..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="green">
        ✓ Refreshed universe for {fundName}: {data.count} tickers ({data.resolved_from})
      </Text>
    </Box>
  );
}
