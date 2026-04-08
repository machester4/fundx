import React from "react";
import { Text } from "ink";
import { SidebarPanel } from "./SidebarPanel.js";

interface HandoffPanelProps {
  handoff: string | null;
  width: number;
}

function extractSection(content: string, header: string): string[] {
  // Match section headers that START with the given text (handles extra text like "(Orient → Reflect)")
  const regex = new RegExp(`## ${header}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |\\n---\\n|$)`, "i");
  const match = content.match(regex);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((l) => l.replace(/^[-*>] /, "").trim())
    .filter((l) => l.length > 0);
}

export function HandoffPanel({ handoff, width }: HandoffPanelProps) {
  if (!handoff) {
    return (
      <SidebarPanel title="HANDOFF" width={width}>
        <Text dimColor>No handoff yet</Text>
      </SidebarPanel>
    );
  }

  const firstLine = handoff.split("\n")[0] ?? "";
  const dateMatch = firstLine.match(/— (.+)$/);
  const sessionInfo = dateMatch ? dateMatch[1] : "";

  const contract = extractSection(handoff, "Session Contract");
  const whatIDid = extractSection(handoff, "What I Did");
  const concerns = extractSection(handoff, "Open Concerns");
  const nextShould = extractSection(handoff, "Next Session Should");
  const maxLen = width - 4;

  const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

  // If no structured sections found, show first meaningful lines as fallback
  const hasSections = contract.length > 0 || whatIDid.length > 0 || concerns.length > 0 || nextShould.length > 0;

  return (
    <SidebarPanel title="HANDOFF" width={width}>
      {sessionInfo && <Text dimColor>{truncate(sessionInfo, maxLen)}</Text>}
      {hasSections ? (
        <>
          {contract.slice(0, 2).map((line, i) => (
            <Text key={`c${i}`} dimColor>{truncate(line, maxLen)}</Text>
          ))}
          {whatIDid.slice(0, 2).map((line, i) => (
            <Text key={`d${i}`} dimColor>{truncate(line, maxLen)}</Text>
          ))}
          {concerns.map((line, i) => (
            <Text key={`w${i}`} color="yellow">{"▲ "}{truncate(line, maxLen - 2)}</Text>
          ))}
          {nextShould.slice(0, 2).map((line, i) => (
            <Text key={`n${i}`} dimColor>{"▸ "}{truncate(line, maxLen - 2)}</Text>
          ))}
        </>
      ) : (
        // Fallback: show first non-header lines
        handoff
          .split("\n")
          .filter((l) => l.trim().length > 0 && !l.startsWith("#"))
          .slice(0, 5)
          .map((line, i) => (
            <Text key={`f${i}`} dimColor>{truncate(line.trim(), maxLen)}</Text>
          ))
      )}
    </SidebarPanel>
  );
}
