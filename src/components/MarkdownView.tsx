import React, { useMemo } from "react";
import { Text } from "ink";

interface MarkdownViewProps {
  content: string;
}

/**
 * Simple markdown renderer for terminal output.
 * Renders bold, italic, code, and headers as styled Text nodes.
 * For full fidelity, marked-terminal can be used externally and the
 * pre-rendered string passed to <Text>.
 */
export function MarkdownView({ content }: MarkdownViewProps) {
  const lines = useMemo(() => content.split("\n"), [content]);

  return (
    <>
      {lines.map((line, i) => {
        if (line.startsWith("### ")) {
          return (
            <Text key={i} bold color="cyan">
              {line.slice(4)}
            </Text>
          );
        }
        if (line.startsWith("## ")) {
          return (
            <Text key={i} bold color="blue">
              {line.slice(3)}
            </Text>
          );
        }
        if (line.startsWith("# ")) {
          return (
            <Text key={i} bold>
              {line.slice(2)}
            </Text>
          );
        }
        if (line.startsWith("```")) {
          return (
            <Text key={i} dimColor>
              {line}
            </Text>
          );
        }
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <Text key={i}>
              {"  "}
              {line}
            </Text>
          );
        }
        return <Text key={i}>{line}</Text>;
      })}
    </>
  );
}
