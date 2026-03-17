import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { swsLogin, swsTokenStatus } from "../../services/sws.service.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Login to Simply Wall St (opens Chrome)";

export default function SwsLogin() {
  const { data, isLoading, error } = useAsyncAction(async () => {
    await swsLogin();
    return swsTokenStatus();
  }, []);

  if (isLoading) {
    return (
      <Box flexDirection="column" gap={1}>
        <Spinner label="Opening Chrome — log in to Simply Wall St..." />
        <Text dimColor>The browser will close automatically after login.</Text>
        <Text dimColor>Timeout: 5 minutes.</Text>
      </Box>
    );
  }

  if (error) return <ErrorMessage>{error.message}</ErrorMessage>;
  if (!data) return null;

  const expiresDate = data.expiresAt ? new Date(data.expiresAt) : null;
  const daysLeft = expiresDate
    ? Math.round((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <Box flexDirection="column" gap={1}>
      <SuccessMessage>SWS token captured and saved.</SuccessMessage>
      {expiresDate && daysLeft !== null && (
        <Text>Expires: {expiresDate.toLocaleDateString()} ({daysLeft} days)</Text>
      )}
    </Box>
  );
}
