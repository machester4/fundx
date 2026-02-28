import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { sendTelegramNotification } from "../../services/gateway.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Send a test message to verify Telegram configuration";

export default function GatewayTest() {
  const [status, setStatus] = useState<"sending" | "done" | "error">("sending");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sendTelegramNotification("Test message from FundX CLI. If you see this, Telegram is configured correctly!")
      .then(() => setStatus("done"))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  }, []);

  if (status === "sending") return <Spinner label="Sending test message..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return <SuccessMessage>Test message sent to Telegram.</SuccessMessage>;
}
