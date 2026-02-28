import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { getFundListData } from "../../services/fund.service.js";
import { StatusBadge } from "../../components/StatusBadge.js";

export const description = "List all funds";

export default function FundList() {
  const { data, isLoading, error } = useAsyncAction(getFundListData);

  if (isLoading) return <Spinner label="Loading funds..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data?.length) {
    return <Text dimColor>No funds yet. Run &apos;fundx fund create&apos;.</Text>;
  }

  return (
    <Box flexDirection="column">
      {data.map((fund) => (
        <Box key={fund.name} gap={1}>
          <StatusBadge status={fund.status} />
          <Text bold>{fund.name}</Text>
          <Text>—</Text>
          <Text>{fund.displayName}</Text>
        </Box>
      ))}
    </Box>
  );
}
