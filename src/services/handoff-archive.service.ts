import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fundPaths } from "../paths.js";

/** Archive the existing session-handoff.md (if present) to a timestamped file
 *  in state/handoffs/. Returns the archive path on success, null if there was
 *  nothing to archive or any error occurred (logs warning on real errors).
 *
 *  Filename format: <iso-ts>_<sessionType>.md with colons replaced by dashes
 *  for shell-friendliness. Example: 2026-04-30T18-29-01_pre_market.md
 *
 *  Never throws — caller can rely on the Promise resolving with null on any failure. */
export async function archiveHandoffIfExists(
  fundName: string,
  sessionType: string,
): Promise<string | null> {
  const paths = fundPaths(fundName);

  let content: string;
  try {
    content = await readFile(paths.state.sessionHandoff, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // No handoff to archive (first session) — silent expected case
      return null;
    }
    console.warn(
      `[handoff-archive] read failed for ${fundName}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const isoTs = new Date().toISOString().replace(/:/g, "-");
  const filename = `${isoTs}_${sessionType}.md`;
  const archivePath = join(paths.state.handoffsDir, filename);

  try {
    await mkdir(paths.state.handoffsDir, { recursive: true });
    await writeFile(archivePath, content, "utf-8");
    return archivePath;
  } catch (err) {
    console.warn(
      `[handoff-archive] write failed for ${fundName}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export interface HandoffArchiveEntry {
  path: string;
  mtime: Date;
}

/** List archived handoff files whose mtime is strictly greater than cursorIso.
 *  Returns sorted by mtime ascending (oldest first). Returns [] if the archive
 *  directory does not exist. */
export async function listHandoffsSince(
  fundName: string,
  cursorIso: string,
): Promise<HandoffArchiveEntry[]> {
  const paths = fundPaths(fundName);
  let entries: string[];
  try {
    entries = await readdir(paths.state.handoffsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }

  const cursor = new Date(cursorIso).getTime();
  const matches: HandoffArchiveEntry[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const fullPath = join(paths.state.handoffsDir, name);
    const st = await stat(fullPath);
    if (st.mtimeMs > cursor) {
      matches.push({ path: fullPath, mtime: new Date(st.mtimeMs) });
    }
  }
  matches.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  return matches;
}
