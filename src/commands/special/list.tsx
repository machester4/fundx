import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { loadFundConfig } from "../../services/fund.service.js";

import { Header } from "../../components/Header.js";

export const description = "List special sessions for a fund";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function SpecialList({ args: [fundName] }: Props) {
  const { data, isLoading, error } = useAsyncAction(
    () => loadFundConfig(fundName),
    [fundName],
  );

  if (isLoading) return <Spinner label="Loading..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  const sessions = data.schedule.special_sessions ?? [];

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Special Sessions: {data.fund.display_name}</Header>
      {sessions.length === 0 ? (
        <Text dimColor>No special sessions configured.</Text>
      ) : (
        sessions.map((s, i) => (
          <Box key={i} gap={1}>
            <Text dimColor>[{i}]</Text>
            <Text bold>{s.trigger}</Text>
            <Text dimColor>at {s.time}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
