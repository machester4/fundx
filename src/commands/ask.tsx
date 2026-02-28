import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { runAskQuery } from "../services/ask.service.js";
import { MarkdownView } from "../components/MarkdownView.js";

export const description = "Ask questions about your funds using Claude";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "question", description: "Your question" })),
]);

export const options = zod.object({
  fund: zod.string().optional().describe("Ask about a specific fund"),
  all: zod.boolean().default(false).describe("Cross-fund analysis (all funds)"),
  search: zod.boolean().default(false).describe("Search trade history for relevant context"),
  model: zod.string().optional().describe("Claude model (sonnet, opus, haiku, or full model ID)"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function Ask({ args: [question], options: opts }: Props) {
  const [isLoading, setIsLoading] = useState(true);
  const [result, setResult] = useState<{ output: string; costUsd: number; numTurns: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    runAskQuery(question, {
      fund: opts.fund,
      all: opts.all,
      search: opts.search,
      model: opts.model,
    })
      .then((res) => setResult(res))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setIsLoading(false));
  }, []);

  if (isLoading) return <Spinner label="Thinking..." />;
  if (error) return <Text color="red">Error: {error}</Text>;
  if (!result) return null;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <MarkdownView content={result.output} />
      <Text dimColor>Cost: ${result.costUsd.toFixed(4)} | Turns: {result.numTurns}</Text>
    </Box>
  );
}
