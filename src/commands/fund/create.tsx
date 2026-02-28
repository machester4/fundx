import React, { useState } from "react";
import { Box, Text } from "ink";
import { TextInput, Select } from "@inkjs/ui";
import { createFund, OBJECTIVE_CHOICES, RISK_CHOICES } from "../../services/fund.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";
import { WizardStep } from "../../components/WizardStep.js";
import type { FundConfig } from "../../types.js";

export const description = "Interactive fund creation wizard";

type Step = "name" | "displayName" | "description" | "objective" | "capital" | "risk" | "tickers" | "brokerMode" | "creating" | "done";

export default function FundCreate() {
  const [step, setStep] = useState<Step>("name");
  const [data, setData] = useState({
    name: "", displayName: "", description: "", objectiveType: "runway",
    capital: 0, riskProfile: "moderate", tickers: "", brokerMode: "paper" as "paper" | "live",
  });
  const [error, setError] = useState<string | null>(null);

  if (step === "done") {
    if (error) return <Text color="red">Error: {error}</Text>;
    return (
      <Box flexDirection="column" gap={1}>
        <SuccessMessage>Fund &apos;{data.name}&apos; created</SuccessMessage>
        <Text dimColor>Start trading: fundx start {data.name}</Text>
      </Box>
    );
  }

  if (step === "creating") {
    return <Text dimColor>Creating fund...</Text>;
  }

  if (step === "name") {
    return (
      <WizardStep step={1} totalSteps={7} title="Fund name (slug)">
        <TextInput placeholder="my-fund" onSubmit={(v) => { setData((d) => ({ ...d, name: v })); setStep("displayName"); }} />
      </WizardStep>
    );
  }

  if (step === "displayName") {
    return (
      <WizardStep step={2} totalSteps={7} title="Display name">
        <TextInput placeholder="My Fund" onSubmit={(v) => { setData((d) => ({ ...d, displayName: v })); setStep("description"); }} />
      </WizardStep>
    );
  }

  if (step === "description") {
    return (
      <WizardStep step={3} totalSteps={7} title="Description">
        <TextInput placeholder="Short description..." onSubmit={(v) => { setData((d) => ({ ...d, description: v })); setStep("objective"); }} />
      </WizardStep>
    );
  }

  if (step === "objective") {
    return (
      <WizardStep step={4} totalSteps={7} title="Goal type">
        <Select
          options={OBJECTIVE_CHOICES.map((c) => ({ label: c.name, value: c.value }))}
          onChange={(v) => { setData((d) => ({ ...d, objectiveType: v })); setStep("capital"); }}
        />
      </WizardStep>
    );
  }

  if (step === "capital") {
    return (
      <WizardStep step={5} totalSteps={7} title="Initial capital (USD)">
        <TextInput placeholder="10000" onSubmit={(v) => { setData((d) => ({ ...d, capital: parseInt(v, 10) || 0 })); setStep("risk"); }} />
      </WizardStep>
    );
  }

  if (step === "risk") {
    return (
      <WizardStep step={6} totalSteps={7} title="Risk tolerance">
        <Select
          options={RISK_CHOICES.map((c) => ({ label: c.name, value: c.value }))}
          onChange={(v) => { setData((d) => ({ ...d, riskProfile: v })); setStep("tickers"); }}
        />
      </WizardStep>
    );
  }

  if (step === "tickers") {
    return (
      <WizardStep step={7} totalSteps={7} title="Allowed tickers (comma separated, empty = any)">
        <TextInput placeholder="SPY,QQQ,..." onSubmit={(v) => { setData((d) => ({ ...d, tickers: v })); setStep("brokerMode"); }} />
      </WizardStep>
    );
  }

  if (step === "brokerMode") {
    return (
      <WizardStep step={7} totalSteps={7} title="Broker mode">
        <Select
          options={[
            { label: "Paper trading", value: "paper" },
            { label: "Live trading", value: "live" },
          ]}
          onChange={(v) => {
            const updated = { ...data, brokerMode: v as "paper" | "live" };
            setData(updated);
            setStep("creating");

            // Build a default objective based on type
            const objective: FundConfig["objective"] = updated.objectiveType === "runway"
              ? { type: "runway", monthly_burn: 2000, target_months: 18, min_reserve_months: 3 }
              : updated.objectiveType === "growth"
                ? { type: "growth", target_multiple: 2 }
                : updated.objectiveType === "accumulation"
                  ? { type: "accumulation", target_asset: "BTC", target_amount: 1 }
                  : updated.objectiveType === "income"
                    ? { type: "income", target_monthly_income: 500 }
                    : { type: "custom", description: "Custom objective" };

            createFund({
              name: updated.name,
              displayName: updated.displayName,
              description: updated.description,
              objectiveType: updated.objectiveType,
              initialCapital: updated.capital,
              objective,
              riskProfile: updated.riskProfile,
              tickers: updated.tickers,
              brokerMode: updated.brokerMode,
            })
              .then(() => setStep("done"))
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
                setStep("done");
              });
          }}
        />
      </WizardStep>
    );
  }

  return null;
}
