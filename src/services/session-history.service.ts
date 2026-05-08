import { appendFile, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { fundPaths } from "../paths.js";
import { sessionLogV2Schema, type SessionLogV2 } from "../types.js";

export interface DailyUsage {
  totalUsd: number;
  sessionCount: number;
  entries: SessionLogV2[];
}

/** Append one V2 session log record as a JSON Lines entry.
 *  Single concurrent writer per fund (the daemon), so interleaving is not
 *  a concern in normal operation. Lines are well under PIPE_BUF (~4KB) on
 *  typical config — if SessionLogV2 grows new large fields, revisit. */
export async function appendSessionLogEntry(
  fundName: string,
  log: SessionLogV2,
): Promise<void> {
  const path = fundPaths(fundName).state.sessionLogJsonl;
  await mkdir(dirname(path), { recursive: true });
  const line = JSON.stringify(log) + "\n";
  await appendFile(path, line, "utf-8");
}

/** Read the JSONL filtered by `started_at >= midnight UTC today`.
 *  Returns aggregate cost + session count + raw entries.
 *  Skips malformed lines (logs warning, doesn't crash). */
export async function readTodaysSessionUsage(fundName: string): Promise<DailyUsage> {
  const path = fundPaths(fundName).state.sessionLogJsonl;
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { totalUsd: 0, sessionCount: 0, entries: [] };
    }
    throw err;
  }

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const entries: SessionLogV2[] = [];
  let totalUsd = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: SessionLogV2;
    try {
      parsed = sessionLogV2Schema.parse(JSON.parse(trimmed));
    } catch (err) {
      console.warn(
        `[session-history] skipping malformed line in ${path}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    const entryMs = new Date(parsed.started_at).getTime();
    if (entryMs >= todayMs) {
      entries.push(parsed);
      totalUsd += parsed.cost_usd ?? 0;
    }
  }

  return { totalUsd, sessionCount: entries.length, entries };
}

/** Remove JSONL lines whose started_at is older than retentionDays.
 *  Atomic rewrite via tmp + rename. */
export async function pruneSessionLogJsonl(
  fundName: string,
  retentionDays = 90,
): Promise<void> {
  const path = fundPaths(fundName).state.sessionLogJsonl;
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const cutoffMs = Date.now() - retentionDays * 24 * 3600 * 1000;
  const kept: string[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { started_at?: string };
      const entryMs = parsed.started_at ? new Date(parsed.started_at).getTime() : NaN;
      if (!Number.isNaN(entryMs) && entryMs >= cutoffMs) {
        kept.push(trimmed);
      }
    } catch {
      // skip malformed
    }
  }

  const tmp = path + ".tmp";
  await writeFile(tmp, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf-8");
  await rename(tmp, path);
}
