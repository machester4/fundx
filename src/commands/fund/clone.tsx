import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Text, Box } from "ink";
import { Spinner } from "@inkjs/ui";
import { cloneFund } from "../../services/templates.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Clone an existing fund's configuration";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "source", description: "Source fund name" })),
  zod.string().describe(argument({ name: "target", description: "New fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function FundClone({ args: [source, target] }: Props) {
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    cloneFund(source, target)
      .then(() => setStatus("done"))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  }, []);

  if (status === "running") return <Spinner label={`Cloning '${source}' to '${target}'...`} />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return (
    <Box flexDirection="column" gap={1}>
      <SuccessMessage>Fund &apos;{source}&apos; cloned to &apos;{target}&apos;.</SuccessMessage>
      <Text dimColor>Start trading: fundx start {target}</Text>
    </Box>
  );
}
