import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../state.js";

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
