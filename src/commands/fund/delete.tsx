import React, { useState } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text, useApp } from "ink";
import { ConfirmInput } from "@inkjs/ui";
import { deleteFund } from "../../services/fund.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Delete a fund";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "name", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function FundDelete({ args: [name] }: Props) {
  const { exit } = useApp();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    if (error) return <Text color="red">Error: {error}</Text>;
    return <SuccessMessage>Fund &apos;{name}&apos; deleted.</SuccessMessage>;
  }

  if (!confirmed) {
    return (
      <Box flexDirection="column">
        <Text>Delete fund &apos;{name}&apos;? This cannot be undone.</Text>
        <ConfirmInput
          onConfirm={() => {
            setConfirmed(true);
            deleteFund(name)
              .then(() => setDone(true))
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
                setDone(true);
              });
          }}
          onCancel={() => exit()}
        />
      </Box>
    );
  }

  return <Text dimColor>Deleting...</Text>;
}
