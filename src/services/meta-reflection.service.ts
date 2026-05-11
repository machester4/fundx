import { readFile } from "node:fs/promises";
import { writeFileAtomic, writeJsonAtomic } from "../state.js";
import { fundPaths } from "../paths.js";
import { lastConsolidationStateSchema, type LastConsolidationState } from "../types.js";
import { sessionModePrefix } from "./chat.service.js";

/** Drop oldest entries beyond `cap`. An "entry" starts with a line matching
 *  `^## YYYY-MM-DD — `. Frontmatter and any prelude text before the first entry
 *  are preserved verbatim. If the file has fewer than `cap` entries (or none),
 *  the file is unchanged. Reads, splits, and rewrites atomically. */
export async function enforceMemoryCap(filePath: string, cap: number): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw err;
  }

  const positions: number[] = [];
  const re = /^## (\d{4}-\d{2}-\d{2}) — /gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    positions.push(match.index);
  }

  if (positions.length <= cap) return;

  const firstEntryIdx = positions[0];
  const prelude = content.slice(0, firstEntryIdx);

  const entries: string[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : content.length;
    entries.push(content.slice(start, end));
  }

  const kept = entries.slice(entries.length - cap);
  const rebuilt = prelude + kept.join("");
  await writeFileAtomic(filePath, rebuilt);
}

/** Read the consolidation tracker for a fund.
 *  Returns null if the file does not exist (first-run case). */
export async function readConsolidationState(
  fundName: string,
): Promise<LastConsolidationState | null> {
  const paths = fundPaths(fundName);
  try {
    const raw = await readFile(paths.state.lastConsolidation, "utf-8");
    return lastConsolidationStateSchema.parse(JSON.parse(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

/** Write the consolidation tracker atomically. */
export async function writeConsolidationState(
  fundName: string,
  state: LastConsolidationState,
): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.lastConsolidation, state);
}

/** Memory statistics for a fund. */
export interface MemoryStats {
  marketLessons: { entries: number; lastUpdate: string };
  tradingPatterns: { entries: number; lastUpdate: string };
  fundNotes: { entries: number; lastUpdate: string };
}

/** Input parameters for buildMetaReflectionPrompt. */
export interface BuildMetaReflectionPromptInput {
  fundName: string;
  objective: string;
  portfolioSummary: string;
  memoryStats: MemoryStats;
  lastConsolidationIso: string;
  handoffsConcat: string;
  journalRows: string;
  currentMemory: string;
}

/**
 * Build the user-message prompt for a meta-reflection session. This prompt
 * includes the fund state snapshot, handoff history, journal entries, current
 * memory, and the task to consolidate new lessons into the three memory files.
 * Returns a string ready to pass as the user message to the Agent SDK.
 */
export function buildMetaReflectionPrompt(
  input: BuildMetaReflectionPromptInput,
): string {
  const daysAgo = Math.floor(
    (Date.now() - new Date(input.lastConsolidationIso).getTime()) / 86_400_000,
  );
  return [
    sessionModePrefix("autonomous-scheduled"),
    ``,
    `<state_snapshot>`,
    `Fund: ${input.fundName}`,
    `Objective: ${input.objective}`,
    `Portfolio: ${input.portfolioSummary}`,
    `Memory state:`,
    `  - market-lessons.md: ${input.memoryStats.marketLessons.entries} entries, last update ${input.memoryStats.marketLessons.lastUpdate}`,
    `  - trading-patterns.md: ${input.memoryStats.tradingPatterns.entries} entries, last update ${input.memoryStats.tradingPatterns.lastUpdate}`,
    `  - fund-notes.md: ${input.memoryStats.fundNotes.entries} entries, last update ${input.memoryStats.fundNotes.lastUpdate}`,
    `Last consolidation: ${input.lastConsolidationIso} (${daysAgo} days ago)`,
    `</state_snapshot>`,
    ``,
    `<handoffs_to_process>`,
    input.handoffsConcat,
    `</handoffs_to_process>`,
    ``,
    `<journal_entries_to_process>`,
    input.journalRows,
    `</journal_entries_to_process>`,
    ``,
    `<current_memory>`,
    input.currentMemory,
    `</current_memory>`,
    ``,
    `<task>`,
    `Distill new lessons from the handoffs and journal entries above. Use the memory-consolidation skill technique.`,
    ``,
    `Each lesson must:`,
    `- Be 1-3 sentences with specific data (prices, dates, indicators).`,
    `- Not duplicate anything already in <current_memory>.`,
    `- Route to the appropriate file:`,
    `  - memory/market-lessons.md: regime/sector/macro patterns`,
    `  - memory/trading-patterns.md: setup/timing/sizing patterns`,
    `  - memory/fund-notes.md: fund-strategy reflections`,
    ``,
    `Use the Write tool to APPEND each lesson in this format:`,
    ``,
    `## YYYY-MM-DD — Title`,
    ``,
    `Body (1-3 sentences with specific data).`,
    ``,
    `If no genuinely new lesson is worth recording, write nothing — quality over quantity.`,
    `</task>`,
  ].join("\n");
}
