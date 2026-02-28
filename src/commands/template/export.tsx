import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { exportFundTemplate } from "../../services/templates.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Export fund config as a reusable template";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name to export" })),
  zod.string().optional().describe(argument({ name: "file", description: "Output file path (optional)" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function TemplateExport({ args: [fund, file] }: Props) {
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    exportFundTemplate(fund, file)
      .then((p) => { setPath(p); setStatus("done"); })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  }, []);

  if (status === "running") return <Spinner label="Exporting template..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return <SuccessMessage>Template exported to {path}</SuccessMessage>;
}
