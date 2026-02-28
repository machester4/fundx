import React from "react";
import { Box, Text } from "ink";

interface Column<T> {
  header: string;
  accessor: keyof T | ((row: T) => React.ReactNode);
  align?: "left" | "right";
  width?: number;
  color?: string;
}

interface TableProps<T> {
  data: T[];
  columns: Column<T>[];
  emptyMessage?: string;
}

function getCellValue<T>(row: T, col: Column<T>): React.ReactNode {
  if (typeof col.accessor === "function") return col.accessor(row);
  return String(row[col.accessor] ?? "");
}

function getCellString<T>(row: T, col: Column<T>): string {
  if (typeof col.accessor === "function") {
    const val = col.accessor(row);
    return typeof val === "string" ? val : String(val ?? "");
  }
  return String(row[col.accessor] ?? "");
}

export function Table<T>({ data, columns, emptyMessage }: TableProps<T>) {
  if (data.length === 0) {
    return <Text dimColor>{emptyMessage ?? "No data"}</Text>;
  }

  // Calculate column widths
  const colWidths = columns.map((col) => {
    if (col.width) return col.width;
    const headerLen = col.header.length;
    const maxDataLen = Math.max(
      ...data.map((row) => getCellString(row, col).length),
    );
    return Math.max(headerLen, maxDataLen) + 2;
  });

  return (
    <Box flexDirection="column">
      {/* Header row */}
      <Box>
        {columns.map((col, i) => (
          <Box key={col.header} width={colWidths[i]}>
            <Text bold dimColor>
              {col.align === "right"
                ? col.header.padStart(colWidths[i] - 2)
                : col.header.padEnd(colWidths[i] - 2)}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Separator */}
      <Text dimColor>
        {colWidths.map((w) => "─".repeat(w)).join("")}
      </Text>

      {/* Data rows */}
      {data.map((row, rowIdx) => (
        <Box key={rowIdx}>
          {columns.map((col, colIdx) => (
            <Box key={col.header} width={colWidths[colIdx]}>
              <Text color={col.color}>
                {col.align === "right"
                  ? getCellString(row, col).padStart(colWidths[colIdx] - 2)
                  : getCellValue(row, col)}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
