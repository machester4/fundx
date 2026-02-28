import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { getFundInfo } from "../../services/fund.service.js";

export const description = "Show fund details";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "name", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function FundInfo({ args: [name] }: Props) {
  const { data, isLoading, error } = useAsyncAction(() => getFundInfo(name), [name]);

  if (isLoading) return <Spinner label="Loading fund info..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  const c = data.config;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>{c.fund.display_name}</Text>
      <Text>{c.fund.description}</Text>
      <Text>Status: {c.fund.status}</Text>
      <Text>Capital: ${c.capital.initial} {c.capital.currency}</Text>
      <Text>Objective: {c.objective.type}</Text>
      <Text>Risk: {c.risk.profile}</Text>
      <Text>Broker: {c.broker.provider} ({c.broker.mode})</Text>
    </Box>
  );
}
