import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { importFundTemplate } from "../../services/templates.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Create a new fund from a template file";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "file", description: "Template file path" })),
]);

export const options = zod.object({
  name: zod.string().optional().describe("Fund name (overrides template name)"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function TemplateImport({ args: [file], options: opts }: Props) {
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [fundName, setFundName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const name = await importFundTemplate(file, opts.name);
        setFundName(name);
        setStatus("done");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
  }, []);

  if (status === "running") return <Spinner label="Importing template..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return <SuccessMessage>Fund &apos;{fundName}&apos; created from template.</SuccessMessage>;
}
