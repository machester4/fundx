import React from "react";
import { Box, Text } from "ink";
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
  const innerWidth = width - 2;

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

  const hasSections = contract.length > 0 || whatIDid.length > 0 || concerns.length > 0 || nextShould.length > 0;

  return (
    <SidebarPanel title="HANDOFF" width={width}>
      <Box flexDirection="column" width={innerWidth}>
        {sessionInfo && <Text dimColor wrap="wrap">{sessionInfo}</Text>}
        {hasSections ? (
          <>
            {contract.map((line, i) => (
              <Text key={`c${i}`} dimColor wrap="wrap">{line}</Text>
            ))}
            {whatIDid.map((line, i) => (
              <Text key={`d${i}`} dimColor wrap="wrap">{line}</Text>
            ))}
            {concerns.map((line, i) => (
              <Text key={`w${i}`} color="yellow" wrap="wrap">{"▲ "}{line}</Text>
            ))}
            {nextShould.map((line, i) => (
              <Text key={`n${i}`} dimColor wrap="wrap">{"▸ "}{line}</Text>
            ))}
          </>
        ) : (
          handoff
            .split("\n")
            .filter((l) => l.trim().length > 0 && !l.startsWith("#"))
            .slice(0, 8)
            .map((line, i) => (
              <Text key={`f${i}`} dimColor wrap="wrap">{line.trim()}</Text>
            ))
        )}
      </Box>
    </SidebarPanel>
  );
}
