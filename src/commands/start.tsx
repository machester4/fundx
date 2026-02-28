import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { startDaemon } from "../services/daemon.service.js";

export const description = "Start the daemon scheduler + Telegram gateway";

export default function Start() {
  const [status, setStatus] = useState<"starting" | "done" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    startDaemon()
      .then(() => setStatus("done"))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  }, []);

  if (status === "starting") return <Spinner label="Starting daemon..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return <Text color="green">Daemon started.</Text>;
}
