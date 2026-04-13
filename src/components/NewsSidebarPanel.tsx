import React from "react";
import { Box, Text } from "ink";
import { SidebarPanel } from "./SidebarPanel.js";

export interface NewsSidebarArticle {
  title: string;
  source: string;
  published_at: string;
}

export type NewsSidebarStatus = "ok" | "empty" | "locked" | "unavailable";

interface NewsSidebarPanelProps {
  articles: NewsSidebarArticle[];
  status: NewsSidebarStatus;
  reason?: string;
  newestAgeMinutes?: number;
  width: number;
}

function ageBadge(mins?: number): string | undefined {
  if (mins === undefined) return undefined;
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (60 * 24))}d`;
}

export function NewsSidebarPanel({ articles, status, reason, newestAgeMinutes, width }: NewsSidebarPanelProps) {
  const value = status === "ok" ? ageBadge(newestAgeMinutes) : undefined;

  if (status === "locked") {
    return (
      <SidebarPanel title="NEWS" color="yellow" value="locked" width={width}>
        <Text color="yellow">Locked by daemon</Text>
        <Text dimColor>Agent still has access</Text>
      </SidebarPanel>
    );
  }

  if (status === "unavailable") {
    return (
      <SidebarPanel title="NEWS" color="red" value="err" width={width}>
        <Text color="red">Unavailable</Text>
        {reason && <Text dimColor>{reason.slice(0, width - 4)}</Text>}
      </SidebarPanel>
    );
  }

  if (status === "empty" || articles.length === 0) {
    return (
      <SidebarPanel title="NEWS" color="magenta" width={width}>
        <Text dimColor>Cache empty</Text>
      </SidebarPanel>
    );
  }

  const innerWidth = width - 4; // account for border + padding

  return (
    <SidebarPanel title="NEWS" color="magenta" value={value} width={width}>
      {articles.map((a, i) => {
        const sourceTag = `[${a.source.slice(0, 10)}] `;
        const availableForTitle = Math.max(10, innerWidth - sourceTag.length - 2);
        const title = a.title.length > availableForTitle
          ? a.title.slice(0, availableForTitle - 1) + "…"
          : a.title;
        return (
          <Box key={`${a.published_at}-${i}`}>
            <Text dimColor>· </Text>
            <Text dimColor>{sourceTag}</Text>
            <Text>{title}</Text>
          </Box>
        );
      })}
    </SidebarPanel>
  );
}
