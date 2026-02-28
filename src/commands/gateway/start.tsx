import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { startGateway } from "../../services/gateway.service.js";

export const description = "Start the Telegram gateway bot (standalone)";

export default function GatewayStart() {
  const [status, setStatus] = useState<"starting" | "done" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await startGateway();
        setStatus("done");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
  }, []);

  if (status === "starting") return <Spinner label="Starting Telegram gateway..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return <Text color="green">Telegram gateway started. Press Ctrl+C to stop.</Text>;
}
