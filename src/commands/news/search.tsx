import React from "react";
import zod from "zod";
import { argument } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { searchArticles } from "../../services/news-inspect.service.js";
import { Header } from "../../components/Header.js";

export const description = "Semantic search over cached RSS articles (same path the agent uses)";

export const args = zod.tuple([
  zod.string().describe(argument({ name: "query", description: "Natural-language search query" })),
]);

export const options = zod.object({
  symbols: zod.string().optional().describe("Filter by tickers (comma-separated)"),
  hours: zod.number().default(72).describe("Look back N hours"),
  limit: zod.number().default(10).describe("Max results"),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function NewsSearch({ args: [query], options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(
    () => searchArticles({ query, symbols: opts.symbols, hours: opts.hours, limit: opts.limit }),
    [query, opts.symbols ?? "", opts.hours, opts.limit],
  );

  if (isLoading) return <Spinner label={`Searching "${query}"...`} />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  if (data.status === "unavailable") {
    return <Text color="red">Cache unavailable: {data.reason}</Text>;
  }
  if (data.status === "empty") {
    return <Text dimColor>No articles matched "{query}" in the last {opts.hours}h.</Text>;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header>Search: "{query}" — {data.articles.length} result{data.articles.length === 1 ? "" : "s"}</Header>
      {data.articles.map((a, i) => (
        <Box key={a.id ?? i} flexDirection="column" marginBottom={1}>
          <Box>
            <Text dimColor>{a.published_at.slice(0, 16).replace("T", " ")}  </Text>
            <Text color="cyan">[{a.source}]</Text>
            {a.score !== undefined && <Text color="green">  relevance {a.score.toFixed(3)}</Text>}
            {a.symbols.length > 0 && <Text color="yellow">  {a.symbols.join(", ")}</Text>}
          </Box>
          <Text>{a.title}</Text>
          {a.snippet && <Text dimColor>  {a.snippet.slice(0, 160)}</Text>}
          <Text dimColor>  {a.url}</Text>
        </Box>
      ))}
    </Box>
  );
}
