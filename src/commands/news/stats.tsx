import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { getStats } from "../../services/news-inspect.service.js";
import { Header } from "../../components/Header.js";

export const description = "Show RSS news cache health and article counts";

function humanBytes(n?: number): string {
  if (n === undefined) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function humanAge(mins?: number): string {
  if (mins === undefined) return "—";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (60 * 24))}d ago`;
}

export default function NewsStats() {
  const { data, isLoading, error } = useAsyncAction(() => getStats(), []);

  if (isLoading) return <Spinner label="Probing news cache..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  const statusColor = data.status === "ok" ? "green" : "red";

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      <Header>News cache status</Header>
      <Box flexDirection="column">
        <Box>
          <Text>Cache status:   </Text>
          <Text color={statusColor} bold>{data.status.toUpperCase()}</Text>
          {data.reason && <Text dimColor> ({data.reason})</Text>}
        </Box>
        <Box><Text>Articles:       </Text><Text>{data.total}</Text></Box>
        <Box><Text>Newest:         </Text><Text>{humanAge(data.newest_age_minutes)}</Text><Text dimColor> ({data.newest_published_at ?? "—"})</Text></Box>
        <Box><Text>Oldest:         </Text><Text dimColor>{data.oldest_published_at ?? "—"}</Text></Box>
        <Box><Text>On-disk size:   </Text><Text>{humanBytes(data.dir_size_bytes)}</Text></Box>
      </Box>
      {data.status === "ok" && data.total === 0 && (
        <Text dimColor>Cache is empty. Run `fundx news fetch` to pull feeds, or start the daemon.</Text>
      )}
      {data.status === "unavailable" && data.reason && /lock|read-write/i.test(data.reason) && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>The zvec store allows only one process at a time.</Text>
          <Text dimColor>Stop the daemon (`fundx stop`) to query the cache from the CLI,</Text>
          <Text dimColor>or run this inside the daemon's own session to share the handle.</Text>
        </Box>
      )}
    </Box>
  );
}
