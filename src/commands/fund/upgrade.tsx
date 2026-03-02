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

export const args = zod.tuple([
  zod.string().optional().describe("Fund name (omit if using --all)"),
]);

export const options = zod.object({
  all: zod.boolean().default(false).describe(
    option({ description: "Upgrade all funds", alias: "a" }),
  ),
});

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

export default function FundUpgrade({ args: [name], options: opts }: Props) {
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

    if (!name) throw new Error("Provide a fund name or use --all.");
    return [await upgradeFund(name)];
  }, [name, opts.all]);

  if (isLoading) return <Spinner label="Upgrading..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return (
    <Box flexDirection="column" gap={1}>
      {data.map((r) => (
        <SuccessMessage key={r.fundName}>
          {r.fundName}: CLAUDE.md regenerated, {r.skillCount} skills written
        </SuccessMessage>
      ))}
      <Text dimColor>
        {data.length === 1
          ? `Fund '${data[0].fundName}' upgraded.`
          : `${data.length} funds upgraded.`}
      </Text>
    </Box>
  );
}
