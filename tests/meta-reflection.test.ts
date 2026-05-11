import { describe, it, expect } from "vitest";
import { lastConsolidationStateSchema } from "../src/types.js";
import { fundPaths } from "../src/paths.js";
import { writeFileAtomic } from "../src/state.js";
import { listHandoffsSince } from "../src/services/handoff-archive.service.js";
import { enforceMemoryCap } from "../src/services/meta-reflection.service.js";
import { mkdtemp, readFile, rm, mkdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("lastConsolidationStateSchema", () => {
  it("parses a valid state object", () => {
    const valid = {
      cursor_iso: "2026-05-04T18:00:00.000Z",
      last_run_iso: "2026-05-04T18:00:00.000Z",
      status: "success",
      n_handoffs_processed: 12,
      n_journal_entries: 3,
      n_lessons_written: 4,
      cost_usd: 0.45,
    };
    expect(() => lastConsolidationStateSchema.parse(valid)).not.toThrow();
  });

  it("rejects bad ISO date", () => {
    const bad = {
      cursor_iso: "not-a-date",
      last_run_iso: "2026-05-04T18:00:00.000Z",
      status: "success",
      n_handoffs_processed: 0,
      n_journal_entries: 0,
      n_lessons_written: 0,
      cost_usd: 0,
    };
    expect(() => lastConsolidationStateSchema.parse(bad)).toThrow();
  });

  it("rejects unknown status", () => {
    const bad = {
      cursor_iso: "2026-05-04T18:00:00.000Z",
      last_run_iso: "2026-05-04T18:00:00.000Z",
      status: "weird",
      n_handoffs_processed: 0,
      n_journal_entries: 0,
      n_lessons_written: 0,
      cost_usd: 0,
    };
    expect(() => lastConsolidationStateSchema.parse(bad)).toThrow();
  });
});

describe("fundPaths.state.lastConsolidation", () => {
  it("points to state/last_consolidation.json under the fund root", () => {
    const paths = fundPaths("test-fund");
    expect(paths.state.lastConsolidation).toMatch(
      /funds\/test-fund\/state\/last_consolidation\.json$/,
    );
  });
});

describe("writeFileAtomic", () => {
  it("writes content to a non-existent path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fundx-test-"));
    try {
      const target = join(dir, "nested", "out.md");
      await writeFileAtomic(target, "hello\n");
      const got = await readFile(target, "utf-8");
      expect(got).toBe("hello\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("overwrites an existing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fundx-test-"));
    try {
      const target = join(dir, "out.md");
      await writeFileAtomic(target, "v1");
      await writeFileAtomic(target, "v2");
      const got = await readFile(target, "utf-8");
      expect(got).toBe("v2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function setupFundDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fundx-test-"));
  process.env.FUNDX_HOME = dir;
  return dir;
}

describe("listHandoffsSince", () => {
  it("returns empty array when archive dir does not exist", async () => {
    const dir = await setupFundDir();
    try {
      const result = await listHandoffsSince("fund-x", "1970-01-01T00:00:00.000Z");
      expect(result).toEqual([]);
    } finally {
      delete process.env.FUNDX_HOME;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns handoffs newer than cursor, sorted by mtime ascending", async () => {
    const dir = await setupFundDir();
    try {
      const archive = join(dir, "funds", "fund-x", "state", "handoffs");
      await mkdir(archive, { recursive: true });
      const olderPath = join(archive, "2026-04-01T00-00-00_pre_market.md");
      const newerPath = join(archive, "2026-05-01T00-00-00_post_market.md");
      await writeFile(olderPath, "older");
      await writeFile(newerPath, "newer");
      const olderTs = new Date("2026-04-01T00:00:00Z");
      const newerTs = new Date("2026-05-01T00:00:00Z");
      await utimes(olderPath, olderTs, olderTs);
      await utimes(newerPath, newerTs, newerTs);

      const result = await listHandoffsSince("fund-x", "2026-04-15T00:00:00.000Z");
      expect(result.map((h) => h.path)).toEqual([newerPath]);
      expect(result[0].mtime.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    } finally {
      delete process.env.FUNDX_HOME;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const SEED = "---\ndescription: Market patterns and lessons learned by the AI agent\n---\n\n";

const ENTRY = (date: string, title: string) =>
  "## " + date + " — " + title + "\n\nBody for " + title + ".\n\n";

describe("enforceMemoryCap", () => {
  it("is a no-op when entries are under the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fundx-test-"));
    try {
      const file = join(dir, "market-lessons.md");
      const content = SEED + ENTRY("2026-05-01", "A") + ENTRY("2026-05-08", "B");
      await writeFile(file, content);
      await enforceMemoryCap(file, 10);
      const got = await readFile(file, "utf-8");
      expect(got).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops oldest entries when over cap, preserving frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fundx-test-"));
    try {
      const file = join(dir, "market-lessons.md");
      const content =
        SEED +
        ENTRY("2026-04-01", "Old1") +
        ENTRY("2026-04-08", "Old2") +
        ENTRY("2026-05-01", "Newer1") +
        ENTRY("2026-05-08", "Newer2");
      await writeFile(file, content);
      await enforceMemoryCap(file, 2);
      const got = await readFile(file, "utf-8");
      expect(got).toContain("description: Market patterns");
      expect(got).not.toContain("Old1");
      expect(got).not.toContain("Old2");
      expect(got).toContain("Newer1");
      expect(got).toContain("Newer2");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves seed-only files (no entries)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fundx-test-"));
    try {
      const file = join(dir, "market-lessons.md");
      const content = SEED + "(No observations yet.)\n";
      await writeFile(file, content);
      await enforceMemoryCap(file, 10);
      const got = await readFile(file, "utf-8");
      expect(got).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
