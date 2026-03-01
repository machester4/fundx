import React, { useState, useEffect } from "react";
import zod from "zod";
import { Box, Text, useApp } from "ink";
import { Spinner, Select } from "@inkjs/ui";
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
  | { type: "selecting-fund"; funds: string[] }
  | { type: "ready"; fundName: string | null }
  | { type: "error"; message: string };

export default function Chat({ options: opts }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [phase, setPhase] = useState<Phase>({ type: "resolving" });

  useEffect(() => {
    (async () => {
      try {
        const { fundName, allFunds } = await resolveChatFund(opts.fund);
        if (fundName === null && allFunds.length > 1) {
          // Multiple funds — prompt user to select (or create new)
          setPhase({ type: "selecting-fund", funds: allFunds });
          return;
        }
        // fundName is null (no funds) or a resolved name
        setPhase({ type: "ready", fundName });
      } catch (err: unknown) {
        setPhase({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
  }, []);

  if (phase.type === "resolving") {
    return <Spinner label="Resolving fund..." />;
  }

  if (phase.type === "error") {
    return <Text color="red">Error: {phase.message}</Text>;
  }

  if (phase.type === "selecting-fund") {
    const options = [
      ...phase.funds.map((f) => ({ label: f, value: f })),
      { label: "+ Create new fund (describe your goal to Claude)", value: "__new__" },
    ];
    return (
      <Box flexDirection="column">
        <Text>Select a fund:</Text>
        <Select
          options={options}
          onChange={(value) => {
            setPhase({ type: "ready", fundName: value === "__new__" ? null : value });
          }}
        />
      </Box>
    );
  }

  return (
    <ChatView
      fundName={phase.fundName}
      width={columns}
      height={rows}
      onExit={() => exit()}
      options={{
        model: opts.model,
        readonly: opts.readonly,
        maxBudget: opts.maxBudget,
      }}
    />
  );
}
