import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { stopDaemon } from "../services/daemon.service.js";

export const description = "Stop the daemon scheduler + Telegram gateway";

export default function Stop() {
  const [status, setStatus] = useState<"stopping" | "done" | "error">("stopping");
  const [result, setResult] = useState<{ stopped: boolean; pid?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    stopDaemon()
      .then((r) => {
        setResult(r);
        setStatus("done");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  }, []);

  if (status === "stopping") return <Spinner label="Stopping daemon..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  if (!result?.stopped) return <Text dimColor>Daemon is not running.</Text>;
  return <Text color="green">Daemon stopped (PID {result.pid}).</Text>;
}
