import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { switchTradingMode } from "../../services/live-trading.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Switch a fund back to paper trading";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function LiveDisable({ args: [fundName] }: Props) {
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    switchTradingMode(fundName, "paper")
      .then(() => setStatus("done"))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  }, []);

  if (status === "running") return <Spinner label="Switching to paper mode..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return <SuccessMessage>Fund &apos;{fundName}&apos; switched to PAPER trading.</SuccessMessage>;
}
