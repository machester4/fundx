import React, { useState, useEffect } from "react";
import zod from "zod";
import { Text, useApp } from "ink";
import { Spinner } from "@inkjs/ui";
import { resolveChatFund } from "../services/chat.service.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { ChatView } from "../components/ChatView.js";

export const description = "Interactive chat with a fund's AI agent";

export const options = zod.object({
  fund: zod.string().optional().describe("Fund to chat with"),
  model: zod.string().optional().describe("Claude model (sonnet, opus, haiku)"),
  readonly: zod.boolean().default(false).describe("Read-only mode (no trades)"),
  maxBudget: zod.string().optional().describe("Maximum budget in USD for the session"),
});

type Props = { options: zod.infer<typeof options> };

type Phase =
  | { type: "resolving" }
  | { type: "ready"; fundName: string | null }
  | { type: "error"; message: string };

export default function Chat({ options: opts }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>({ type: "resolving" });

  useEffect(() => {
    (async () => {
      try {
        if (opts.fund) {
          // Validate the specified fund exists
          const { fundName } = await resolveChatFund(opts.fund);
          setPhase({ type: "ready", fundName });
        } else {
          // No fund specified — open chat directly, fund can be selected from within
          setPhase({ type: "ready", fundName: null });
        }
      } catch (err: unknown) {
        setPhase({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, []);

  if (phase.type === "resolving") {
    return <Spinner label="Loading..." />;
  }

  if (phase.type === "error") {
    return <Text color="red">Error: {phase.message}</Text>;
  }

  return (
    <ChatView
      fundName={phase.fundName}
      width={columns}
      height={rows}
      onExit={() => exit()}
      onSwitchFund={(name) => setPhase({ type: "ready", fundName: name })}
      options={{
        model: opts.model,
        readonly: opts.readonly,
        maxBudget: opts.maxBudget,
      }}
    />
  );
}
