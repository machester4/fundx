import React, { useState, useEffect } from "react";
import zod from "zod";
import { Box, Text } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import { option } from "pastel";
import {
  loadFundCredentials,
  saveFundCredentials,
  clearFundCredentials,
  hasFundCredentials,
} from "../../credentials.js";
import { loadFundConfig, saveFundConfig } from "../../services/fund.service.js";
import { syncPortfolio } from "../../sync.js";
import { ALPACA_PAPER_URL, ALPACA_LIVE_URL } from "../../alpaca-helpers.js";

export const description = "Manage broker credentials for a fund";

export const args = zod.tuple([zod.string().describe("Fund name")]);

export const options = zod.object({
  set: zod
    .boolean()
    .default(false)
    .describe(option({ description: "Set new credentials", alias: "s" })),
  clear: zod
    .boolean()
    .default(false)
    .describe(
      option({ description: "Clear credentials (revert to global)", alias: "c" }),
    ),
});

type Phase = "check" | "input-key" | "input-secret" | "validating" | "done";

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

export default function FundCredentials({
  args: [fundName],
  options: opts,
}: Props) {
  const [phase, setPhase] = useState<Phase>("check");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (phase !== "check") return;
    (async () => {
      if (opts.clear) {
        await clearFundCredentials(fundName);
        const config = await loadFundConfig(fundName);
        config.broker.sync_enabled = false;
        await saveFundConfig(config);
        setMessage(
          `Credentials cleared for '${fundName}'. Reverted to global fallback. Sync disabled.`,
        );
        setPhase("done");
        return;
      }
      if (opts.set) {
        setPhase("input-key");
        return;
      }
      // Default: show status
      const has = await hasFundCredentials(fundName);
      setMessage(
        has
          ? `Fund '${fundName}' has dedicated broker credentials.`
          : `Fund '${fundName}' uses global credentials. Run with --set to configure.`,
      );
      setPhase("done");
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === "done") {
    return error ? (
      <Text color="red">{error}</Text>
    ) : (
      <Text color="green">{message}</Text>
    );
  }

  if (phase === "input-key") {
    return (
      <Box flexDirection="column">
        <Text>Alpaca API Key:</Text>
        <TextInput
          placeholder="PKXXXXXXXX"
          onSubmit={(v) => {
            setApiKey(v);
            setPhase("input-secret");
          }}
        />
      </Box>
    );
  }

  if (phase === "input-secret") {
    return (
      <Box flexDirection="column">
        <Text>Alpaca Secret Key:</Text>
        <TextInput
          placeholder="XXXXXXXX"
          onSubmit={(secretKey) => {
            setPhase("validating");
            (async () => {
              try {
                // Validate credentials against Alpaca API
                const config = await loadFundConfig(fundName);
                const mode = config.broker.mode ?? "paper";
                const url =
                  mode === "live" ? ALPACA_LIVE_URL : ALPACA_PAPER_URL;
                const resp = await fetch(`${url}/v2/account`, {
                  headers: {
                    "APCA-API-KEY-ID": apiKey,
                    "APCA-API-SECRET-KEY": secretKey,
                  },
                });
                if (!resp.ok)
                  throw new Error(`Alpaca returned ${resp.status}`);

                await saveFundCredentials(fundName, apiKey, secretKey);

                // Enable sync and run initial sync
                config.broker.sync_enabled = true;
                await saveFundConfig(config);
                try {
                  await syncPortfolio(fundName);
                } catch {
                  // initial sync is best-effort
                }

                setMessage(`Credentials saved for '${fundName}'. Sync enabled.`);
              } catch (err) {
                setError(
                  `Invalid credentials: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              setPhase("done");
            })();
          }}
        />
      </Box>
    );
  }

  return <Spinner label="Validating credentials..." />;
}
