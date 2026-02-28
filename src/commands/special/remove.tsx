import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { removeSpecialSession } from "../../services/special-sessions.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Remove a special session trigger";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
  zod.string().describe(argument({ name: "index", description: "Session index (from 'special list')" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function SpecialRemove({ args: [fund, indexStr] }: Props) {
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await removeSpecialSession(fund, parseInt(indexStr, 10));
        setStatus("done");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
  }, []);

  if (status === "running") return <Spinner label="Removing special session..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return <SuccessMessage>Special session removed from &apos;{fund}&apos;.</SuccessMessage>;
}
