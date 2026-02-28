import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { listTemplates } from "../../services/templates.service.js";
import { Header } from "../../components/Header.js";

export const description = "List available fund templates";

export default function TemplateList() {
  const { data, isLoading, error } = useAsyncAction(listTemplates);

  if (isLoading) return <Spinner label="Loading templates..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data || data.length === 0) {
    return <Text dimColor>No templates available.</Text>;
  }

  const builtIn = data.filter((t) => t.source === "builtin");
  const custom = data.filter((t) => t.source === "user");

  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      {builtIn.length > 0 && (
        <>
          <Header>Built-in Templates</Header>
          {builtIn.map((t) => (
            <Text key={t.name}>  {t.name.padEnd(15)} {t.description}</Text>
          ))}
        </>
      )}

      {custom.length > 0 && (
        <>
          <Header>Custom Templates</Header>
          {custom.map((t) => (
            <Text key={t.name}>  {t.name.padEnd(15)} {t.description}</Text>
          ))}
        </>
      )}

      {custom.length === 0 && (
        <Text dimColor>No custom templates. Export one with: fundx template export &lt;fund&gt;</Text>
      )}
    </Box>
  );
}
