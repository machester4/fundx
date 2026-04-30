import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = join(tmpdir(), `fundx-handoff-archive-test-${Date.now()}`);

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => ({
      root: join(tmpRoot, "funds", name),
      state: {
        dir: join(tmpRoot, "funds", name, "state"),
        sessionHandoff: join(tmpRoot, "funds", name, "state", "session-handoff.md"),
        handoffsDir: join(tmpRoot, "funds", name, "state", "handoffs"),
      },
    }),
  };
});

import { archiveHandoffIfExists } from "../src/services/handoff-archive.service.js";

beforeEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function seedHandoff(fund: string, content: string): Promise<void> {
  const stateDir = join(tmpRoot, "funds", fund, "state");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "session-handoff.md"), content, "utf-8");
}

describe("archiveHandoffIfExists", () => {
  it("returns null when no source handoff exists (first session)", async () => {
    const result = await archiveHandoffIfExists("nonexistent", "pre_market");
    expect(result).toBeNull();
  });

  it("copies handoff content to state/handoffs/<ts>_<type>.md", async () => {
    await seedHandoff("f1", "# Handoff\nLast session content.");
    const result = await archiveHandoffIfExists("f1", "pre_market");
    expect(result).not.toBeNull();
    expect(result).toMatch(/state\/handoffs\/.*_pre_market\.md$/);
    const archived = await readFile(result!, "utf-8");
    expect(archived).toBe("# Handoff\nLast session content.");
  });

  it("leaves the original file unchanged after archive", async () => {
    const original = "# Original\nUnchanged.";
    await seedHandoff("f2", original);
    await archiveHandoffIfExists("f2", "mid_session");
    const stillThere = await readFile(
      join(tmpRoot, "funds", "f2", "state", "session-handoff.md"),
      "utf-8",
    );
    expect(stillThere).toBe(original);
  });

  it("filename uses dashes for colons in ISO timestamp", async () => {
    await seedHandoff("f3", "x");
    const result = await archiveHandoffIfExists("f3", "pre_market");
    expect(result).not.toBeNull();
    const filename = result!.split("/").pop()!;
    expect(filename).not.toContain(":");
    // ISO timestamp with colons replaced by dashes: 2026-04-30T23-03-58.637Z
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d+Z_pre_market\.md$/);
  });

  it("creates state/handoffs/ directory if missing", async () => {
    await seedHandoff("f4", "x");
    await expect(
      stat(join(tmpRoot, "funds", "f4", "state", "handoffs")),
    ).rejects.toThrow();
    await archiveHandoffIfExists("f4", "post_market");
    const dirStat = await stat(join(tmpRoot, "funds", "f4", "state", "handoffs"));
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("returns null on permission/read errors (no throw)", async () => {
    const stateDir = join(tmpRoot, "funds", "f5", "state");
    await mkdir(stateDir, { recursive: true });
    // Create session-handoff.md as a directory instead of file → readFile fails
    await mkdir(join(stateDir, "session-handoff.md"), { recursive: true });
    const result = await archiveHandoffIfExists("f5", "pre_market");
    expect(result).toBeNull();
  });
});
