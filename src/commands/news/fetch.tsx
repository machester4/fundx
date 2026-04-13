import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { fetchNow } from "../../services/news-inspect.service.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Force a fetch of all configured RSS feeds now";

export default function NewsFetch() {
  const { data, isLoading, error } = useAsyncAction(() => fetchNow(), []);

  if (isLoading) return <Spinner label="Fetching all configured RSS feeds..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <SuccessMessage>Fetched {data.newCount} new article{data.newCount === 1 ? "" : "s"}.</SuccessMessage>
      {data.newCount > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {data.articles.slice(0, 5).map((a, i) => (
            <Box key={a.id ?? i}>
              <Text dimColor>[{a.source}] </Text>
              <Text>{a.title.slice(0, 100)}</Text>
            </Box>
          ))}
          {data.articles.length > 5 && <Text dimColor>… and {data.articles.length - 5} more</Text>}
        </Box>
      )}
    </Box>
  );
}
