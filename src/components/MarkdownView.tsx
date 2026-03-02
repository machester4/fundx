import React, { useMemo } from "react";
import { Box, Text } from "ink";

interface MarkdownViewProps {
  content: string;
}

/**
 * Parse inline markdown (bold, code, italic, strikethrough) into React elements.
 */
function parseInlineMarkdown(line: string, keyPrefix: string): React.ReactNode {
  const segments: React.ReactNode[] = [];
  // Order matters: bold (**) before italic (*), strikethrough (~~)
  const regex = /(\*\*(.+?)\*\*|`([^`]+)`|\*([^*]+)\*|~~(.+?)~~)/g;
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
        <Text key={`${keyPrefix}-${segIdx++}`} dimColor italic>
          {match[4]}
        </Text>,
      );
    } else if (match[5]) {
      // ~~strikethrough~~
      segments.push(
        <Text key={`${keyPrefix}-${segIdx++}`} strikethrough dimColor>
          {match[5]}
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

/** Strip inline markdown markers to get the visual text length */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~(.+?)~~/g, "$1");
}

/** Check if a line is a table separator (e.g. |---|---|) */
function isTableSeparator(line: string): boolean {
  return /^\|?[\s-:|]+\|[\s-:|]+\|?$/.test(line.trim());
}

/** Check if a line looks like a table row (with or without leading/trailing pipes) */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  // Standard: starts or ends with |
  if (trimmed.startsWith("|") || trimmed.endsWith("|")) return true;
  // Relaxed: has 2+ pipe-separated segments (e.g. "col1 | col2 | col3")
  const segments = trimmed.split("|").filter((s) => s.trim().length > 0);
  return segments.length >= 2;
}

/** Parse a table row into cells */
function parseTableCells(line: string): string[] {
  const trimmed = line.trim();
  // Remove leading/trailing pipes and split
  const stripped = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const withoutTrailing = stripped.endsWith("|") ? stripped.slice(0, -1) : stripped;
  return withoutTrailing.split("|").map((c) => c.trim());
}

/** Render a single table row with inline markdown in each cell */
function renderTableRow(
  cells: string[],
  colWidths: number[],
  keyPrefix: string,
  isHeader: boolean,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  for (let c = 0; c < colWidths.length; c++) {
    if (c > 0) {
      parts.push(<Text key={`${keyPrefix}-sep${c}`} dimColor>{"\u2502"}</Text>);
    }
    const cell = cells[c] ?? "";
    const visualLen = stripInlineMarkdown(cell).length;
    const padding = Math.max(0, colWidths[c] - visualLen);
    if (isHeader) {
      parts.push(
        <Text key={`${keyPrefix}-c${c}`} bold color="cyan">
          {" "}{parseInlineMarkdown(cell, `${keyPrefix}-c${c}`)}{" ".repeat(padding + 1)}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={`${keyPrefix}-c${c}`}>
          {" "}{parseInlineMarkdown(cell, `${keyPrefix}-c${c}`)}{" ".repeat(padding + 1)}
        </Text>,
      );
    }
  }
  return <Text key={keyPrefix}>{parts}</Text>;
}

/** Render a group of table lines */
function renderTable(lines: string[], startKey: number): React.ReactNode {
  // Find header, separator, and body rows
  const rows = lines.filter((l) => !isTableSeparator(l));
  if (rows.length === 0) return null;

  const parsedRows = rows.map((r) => parseTableCells(r));
  const colCount = Math.max(...parsedRows.map((r) => r.length));

  // Calculate column widths based on VISUAL text (stripping markdown markers)
  const colWidths: number[] = Array.from({ length: colCount }, () => 0);
  for (const row of parsedRows) {
    for (let c = 0; c < colCount; c++) {
      const visual = stripInlineMarkdown(row[c] ?? "");
      colWidths[c] = Math.max(colWidths[c], visual.length);
    }
  }

  const headerRow = parsedRows[0];
  const bodyRows = parsedRows.slice(1);
  const separator = colWidths.map((w) => "\u2500".repeat(w + 2)).join("\u253C");

  return (
    <Box key={`tbl-${startKey}`} flexDirection="column" marginY={0}>
      {renderTableRow(headerRow, colWidths, `tbl-${startKey}-h`, true)}
      <Text dimColor>{separator}</Text>
      {bodyRows.map((row, r) =>
        renderTableRow(row, colWidths, `tbl-${startKey}-r${r}`, false),
      )}
    </Box>
  );
}

/** Check if a line is a horizontal rule */
function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  return /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed);
}

/** Get a reasonable terminal width for rendering */
function getTerminalWidth(): number {
  try {
    return process.stdout.columns ?? 60;
  } catch {
    return 60;
  }
}

/**
 * Terminal markdown renderer for Ink.
 *
 * Supports: headers, bold, italic, inline code, code blocks, tables,
 * horizontal rules, blockquotes, numbered lists, bullet lists, checkboxes.
 */
export function MarkdownView({ content }: MarkdownViewProps) {
  const rendered = useMemo(() => {
    const lines = content.split("\n");
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeBlockLang = "";
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Code block toggle
      if (line.trimStart().startsWith("```")) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockLang = line.trimStart().slice(3).trim();
          // Render a dim label for the code block
          if (codeBlockLang) {
            elements.push(
              <Text key={i} dimColor>
                {"  \u250C "}{codeBlockLang}
              </Text>,
            );
          }
          i++;
          continue;
        } else {
          inCodeBlock = false;
          codeBlockLang = "";
          i++;
          continue;
        }
      }

      // Inside code block
      if (inCodeBlock) {
        elements.push(
          <Text key={i} color="yellow">
            {"  \u2502 "}{line}
          </Text>,
        );
        i++;
        continue;
      }

      // Horizontal rule
      if (isHorizontalRule(line)) {
        const ruleWidth = Math.min(getTerminalWidth(), 60);
        elements.push(
          <Text key={i} dimColor>
            {"\u2500".repeat(ruleWidth)}
          </Text>,
        );
        i++;
        continue;
      }

      // Table detection: collect consecutive table rows
      if (isTableRow(line)) {
        const tableLines: string[] = [];
        while (i < lines.length && (isTableRow(lines[i]) || isTableSeparator(lines[i]))) {
          tableLines.push(lines[i]);
          i++;
        }
        elements.push(renderTable(tableLines, i));
        continue;
      }

      // Headers
      if (line.startsWith("#### ")) {
        elements.push(
          <Text key={i} bold dimColor>
            {line.slice(5)}
          </Text>,
        );
        i++;
        continue;
      }
      if (line.startsWith("### ")) {
        elements.push(
          <Text key={i} bold color="cyan">
            {line.slice(4)}
          </Text>,
        );
        i++;
        continue;
      }
      if (line.startsWith("## ")) {
        elements.push(
          <Text key={i} bold color="blue">
            {line.slice(3)}
          </Text>,
        );
        i++;
        continue;
      }
      if (line.startsWith("# ")) {
        elements.push(
          <Text key={i} bold underline>
            {line.slice(2)}
          </Text>,
        );
        i++;
        continue;
      }

      // Blockquote
      if (line.startsWith("> ")) {
        elements.push(
          <Text key={i}>
            <Text dimColor>{"  \u2502 "}</Text>
            <Text italic>{parseInlineMarkdown(line.slice(2), `l${i}`)}</Text>
          </Text>,
        );
        i++;
        continue;
      }

      // Checkbox list items
      if (/^\s*[-*]\s+\[[ x]\]\s/.test(line)) {
        const isChecked = /\[x\]/i.test(line);
        const textStart = line.indexOf("]") + 2;
        const text = line.slice(textStart);
        elements.push(
          <Text key={i}>
            {"  "}{isChecked ? <Text color="green">{"\u2611"}</Text> : <Text dimColor>{"\u2610"}</Text>}{" "}{parseInlineMarkdown(text, `l${i}`)}
          </Text>,
        );
        i++;
        continue;
      }

      // Bullet list items
      if (/^\s*[-*]\s/.test(line)) {
        const indent = line.match(/^(\s*)/)?.[1] ?? "";
        const text = line.replace(/^\s*[-*]\s/, "");
        elements.push(
          <Text key={i}>
            {indent}{"  "}
            <Text color="cyan">{"\u2022"}</Text>
            {" "}{parseInlineMarkdown(text, `l${i}`)}
          </Text>,
        );
        i++;
        continue;
      }

      // Numbered list items
      if (/^\s*\d+[.)]\s/.test(line)) {
        const numMatch = line.match(/^(\s*)(\d+[.)])\s(.*)$/);
        if (numMatch) {
          elements.push(
            <Text key={i}>
              {numMatch[1]}{"  "}
              <Text color="cyan">{numMatch[2]}</Text>
              {" "}{parseInlineMarkdown(numMatch[3], `l${i}`)}
            </Text>,
          );
          i++;
          continue;
        }
      }

      // Regular paragraph line
      elements.push(<Text key={i}>{parseInlineMarkdown(line, `l${i}`)}</Text>);
      i++;
    }

    return elements;
  }, [content]);

  return <>{rendered}</>;
}
