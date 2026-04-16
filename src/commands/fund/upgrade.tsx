import React from "react";
import zod from "zod";
import { option } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { upgradeFund, listFundNames } from "../../services/fund.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";
import type { UpgradeResult } from "../../services/fund.service.js";

export const description = "Upgrade fund(s): regenerate CLAUDE.md and rewrite skills from latest code";

export const options = zod.object({
  name: zod.string().optional().describe(
    option({ description: "Fund name to upgrade", alias: "n" }),
  ),
  all: zod.boolean().default(false).describe(
    option({ description: "Upgrade all funds", alias: "a" }),
  ),
});

type Props = {
  options: zod.infer<typeof options>;
};

export default function FundUpgrade({ options: opts }: Props) {
  const name = opts.name;
  const { data, isLoading, error } = useAsyncAction(async () => {
    if (opts.all) {
      const names = await listFundNames();
      if (names.length === 0) throw new Error("No funds found.");
      const results: UpgradeResult[] = [];
      for (const n of names) {
        results.push(await upgradeFund(n));
      }
      return results;
    }

    if (!name) throw new Error("Provide a fund name or use --all (-a).");
    return [await upgradeFund(name)];
  }, [name, opts.all]);

  if (isLoading) return <Spinner label="Upgrading..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return (
    <Box flexDirection="column" gap={1}>
      {data.map((r) => (
        <Box key={r.fundName} flexDirection="column">
          <SuccessMessage>
            {r.fundName}: CLAUDE.md regenerated, {r.skillCount} skills written
            {r.universeMigrated ? " (universe migrated from legacy schema)" : ""}
          </SuccessMessage>
          {r.warnings.map((w, i) => (
            <Text key={i} color="yellow">  ⚠ {w}</Text>
          ))}
        </Box>
      ))}
      <Text dimColor>
        {data.length === 1
          ? `Fund '${data[0].fundName}' upgraded.`
          : `${data.length} funds upgraded.`}
      </Text>
    </Box>
  );
}
