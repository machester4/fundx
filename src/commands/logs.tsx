import React from "react";
import zod from "zod";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getDaemonLogs, getFundSessionLogs, getAllSessionLogs } from "../services/logs.service.js";
import type { AllSessionLogsData } from "../services/logs.service.js";
import { Header } from "../components/Header.js";

export const description = "View daemon and session logs";

export const options = zod.object({
  fund: zod.string().optional().describe("Show logs for a specific fund"),
  lines: zod.number().default(20).describe("Number of daemon log lines to show"),
  daemon: zod.boolean().default(false).describe("Show only daemon logs"),
});

type Props = { options: zod.infer<typeof options> };

export default function Logs({ options: opts }: Props) {
  if (opts.fund && !opts.daemon) {
    return <FundLogs fundName={opts.fund} />;
  }
  return <DaemonAndSessions lines={opts.lines} showSessions={!opts.daemon} />;
}

function DaemonAndSessions({ lines, showSessions }: { lines: number; showSessions: boolean }) {
  const daemon = useAsyncAction(() => getDaemonLogs(lines));
  const sessions = useAsyncAction(getAllSessionLogs);

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Daemon Logs</Header>
      {daemon.isLoading ? (
        <Spinner label="Loading daemon logs..." />
      ) : daemon.error ? (
        <Text color="red">Error: {daemon.error.message}</Text>
      ) : daemon.data?.notFound ? (
        <Text dimColor>No daemon log found. Start the daemon with &apos;fundx start&apos;.</Text>
      ) : daemon.data?.empty ? (
        <Text dimColor>Daemon log is empty.</Text>
      ) : (
        <Box flexDirection="column">
          {daemon.data?.lines.map((line, i) => <Text key={i}>  {line}</Text>)}
        </Box>
      )}

      {showSessions && !sessions.isLoading && sessions.data && (
        <SessionsBlock data={sessions.data} />
      )}
    </Box>
  );
}

function FundLogs({ fundName }: { fundName: string }) {
  const { data, isLoading, error } = useAsyncAction(
    () => getFundSessionLogs(fundName),
    [fundName],
  );

  if (isLoading) return <Spinner label="Loading session log..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>Session Log: {fundName}</Header>
      {!data ? (
        <Text dimColor>No session has been run yet.</Text>
      ) : (
        <Box flexDirection="column">
          <Text>  Fund:     {data.fundDisplayName}</Text>
          <Text>  Session:  {data.sessionType}</Text>
          <Text>  Started:  {data.startedAt}</Text>
          {data.endedAt && <Text>  Ended:    {data.endedAt}</Text>}
          <Text>  Trades:   {data.tradesExecuted}</Text>
          {data.summary && <Text>  Summary:  {data.summary}</Text>}
        </Box>
      )}
    </Box>
  );
}

function SessionsBlock({ data }: { data: AllSessionLogsData[] }) {
  if (data.length === 0) {
    return <Text dimColor>No sessions have been run yet.</Text>;
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Header>Recent Sessions</Header>
      {data.map((s) => (
        <Box key={s.fundName} flexDirection="column">
          <Text bold>{s.fundDisplayName} ({s.fundName})</Text>
          <Text dimColor>  {s.sessionType} — {s.startedAt} ({s.duration}) — {s.tradesExecuted} trades</Text>
          {s.summary && <Text dimColor>  {s.summary.slice(0, 120)}</Text>}
        </Box>
      ))}
    </Box>
  );
}
