import React, { useState, useEffect } from "react";
import zod from "zod";
import { argument } from "pastel";
import { Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { runFundSession } from "../../services/session.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Manually trigger a session";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "fund", description: "Fund name" })),
  zod.string().describe(argument({ name: "type", description: "Session type (pre_market, mid_session, post_market)" })),
]);

export const options = zod.object({
  debate: zod.boolean().default(false).describe("Prioritize thorough analysis using debate skills"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function SessionRun({ args: [fund, type], options: opts }: Props) {
  const [status, setStatus] = useState<"running" | "done" | "error">("running");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await runFundSession(fund, type, { useDebateSkills: opts.debate });
        setStatus("done");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    })();
  }, []);

  if (status === "running") return <Spinner label={`Running ${type} session for '${fund}'...`} />;
  if (status === "error") return <Text color="red">Session failed: {error}</Text>;
  return <SuccessMessage>Session complete for &apos;{fund}&apos;.</SuccessMessage>;
}
