import React from "react";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { swsLogout } from "../../services/sws.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Remove Simply Wall St token";

export default function SwsLogout() {
  const { data, isLoading, error } = useAsyncAction(
    async () => { await swsLogout(); return true; },
    [],
  );

  if (isLoading) return <Spinner label="Removing SWS token..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return <SuccessMessage>SWS token removed from config.</SuccessMessage>;
}
