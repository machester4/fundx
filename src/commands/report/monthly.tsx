import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { generateMonthlyReport } from "../../services/reports.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Generate monthly report";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function ReportMonthly({ args: [fundName] }: Props) {
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    generateMonthlyReport(fundName)
      .then((p) => { setPath(p); setStatus("done"); })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
  }, []);

  if (status === "running") return <Spinner label="Generating monthly report..." />;
  if (status === "error") return <Text color="red">Error: {error}</Text>;
  return <SuccessMessage>Monthly report saved: {path}</SuccessMessage>;
}
