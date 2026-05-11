import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic, writeJsonAtomic, readPortfolio } from "../state.js";
import { fundPaths } from "../paths.js";
import {
  lastConsolidationStateSchema,
  type LastConsolidationState,
  type FundConfig,
} from "../types.js";
import { sessionModePrefix } from "./chat.service.js";
import { runFundSession, resolveDailyCapUsd, checkDailyCap } from "./session.service.js";
import { loadFundConfig } from "./fund.service.js";
import { openJournal } from "../journal.js";
import { listHandoffsSince } from "./handoff-archive.service.js";
import { loadGlobalConfig } from "../config.js";

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

// ── Helpers used only by runMetaReflection ─────────────────────────────────

/** Produce a human-readable one-liner from any objective variant. */
function describeObjective(config: FundConfig): string {
  const obj = config.objective;
  switch (obj.type) {
    case "custom":
      return obj.description;
    case "runway":
      return `Runway — sustain ${obj.target_months} months at $${obj.monthly_burn}/mo`;
    case "growth":
      return obj.target_multiple
        ? `Growth — ${obj.target_multiple}x capital`
        : obj.target_amount
          ? `Growth — reach $${obj.target_amount}`
          : "Growth";
    case "accumulation":
      return `Accumulation — ${obj.target_amount} ${obj.target_asset}`;
    case "income":
      return `Income — $${obj.target_monthly_income}/mo`;
  }
}

/** Read all three memory files. Returns the concatenated content and
 *  per-file stats (entry count + last entry date). Returns "" + zero stats
 *  for files that don't exist yet. */
async function snapshotMemory(fundName: string): Promise<{
  concat: string;
  stats: MemoryStats;
}> {
  const paths = fundPaths(fundName);
  const files = [
    { name: "market-lessons.md", key: "marketLessons" as const },
    { name: "trading-patterns.md", key: "tradingPatterns" as const },
    { name: "fund-notes.md", key: "fundNotes" as const },
  ];
  let concat = "";
  const stats: MemoryStats = {
    marketLessons: { entries: 0, lastUpdate: "never" },
    tradingPatterns: { entries: 0, lastUpdate: "never" },
    fundNotes: { entries: 0, lastUpdate: "never" },
  };
  for (const f of files) {
    const filePath = join(paths.memory, f.name);
    try {
      const content = await readFile(filePath, "utf-8");
      concat += "\n--- " + f.name + " ---\n" + content;
      const matches = [...content.matchAll(/^## (\d{4}-\d{2}-\d{2}) — /gm)];
      stats[f.key] = {
        entries: matches.length,
        lastUpdate: matches.length > 0 ? matches[matches.length - 1][1] : "never",
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
  return { concat, stats };
}

/** Read journal rows touched (entry or exit) on or after cursorIso.
 *  Returns a compact pipe-delimited string suitable for prompt injection. */
function loadJournalSince(
  fundName: string,
  cursorIso: string,
): { rows: string; count: number } {
  const db = openJournal(fundName);
  try {
    const rows = db
      .prepare(
        "SELECT symbol, side, timestamp, closed_at, price, close_price, pnl_pct," +
          " substr(reasoning, 1, 200) AS reasoning," +
          " substr(lessons_learned, 1, 200) AS lessons_learned" +
          " FROM trades" +
          " WHERE fund = ?" +
          "   AND (timestamp >= ? OR closed_at >= ?)" +
          " ORDER BY COALESCE(closed_at, timestamp) ASC",
      )
      .all(fundName, cursorIso, cursorIso) as Array<Record<string, unknown>>;
    const formatted = rows
      .map(
        (r) =>
          `${r.symbol} | ${r.side} | entry ${r.timestamp} @ ${r.price} | exit ${r.closed_at ?? "open"} @ ${r.close_price ?? "-"} | pnl ${r.pnl_pct ?? "-"}% | thesis: ${r.reasoning ?? ""} | lessons: ${r.lessons_learned ?? ""}`,
      )
      .join("\n");
    return { rows: formatted || "(no journal entries since cursor)", count: rows.length };
  } finally {
    db.close();
  }
}

const MEMORY_CAPS = {
  "market-lessons.md": 50,
  "trading-patterns.md": 50,
  "fund-notes.md": 30,
} as const;

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

/** Orchestrate one meta-reflection cycle for a fund.
 *  Steps:
 *  1. Read tracker (or virtual epoch on first run).
 *  2. List new handoffs + journal entries since cursor.
 *  3. If both empty -> write `no_data` tracker, return.
 *  4. Build prompt, call runFundSession with the override.
 *  5. On success: enforce caps + advance cursor + write `success` tracker.
 *  6. On error: write `error` tracker, do NOT advance cursor. */
export async function runMetaReflection(fundName: string): Promise<void> {
  const prev = await readConsolidationState(fundName);
  const cursor = prev?.cursor_iso ?? EPOCH_ISO;
  const nowIso = new Date().toISOString();

  const handoffs = await listHandoffsSince(fundName, cursor);
  const journal = loadJournalSince(fundName, cursor);

  if (handoffs.length === 0 && journal.count === 0) {
    await writeConsolidationState(fundName, {
      cursor_iso: cursor,
      last_run_iso: nowIso,
      status: "no_data",
      n_handoffs_processed: 0,
      n_journal_entries: 0,
      n_lessons_written: 0,
      cost_usd: 0,
    });
    return;
  }

  const config = await loadFundConfig(fundName);
  const globalConfig = await loadGlobalConfig();
  const dailyCap = resolveDailyCapUsd(config, globalConfig);
  const capCheck = await checkDailyCap(fundName, dailyCap);
  if (!capCheck.allowed) {
    await writeConsolidationState(fundName, {
      cursor_iso: cursor, // do NOT advance
      last_run_iso: nowIso,
      status: "skipped_daily_cap",
      n_handoffs_processed: 0,
      n_journal_entries: 0,
      n_lessons_written: 0,
      cost_usd: 0,
    });
    return;
  }

  const portfolio = await readPortfolio(fundName).catch(() => null);
  const portfolioSummary = portfolio
    ? portfolio.positions.length + " positions, $" + portfolio.cash.toFixed(0) + " cash"
    : "(portfolio not yet initialized)";

  const memory = await snapshotMemory(fundName);

  const handoffsConcat = await Promise.all(
    handoffs.map(
      async (h) => "\n--- " + h.path + " ---\n" + (await readFile(h.path, "utf-8")),
    ),
  ).then((arr) => arr.join("\n"));

  const beforeLessonCounts = memory.stats;

  try {
    await runFundSession(fundName, "meta_reflection", {
      focus: "Distill recent handoffs and journal entries into memory/*.md.",
      promptBuilder: () =>
        buildMetaReflectionPrompt({
          fundName,
          objective: describeObjective(config),
          portfolioSummary,
          memoryStats: memory.stats,
          lastConsolidationIso: cursor,
          handoffsConcat,
          journalRows: journal.rows,
          currentMemory: memory.concat,
        }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeConsolidationState(fundName, {
      cursor_iso: cursor, // do NOT advance on error
      last_run_iso: nowIso,
      status: "error",
      n_handoffs_processed: 0,
      n_journal_entries: 0,
      n_lessons_written: 0,
      cost_usd: 0,
      error: message,
    });
    return;
  }

  const paths = fundPaths(fundName);
  for (const [name, cap] of Object.entries(MEMORY_CAPS)) {
    await enforceMemoryCap(join(paths.memory, name), cap);
  }

  const after = await snapshotMemory(fundName);
  const lessonsWritten =
    after.stats.marketLessons.entries -
    beforeLessonCounts.marketLessons.entries +
    after.stats.tradingPatterns.entries -
    beforeLessonCounts.tradingPatterns.entries +
    after.stats.fundNotes.entries -
    beforeLessonCounts.fundNotes.entries;

  const newCursor =
    handoffs.length > 0
      ? handoffs[handoffs.length - 1].mtime.toISOString()
      : nowIso;

  await writeConsolidationState(fundName, {
    cursor_iso: newCursor,
    last_run_iso: nowIso,
    status: "success",
    n_handoffs_processed: handoffs.length,
    n_journal_entries: journal.count,
    n_lessons_written: Math.max(0, lessonsWritten),
    cost_usd: 0, // session_log.jsonl carries the authoritative cost
  });
}
