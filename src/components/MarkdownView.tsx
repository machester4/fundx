import React, { useMemo } from "react";
import { Text } from "ink";

interface MarkdownViewProps {
  content: string;
}

/**
 * Parse inline markdown (bold, code, italic) into React elements.
 */
function parseInlineMarkdown(line: string, keyPrefix: string): React.ReactNode {
  const segments: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`|\*([^*]+)\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let segIdx = 0;

  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push(line.slice(lastIndex, match.index));
    }

    if (match[2]) {
      // **bold**
      segments.push(
        <Text key={`${keyPrefix}-${segIdx++}`} bold>
          {match[2]}
        </Text>,
      );
    } else if (match[3]) {
      // `code`
      segments.push(
        <Text key={`${keyPrefix}-${segIdx++}`} color="yellow">
          {match[3]}
        </Text>,
      );
    } else if (match[4]) {
      // *italic*
      segments.push(
        <Text key={`${keyPrefix}-${segIdx++}`} dimColor>
          {match[4]}
        </Text>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    segments.push(line.slice(lastIndex));
  }

  if (segments.length === 0) return line;
  if (segments.length === 1 && typeof segments[0] === "string") return line;

  return <>{segments}</>;
}

/**
 * Simple markdown renderer for terminal output.
 * Renders bold, italic, code, and headers as styled Text nodes.
 */
export function MarkdownView({ content }: MarkdownViewProps) {
  const rendered = useMemo(() => {
    const lines = content.split("\n");
    let inCodeBlock = false;

    return lines.map((line, i) => {
      if (line.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        return (
          <Text key={i} dimColor>
            {line}
          </Text>
        );
      }
      if (inCodeBlock) {
        return (
          <Text key={i} color="yellow">
            {"  "}{line}
          </Text>
        );
      }
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
      if (line.startsWith("- ") || line.startsWith("* ")) {
        return (
          <Text key={i}>
            {"  "}{parseInlineMarkdown(line, `l${i}`)}
          </Text>
        );
      }
      return <Text key={i}>{parseInlineMarkdown(line, `l${i}`)}</Text>;
    });
  }, [content]);

  return <>{rendered}</>;
}
