import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { swsTokenStatus } from "../../services/sws.service.js";

export const description = "Show Simply Wall St token status";

export default function SwsStatus() {
  const { data, isLoading, error } = useAsyncAction(() => swsTokenStatus(), []);

  if (isLoading) return <Spinner label="Checking SWS token..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  if (!data.expiresAt) {
    return <Text color="yellow">SWS not configured. Run `fundx sws login` to authenticate.</Text>;
  }

  const hoursLeft = data.expiresInHours ?? 0;
  const statusColor = data.valid ? (hoursLeft < 24 ? "yellow" : "green") : "red";
  const statusText = data.valid ? "Valid" : "Expired";

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text>Status:</Text>
        <Text color={statusColor} bold>{statusText}</Text>
      </Box>
      <Text>Expires: {new Date(data.expiresAt).toLocaleString()}</Text>
      {data.valid && <Text>Time remaining: {Math.round(hoursLeft)}h</Text>}
      {!data.valid && <Text color="red">Run `fundx sws login` to renew.</Text>}
    </Box>
  );
}
