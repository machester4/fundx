import React, { useState } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Text } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import { createFromBuiltinTemplate } from "../../services/templates.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";
import { WizardStep } from "../../components/WizardStep.js";

export const description = "Create a new fund from a built-in template";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "template", description: "Template name (runway, growth, accumulation, income)" })),
]);

type Props = { args: zod.infer<typeof args> };

type Step = "fundName" | "displayName" | "capital" | "creating" | "done";

export default function TemplateBuiltin({ args: [templateName] }: Props) {
  const [step, setStep] = useState<Step>("fundName");
  const [data, setData] = useState({ fundName: "", displayName: "", capital: 10000 });
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (step === "done") {
    if (error) return <Text color="red">Error: {error}</Text>;
    return <SuccessMessage>Fund &apos;{result}&apos; created from &apos;{templateName}&apos; template.</SuccessMessage>;
  }

  if (step === "creating") return <Spinner label={`Creating fund from '${templateName}' template...`} />;

  if (step === "fundName") {
    return (
      <WizardStep step={1} totalSteps={3} title="Fund name (slug)">
        <TextInput placeholder="my-fund" onSubmit={(v) => { setData((d) => ({ ...d, fundName: v })); setStep("displayName"); }} />
      </WizardStep>
    );
  }

  if (step === "displayName") {
    return (
      <WizardStep step={2} totalSteps={3} title="Display name">
        <TextInput placeholder="My Fund" onSubmit={(v) => { setData((d) => ({ ...d, displayName: v })); setStep("capital"); }} />
      </WizardStep>
    );
  }

  if (step === "capital") {
    return (
      <WizardStep step={3} totalSteps={3} title="Initial capital (USD)">
        <TextInput placeholder="10000" onSubmit={(v) => {
          const capital = parseInt(v, 10) || 10000;
          const updated = { ...data, capital };
          setData(updated);
          setStep("creating");
          createFromBuiltinTemplate(templateName, updated.fundName, updated.displayName, capital)
            .then((name) => { setResult(name); setStep("done"); })
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : String(err));
              setStep("done");
            });
        }} />
      </WizardStep>
    );
  }

  return null;
}
