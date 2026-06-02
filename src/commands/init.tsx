import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { TextInput, Select } from "@inkjs/ui";
import { workspaceExists, initWorkspace, getWorkspacePath } from "../services/init.service.js";
import { SuccessMessage } from "../components/SuccessMessage.js";
import { WizardStep } from "../components/WizardStep.js";

export const description = "Initialize FundX workspace";

type Step = "check" | "timezone" | "model" | "done";

export default function Init() {
  const [step, setStep] = useState<Step>("check");
  const [data, setData] = useState({
    timezone: "UTC",
    defaultModel: "claude-opus-4-8",
    brokerProvider: "paper",
    apiKey: "",
    secretKey: "",
  });
  const [error, setError] = useState<string | null>(null);

  // Auto-advance from check to timezone on mount
  useEffect(() => {
    if (step === "check" && !workspaceExists()) {
      setStep("timezone");
    }
  }, []);

  if (step === "check") {
    if (workspaceExists()) {
      return <Text color="yellow">Workspace already exists at {getWorkspacePath()}</Text>;
    }
    return <Text bold>FundX — Workspace Setup</Text>;
  }

  if (step === "done") {
    if (error) return <Text color="red">Error: {error}</Text>;
    return (
      <Box flexDirection="column" gap={1}>
        <SuccessMessage>Workspace initialized at {getWorkspacePath()}</SuccessMessage>
        <Text dimColor>Next: Run &apos;fundx fund create&apos; to create your first fund.</Text>
      </Box>
    );
  }

  if (step === "timezone") {
    return (
      <WizardStep step={1} totalSteps={2} title="Default timezone">
        <TextInput
          placeholder="UTC"
          onSubmit={(value) => {
            setData((d) => ({ ...d, timezone: value || "UTC" }));
            setStep("model");
          }}
        />
      </WizardStep>
    );
  }

  if (step === "model") {
    return (
      <WizardStep step={2} totalSteps={2} title="Default Claude model">
        <Select
          options={[
            { label: "Sonnet (balanced)", value: "sonnet" },
            { label: "Opus (most capable)", value: "opus" },
            { label: "Haiku (fastest, cheapest)", value: "haiku" },
          ]}
          onChange={(value) => {
            const updated = { ...data, defaultModel: value };
            setData(updated);
            doInit(updated, setStep, setError);
          }}
        />
      </WizardStep>
    );
  }

  return null;
}

function doInit(
  data: { timezone: string; defaultModel: string; brokerProvider: string; apiKey: string; secretKey: string },
  setStep: (s: Step) => void,
  setError: (e: string | null) => void,
) {
  (async () => {
    try {
      await initWorkspace({
        timezone: data.timezone,
        defaultModel: data.defaultModel,
        brokerProvider: data.brokerProvider,
        apiKey: data.apiKey || undefined,
        secretKey: data.secretKey || undefined,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setStep("done");
  })();
}
