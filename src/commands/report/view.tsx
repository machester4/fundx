import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { getReport } from "../../services/reports.service.js";
import { Header } from "../../components/Header.js";
import { MarkdownView } from "../../components/MarkdownView.js";

export const description = "View a report";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
]);

export const options = zod.object({
  date: zod.string().optional().describe("Report date (YYYY-MM-DD)"),
  weekly: zod.boolean().default(false).describe("View weekly report"),
  monthly: zod.boolean().default(false).describe("View monthly report"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function ReportView({ args: [fundName], options: opts }: Props) {
  const type = opts.monthly ? "monthly" : opts.weekly ? "weekly" : "daily";
  const { data, isLoading, error } = useAsyncAction(
    () => getReport(fundName, type, opts.date),
    [fundName, type, opts.date],
  );

  if (isLoading) return <Spinner label="Loading report..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  if ("notFound" in data) {
    return <Text dimColor>No {type} report found. Generate one with: fundx report {type} {fundName}</Text>;
  }

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>{type.charAt(0).toUpperCase() + type.slice(1)} Report: {fundName}</Header>
      <MarkdownView content={data.content} />
    </Box>
  );
}
