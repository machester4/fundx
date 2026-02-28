import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { addSpecialSession } from "../../services/special-sessions.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Add a special session trigger";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
  zod.string().describe(argument({ name: "trigger", description: 'Trigger description (e.g., "FOMC meeting days")' })),
  zod.string().describe(argument({ name: "time", description: 'Session time (e.g., "14:00")' })),
  zod.string().describe(argument({ name: "focus", description: "Session focus description" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function SpecialAdd({ args: [fund, trigger, time, focus] }: Props) {
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await addSpecialSession(fund, trigger, time, focus);
        setStatus("done");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
  }, []);

  if (status === "running") return <Spinner label="Adding special session..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return <SuccessMessage>Special session added for &apos;{fund}&apos;.</SuccessMessage>;
}
