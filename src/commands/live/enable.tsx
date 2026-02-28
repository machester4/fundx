import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text, useApp } from "ink";
import { Spinner, ConfirmInput } from "@inkjs/ui";
import { runSafetyChecks, switchTradingMode } from "../../services/live-trading.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Switch a fund to live trading (with safety checks)";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function LiveEnable({ args: [fundName] }: Props) {
  const { exit } = useApp();
  const [phase, setPhase] = useState<"checking" | "results" | "confirm" | "switching" | "done" | "error">("checking");
  const [checks, setChecks] = useState<Array<{ name: string; passed: boolean; detail: string }>>([]);
  const [allPassed, setAllPassed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await runSafetyChecks(fundName);
        setChecks(result.checks);
        setAllPassed(result.passed);
        setPhase("results");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
  }, []);

  if (phase === "checking") return <Spinner label="Running safety checks..." />;
  if (phase === "error") return <Text color="red">Error: {error}</Text>;

  if (phase === "results" || phase === "confirm") {
    return (
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text bold>Safety Check Results</Text>
        {checks.map((c) => (
          <Text key={c.name} color={c.passed ? "green" : "red"}>
            {c.passed ? "  PASS" : "  FAIL"} {c.name}: {c.detail}
          </Text>
        ))}
        {!allPassed ? (
          <Text color="red">Safety checks failed. Fix issues before enabling live trading.</Text>
        ) : (
          <Box flexDirection="column">
            <Text color="yellow">Switch to LIVE trading?</Text>
            <ConfirmInput
              onConfirm={() => {
                setPhase("switching");
                (async () => {
                  try {
                    await switchTradingMode(fundName, "live");
                    setPhase("done");
                  } catch (err: unknown) {
                    setError(err instanceof Error ? err.message : String(err));
                    setPhase("error");
                  }
                })();
              }}
              onCancel={() => exit()}
            />
          </Box>
        )}
      </Box>
    );
  }

  if (phase === "switching") return <Spinner label="Switching to live mode..." />;
  return <SuccessMessage>Fund &apos;{fundName}&apos; switched to LIVE trading.</SuccessMessage>;
}
