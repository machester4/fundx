import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { TextInput, Select } from "@inkjs/ui";
import { workspaceExists, initWorkspace, getWorkspacePath } from "../services/init.service.js";
import { SuccessMessage } from "../components/SuccessMessage.js";
import { WizardStep } from "../components/WizardStep.js";

export const description = "Initialize FundX workspace";

type Step = "check" | "timezone" | "model" | "broker" | "apiKey" | "secretKey" | "botToken" | "chatId" | "done";

export default function Init() {
  const [step, setStep] = useState<Step>("check");
  const [data, setData] = useState({
    timezone: "UTC",
    defaultModel: "sonnet",
    brokerProvider: "alpaca",
    apiKey: "",
    secretKey: "",
    botToken: "",
    chatId: "",
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
      <WizardStep step={1} totalSteps={4} title="Default timezone">
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
      <WizardStep step={2} totalSteps={4} title="Default Claude model">
        <Select
          options={[
            { label: "Sonnet (balanced)", value: "sonnet" },
            { label: "Opus (most capable)", value: "opus" },
            { label: "Haiku (fastest, cheapest)", value: "haiku" },
          ]}
          onChange={(value) => {
            setData((d) => ({ ...d, defaultModel: value }));
            setStep("broker");
          }}
        />
      </WizardStep>
    );
  }

  if (step === "broker") {
    return (
      <WizardStep step={3} totalSteps={4} title="Default broker">
        <Select
          options={[
            { label: "Alpaca (stocks, ETFs)", value: "alpaca" },
            { label: "Interactive Brokers", value: "ibkr" },
            { label: "Binance (crypto)", value: "binance" },
            { label: "Manual (no auto-execution)", value: "manual" },
          ]}
          onChange={(value) => {
            setData((d) => ({ ...d, brokerProvider: value }));
            setStep(value !== "manual" ? "apiKey" : "botToken");
          }}
        />
      </WizardStep>
    );
  }

  if (step === "apiKey") {
    return (
      <WizardStep step={4} totalSteps={4} title={`${data.brokerProvider} API key`}>
        <TextInput
          placeholder="Enter API key..."
          onSubmit={(value) => {
            setData((d) => ({ ...d, apiKey: value }));
            setStep("secretKey");
          }}
        />
      </WizardStep>
    );
  }

  if (step === "secretKey") {
    return (
      <WizardStep step={4} totalSteps={4} title={`${data.brokerProvider} secret key`}>
        <TextInput
          placeholder="Enter secret key..."
          onSubmit={(value) => {
            setData((d) => ({ ...d, secretKey: value }));
            setStep("botToken");
          }}
        />
      </WizardStep>
    );
  }

  if (step === "botToken") {
    return (
      <WizardStep step={4} totalSteps={4} title="Telegram bot token (empty to skip)">
        <TextInput
          placeholder="Enter bot token or press Enter to skip..."
          onSubmit={(value) => {
            const updated = { ...data, botToken: value };
            setData(updated);
            if (value) {
              setStep("chatId");
            } else {
              doInit(updated, setStep, setError);
            }
          }}
        />
      </WizardStep>
    );
  }

  if (step === "chatId") {
    return (
      <WizardStep step={4} totalSteps={4} title="Your Telegram chat ID">
        <TextInput
          placeholder="Enter chat ID..."
          onSubmit={(value) => {
            const updated = { ...data, chatId: value };
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
  data: { timezone: string; defaultModel: string; brokerProvider: string; apiKey: string; secretKey: string; botToken: string; chatId: string },
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
        botToken: data.botToken || undefined,
        chatId: data.chatId || undefined,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setStep("done");
  })();
}
