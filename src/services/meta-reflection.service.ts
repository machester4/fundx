import { readFile } from "node:fs/promises";
import { writeFileAtomic, writeJsonAtomic } from "../state.js";
import { fundPaths } from "../paths.js";
import { lastConsolidationStateSchema, type LastConsolidationState } from "../types.js";

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
