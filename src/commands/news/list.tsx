import React from "react";
import zod from "zod";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { listArticles } from "../../services/news-inspect.service.js";
import { Header } from "../../components/Header.js";

export const description = "List recent RSS articles with optional filters";

export const options = zod.object({
  hours: zod.number().default(24).describe("Look back N hours"),
  source: zod.string().optional().describe("Filter by source (Bloomberg, Reuters, CNBC, MarketWatch)"),
  category: zod.string().optional().describe("Filter by category (macro, market, sector, commodity)"),
  limit: zod.number().default(20).describe("Max articles to show"),
});

type Props = { options: zod.infer<typeof options> };

export default function NewsList({ options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(
    () => listArticles({ hours: opts.hours, source: opts.source, category: opts.category, limit: opts.limit }),
    [opts.hours, opts.source ?? "", opts.category ?? "", opts.limit],
  );

  if (isLoading) return <Spinner label="Loading articles..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  if (data.status === "unavailable") {
    return <Text color="red">Cache unavailable: {data.reason}</Text>;
  }
  if (data.status === "empty") {
    return <Text dimColor>No articles in the last {opts.hours}h matching filters.</Text>;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header>Last {opts.hours}h — {data.articles.length} article{data.articles.length === 1 ? "" : "s"}</Header>
      {data.articles.map((a, i) => (
        <Box key={a.id ?? i} flexDirection="column" marginBottom={1}>
          <Box>
            <Text dimColor>{a.published_at.slice(0, 16).replace("T", " ")}  </Text>
            <Text color="cyan">[{a.source}]</Text>
            <Text dimColor> ({a.category})</Text>
            {a.symbols.length > 0 && <Text color="yellow">  {a.symbols.join(", ")}</Text>}
          </Box>
          <Text>{a.title}</Text>
          {a.snippet && <Text dimColor>  {a.snippet.slice(0, 140)}</Text>}
        </Box>
      ))}
    </Box>
  );
}
