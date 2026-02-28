import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { runFundMonteCarlo } from "../../services/montecarlo.service.js";
import { Header } from "../../components/Header.js";
import type { MonteCarloResult } from "../../types.js";

export const description = "Run Monte Carlo simulation for a fund";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

export const options = zod.object({
  simulations: zod.number().default(10000).describe("Number of simulations"),
  horizon: zod.number().optional().describe("Projection horizon in months"),
  seed: zod.number().default(42).describe("Random seed"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function MonteCarloRun({ args: [fundName], options: opts }: Props) {
  const [isRunning, setIsRunning] = useState(true);
  const [result, setResult] = useState<MonteCarloResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await runFundMonteCarlo(fundName, {
          simulations: opts.simulations,
          horizonMonths: opts.horizon,
          seed: opts.seed,
        });
        setResult(r);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsRunning(false);
      }
    })();
  }, []);

  if (isRunning) return <Spinner label={`Running ${opts.simulations.toLocaleString()} simulations...`} />;
  if (error) return <Text color="red">Error: {error}</Text>;
  if (!result) return null;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Monte Carlo Simulation: {fundName}</Header>
      <Text>Simulations: {result.simulations.toLocaleString()}</Text>
      <Text>Horizon: {result.horizon_months} months</Text>
      <Text color={result.probability_of_ruin > 0.1 ? "red" : "green"}>
        Probability of Ruin: {(result.probability_of_ruin * 100).toFixed(1)}%
      </Text>
      <Box flexDirection="column">
        <Text bold>Percentiles:</Text>
        <Text>  p5:  ${result.percentiles.p5.toFixed(2)}</Text>
        <Text>  p10: ${result.percentiles.p10.toFixed(2)}</Text>
        <Text>  p25: ${result.percentiles.p25.toFixed(2)}</Text>
        <Text>  p50: ${result.percentiles.p50.toFixed(2)}</Text>
        <Text>  p75: ${result.percentiles.p75.toFixed(2)}</Text>
        <Text>  p90: ${result.percentiles.p90.toFixed(2)}</Text>
        <Text>  p95: ${result.percentiles.p95.toFixed(2)}</Text>
      </Box>
    </Box>
  );
}
