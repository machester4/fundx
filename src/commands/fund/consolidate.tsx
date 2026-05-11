import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { fundExists } from "../../services/fund.service.js";
import { runMetaReflection, readConsolidationState } from "../../services/meta-reflection.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";
import type { LastConsolidationState } from "../../types.js";

export const description =
  "Manually trigger a meta-reflection consolidation for a fund (also used for backfill).";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "name", description: "Fund name" })),
]);

type Props = { args: zod.infer<typeof args> };

export default function FundConsolidate({ args: [name] }: Props) {
  const { isLoading, error, data } = useAsyncAction(async () => {
    if (!fundExists(name)) {
      throw new Error(`Fund '${name}' does not exist.`);
    }
    await runMetaReflection(name);
    return await readConsolidationState(name);
  }, [name]);

  if (isLoading) return <Spinner label={`Running meta-reflection for ${name}…`} />;
  if (error) return <Text color="red">Error: {error.message}</Text>;

  const tracker = data as LastConsolidationState | null | undefined;

  if (!tracker) {
    // Shouldn't happen — runMetaReflection always writes the tracker — but fall back gracefully.
    return (
      <Box flexDirection="column">
        <SuccessMessage>
          Consolidation complete for &apos;{name}&apos;. See state/last_consolidation.json for status.
        </SuccessMessage>
      </Box>
    );
  }

  if (tracker.status === "error") {
    return (
      <Box flexDirection="column">
        <ErrorMessage>
          Consolidation failed for &apos;{name}&apos;: {tracker.error ?? "unknown error"}
        </ErrorMessage>
      </Box>
    );
  }

  if (tracker.status === "no_data") {
    return (
      <Box flexDirection="column">
        <SuccessMessage>
          Nothing new to consolidate since last run (cursor: {tracker.cursor_iso}).
        </SuccessMessage>
      </Box>
    );
  }

  if (tracker.status === "skipped_daily_cap") {
    return (
      <Box flexDirection="column">
        <SuccessMessage>
          Skipped: daily cap reached for &apos;{name}&apos;. Will retry next run.
        </SuccessMessage>
      </Box>
    );
  }

  // status === "success"
  return (
    <Box flexDirection="column">
      <SuccessMessage>
        Consolidation complete — {tracker.n_handoffs_processed} handoffs, {tracker.n_journal_entries} journal entries, {tracker.n_lessons_written} lessons written.
      </SuccessMessage>
    </Box>
  );
}
