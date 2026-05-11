import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { fundExists } from "../../services/fund.service.js";
import { runMetaReflection } from "../../services/meta-reflection.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description =
  "Manually trigger a meta-reflection consolidation for a fund (also used for backfill).";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "name", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function FundConsolidate({ args: [name] }: Props) {
  const { isLoading, error } = useAsyncAction(async () => {
    if (!fundExists(name)) {
      throw new Error(`Fund '${name}' does not exist.`);
    }
    await runMetaReflection(name);
  }, [name]);

  if (isLoading) return <Spinner label={`Running meta-reflection for ${name}…`} />;
  if (error) return <Text color="red">Error: {error.message}</Text>;

  return (
    <Box flexDirection="column">
      <SuccessMessage>
        Consolidation complete for &apos;{name}&apos;. See state/last_consolidation.json for status.
      </SuccessMessage>
    </Box>
  );
}
