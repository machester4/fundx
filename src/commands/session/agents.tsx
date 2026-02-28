import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import {
  getDefaultSubAgents,
  runSubAgents,
  saveSubAgentAnalysis,
} from "../../subagent.js";

export const description = "Run only the sub-agent analysis (no trading)";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

export const options = zod.object({
  model: zod.string().optional().describe("Claude model (sonnet, opus, haiku, or full model ID)"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

interface AgentResult {
  name: string;
  status: "success" | "error" | "timeout";
  started_at: string;
  ended_at: string;
}

export default function SessionAgents({ args: [fund], options: opts }: Props) {
  const [isRunning, setIsRunning] = useState(true);
  const [results, setResults] = useState<AgentResult[]>([]);
  const [analysisPath, setAnalysisPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const agents = getDefaultSubAgents(fund);
        const res = await runSubAgents(fund, agents, { model: opts.model });
        const path = await saveSubAgentAnalysis(fund, res, "manual");
        setResults(res);
        setAnalysisPath(path);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsRunning(false);
      }
    })();
  }, []);

  if (isRunning) return <Spinner label={`Running sub-agent analysis for '${fund}'...`} />;
  if (error) return <Text color="red">Sub-agent analysis failed: {error}</Text>;

  const successCount = results.filter((r) => r.status === "success").length;
  const errorCount = results.filter((r) => r.status === "error").length;
  const timeoutCount = results.filter((r) => r.status === "timeout").length;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Text color="green">Sub-agent analysis complete.</Text>
      <Box flexDirection="column">
        {results.map((r) => {
          const color = r.status === "success" ? "green" : r.status === "timeout" ? "yellow" : "red";
          const label = r.status === "success" ? "OK" : r.status === "timeout" ? "TIMEOUT" : "ERR";
          const dur = ((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(0);
          return (
            <Text key={r.name} color={color}>  {label}  {r.name} ({dur}s)</Text>
          );
        })}
      </Box>
      <Text dimColor>{successCount} succeeded, {errorCount} errors, {timeoutCount} timeouts</Text>
      {analysisPath && <Text dimColor>Analysis saved: {analysisPath}</Text>}
    </Box>
  );
}
