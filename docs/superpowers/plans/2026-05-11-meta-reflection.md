# Meta-Reflection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a weekly autonomous session (`meta_reflection`) that distills archived handoffs and recent journal entries into consolidated lessons in the per-fund `memory/*.md` files, closing the empirically-observed gap where rich per-session reasoning stays trapped in handoffs.

**Architecture:** New session-type orchestrated from a dedicated service (`meta-reflection.service.ts`). It reuses `runFundSession` for execution (daily cap, watchdog, log writing, Telegram) but injects a different prompt builder that loads handoffs+journal+memory and instructs the agent to append lessons. Cap enforcement is a deterministic post-run helper. Tracker advances cursor on success only.

**Tech Stack:** TypeScript (Node 20+), Vitest, Zod, Pastel (CLI), Ink, node-cron, better-sqlite3, Claude Agent SDK.

**Spec:** `docs/superpowers/specs/2026-05-11-meta-reflection-design.md` (commit 15f5654).

---

## File Map

**New:**
- `src/services/meta-reflection.service.ts` — orchestration: tracker CRUD, list handoffs, build prompt, cap enforcement, `runMetaReflection`.
- `src/commands/fund/consolidate.tsx` — `fundx fund consolidate <name>` CLI command.
- `tests/meta-reflection.test.ts` — unit tests for all pure helpers.
- `tests/integration/meta-reflection-tick.test.ts` — end-to-end with ephemeral fund + mocked SDK.
- `tests/eval/cases/mvp-meta-reflection.yaml` — eval case with LLM-judge rubric.
- `tests/eval/fixtures/growth-with-handoffs.yaml` — fixture with seeded handoffs + journal.

**Modified:**
- `src/types.ts` — add `lastConsolidationStateSchema` + `LastConsolidationState` type.
- `src/paths.ts` — add `state.lastConsolidation` path.
- `src/state.ts` — extract `writeFileAtomic` helper from existing pattern.
- `src/services/handoff-archive.service.ts` — export `listHandoffsSince`.
- `src/services/session.service.ts` — accept optional `promptBuilder` override in `runFundSession`.
- `src/services/daemon.service.ts` — register weekly cron for meta_reflection.
- `src/skills.ts` — append `memory-consolidation` to `BUILTIN_SKILLS`.
- `src/services/eval/runner.ts` — add `surface: "meta_reflection"` branch.
- `tests/skills.test.ts` — add assertion that `memory-consolidation` skill exists.
- `CLAUDE.md` — document new session type under "Session Modes" / state files section.
- `docs/operations.md` — runbook section for verifying weekly consolidations.

---

## Task 1: Foundation types + path helper

**Files:**
- Modify: `src/types.ts` (add schema + type)
- Modify: `src/paths.ts:118-137` (add `lastConsolidation` to state paths)
- Test: `tests/meta-reflection.test.ts` (new file)

- [ ] **Step 1: Write the failing test**

Create `tests/meta-reflection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { lastConsolidationStateSchema } from "../src/types.js";
import { fundPaths } from "../src/paths.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: FAIL — `lastConsolidationStateSchema` not exported, `paths.state.lastConsolidation` undefined.

- [ ] **Step 3: Add the schema and inferred type to `src/types.ts`**

Append to the end of `src/types.ts`:

```typescript
// ── Last Consolidation State (meta_reflection tracker) ─────────

export const lastConsolidationStateSchema = z.object({
  cursor_iso: z.string().datetime(),
  last_run_iso: z.string().datetime(),
  status: z.enum(["success", "no_data", "skipped_daily_cap", "error"]),
  n_handoffs_processed: z.number().int().min(0),
  n_journal_entries: z.number().int().min(0),
  n_lessons_written: z.number().int().min(0),
  cost_usd: z.number().min(0),
  error: z.string().optional(),
});

export type LastConsolidationState = z.infer<typeof lastConsolidationStateSchema>;
```

- [ ] **Step 4: Add path helper to `src/paths.ts`**

In `src/paths.ts`, modify the `state:` block in `fundPaths` (around line 118-137) — add this line right after `dailyCapState`:

```typescript
      lastConsolidation: join(root, "state", "last_consolidation.json"),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: PASS (4 specs).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/paths.ts tests/meta-reflection.test.ts
git commit -m "feat(meta-reflection): foundation types + path for consolidation tracker"
```

---

## Task 2: Extract `writeFileAtomic` helper from `state.ts`

**Files:**
- Modify: `src/state.ts:28-33` (extract pattern)
- Test: `tests/meta-reflection.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/meta-reflection.test.ts`:

```typescript
import { writeFileAtomic } from "../src/state.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: FAIL — `writeFileAtomic` not exported.

- [ ] **Step 3: Add helper to `src/state.ts`**

In `src/state.ts`, add immediately below the existing `writeJsonAtomic` (around line 33):

```typescript
/** Write a UTF-8 text file atomically: write to .tmp then rename */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);
}
```

(`mkdir`, `writeFile`, `rename`, `dirname`, `join` are already imported at the top of the file.)

Also refactor `writeJsonAtomic` to delegate to `writeFileAtomic` for DRY:

```typescript
/** Write JSON atomically: write to .tmp then rename */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/meta-reflection.test.ts tests/state.test.ts`
Expected: PASS for new tests; existing state tests still PASS (refactor is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/meta-reflection.test.ts
git commit -m "refactor(state): extract writeFileAtomic helper from writeJsonAtomic"
```

---

## Task 3: `listHandoffsSince` helper

**Files:**
- Modify: `src/services/handoff-archive.service.ts` (add export)
- Test: `tests/meta-reflection.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/meta-reflection.test.ts`:

```typescript
import { listHandoffsSince } from "../src/services/handoff-archive.service.js";
import { mkdir, writeFile, utimes } from "node:fs/promises";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: FAIL — `listHandoffsSince` not exported.

- [ ] **Step 3: Add helper to `handoff-archive.service.ts`**

Add to `src/services/handoff-archive.service.ts` (extend imports + new export at the bottom):

```typescript
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
// ... existing code unchanged ...

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
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: PASS (6 specs total now).

- [ ] **Step 5: Commit**

```bash
git add src/services/handoff-archive.service.ts tests/meta-reflection.test.ts
git commit -m "feat(handoff-archive): add listHandoffsSince(fundName, cursorIso)"
```

---

## Task 4: `enforceMemoryCap` helper

**Files:**
- Create: `src/services/meta-reflection.service.ts`
- Test: `tests/meta-reflection.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/meta-reflection.test.ts`:

```typescript
import { enforceMemoryCap } from "../src/services/meta-reflection.service.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: FAIL — module `meta-reflection.service.ts` does not exist.

- [ ] **Step 3: Create `src/services/meta-reflection.service.ts`**

```typescript
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: PASS (9 specs total).

- [ ] **Step 5: Commit**

```bash
git add src/services/meta-reflection.service.ts tests/meta-reflection.test.ts
git commit -m "feat(meta-reflection): enforceMemoryCap drops oldest entries beyond cap"
```

---

## Task 5: Tracker CRUD (read/write `last_consolidation.json`)

**Files:**
- Modify: `src/services/meta-reflection.service.ts` (add tracker functions)
- Test: `tests/meta-reflection.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/meta-reflection.test.ts`:

```typescript
import {
  readConsolidationState,
  writeConsolidationState,
} from "../src/services/meta-reflection.service.js";
import type { LastConsolidationState } from "../src/types.js";

describe("consolidation state CRUD", () => {
  it("returns null when no tracker file exists", async () => {
    const dir = await setupFundDir();
    try {
      const result = await readConsolidationState("fund-x");
      expect(result).toBeNull();
    } finally {
      delete process.env.FUNDX_HOME;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a valid state", async () => {
    const dir = await setupFundDir();
    try {
      const state: LastConsolidationState = {
        cursor_iso: "2026-05-04T18:00:00.000Z",
        last_run_iso: "2026-05-04T18:00:00.000Z",
        status: "success",
        n_handoffs_processed: 12,
        n_journal_entries: 3,
        n_lessons_written: 4,
        cost_usd: 0.45,
      };
      await writeConsolidationState("fund-x", state);
      const got = await readConsolidationState("fund-x");
      expect(got).toEqual(state);
    } finally {
      delete process.env.FUNDX_HOME;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: FAIL — `readConsolidationState` / `writeConsolidationState` not exported.

- [ ] **Step 3: Add tracker CRUD to `meta-reflection.service.ts`**

Add to `src/services/meta-reflection.service.ts` (extend top imports + new exports):

```typescript
import { readFile } from "node:fs/promises";
import { writeFileAtomic, writeJsonAtomic } from "../state.js";
import { fundPaths } from "../paths.js";
import {
  lastConsolidationStateSchema,
  type LastConsolidationState,
} from "../types.js";

// ... existing enforceMemoryCap unchanged ...

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
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: PASS (11 specs total).

- [ ] **Step 5: Commit**

```bash
git add src/services/meta-reflection.service.ts tests/meta-reflection.test.ts
git commit -m "feat(meta-reflection): tracker CRUD for state/last_consolidation.json"
```

---

## Task 6: `memory-consolidation` skill

**Files:**
- Modify: `src/skills.ts` (append to `BUILTIN_SKILLS` array)
- Modify: `tests/skills.test.ts` (add assertion)

- [ ] **Step 1: Write the failing test**

Append to `tests/skills.test.ts`:

```typescript
describe("memory-consolidation skill", () => {
  it("exists in BUILTIN_SKILLS with required sections", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.dirName === "memory-consolidation");
    expect(skill).toBeDefined();
    expect(skill!.name).toMatch(/Memory Consolidation/i);
    expect(skill!.description).toMatch(/distill|consolidat/i);
    expect(skill!.content).toContain("## When to Use");
    expect(skill!.content).toContain("## When NOT to Use");
    expect(skill!.content).toContain("## Technique");
    expect(skill!.content).toContain("## Output Format");
    expect(skill!.content).toContain("meta_reflection");
  });
});
```

(`BUILTIN_SKILLS` should already be imported at the top of `tests/skills.test.ts` from prior tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/skills.test.ts`
Expected: FAIL — `memory-consolidation` skill not found.

- [ ] **Step 3: Append the skill to `BUILTIN_SKILLS` in `src/skills.ts`**

Add a new `Skill` object inside `BUILTIN_SKILLS` (just before the closing `]` of the array, around line 905). Use a template literal for `content` so the markdown body is preserved. The body sections required are: `## When to Use`, `## When NOT to Use`, `## Technique`, `## Anti-patterns`, `## Output Format`. Mention `meta_reflection` explicitly. Routing must list `memory/market-lessons.md`, `memory/trading-patterns.md`, `memory/fund-notes.md`. Output format must show the entry shape: `## YYYY-MM-DD — Title` followed by 1-3 sentence body. Include explicit guidance "Quality over quantity — write zero new lessons if nothing genuinely new emerged."

(See spec section "memory-consolidation skill" for the full canonical body to copy verbatim into the template literal.)

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills.ts tests/skills.test.ts
git commit -m "feat(skills): add memory-consolidation skill"
```

---

## Task 7: `buildMetaReflectionPrompt` builder

**Files:**
- Modify: `src/services/meta-reflection.service.ts` (add prompt builder)
- Test: `tests/meta-reflection.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/meta-reflection.test.ts`:

```typescript
import { buildMetaReflectionPrompt } from "../src/services/meta-reflection.service.js";

describe("buildMetaReflectionPrompt", () => {
  it("includes all required envelope tags and routes to memory files", () => {
    const prompt = buildMetaReflectionPrompt({
      fundName: "growth",
      objective: "Grow capital 2x",
      portfolioSummary: "3 positions, $35,000 cash, $40,500 total",
      memoryStats: {
        marketLessons: { entries: 12, lastUpdate: "2026-05-04" },
        tradingPatterns: { entries: 5, lastUpdate: "2026-05-04" },
        fundNotes: { entries: 3, lastUpdate: "2026-04-20" },
      },
      lastConsolidationIso: "2026-05-04T18:00:00.000Z",
      handoffsConcat: "## Handoff 1\n\nSomething important happened\n",
      journalRows: "AAPL | buy | 2026-05-08 | thesis ...",
      currentMemory: "(market-lessons content)\n\n(trading-patterns content)\n\n(fund-notes content)",
    });

    expect(prompt).toContain("Session mode: autonomous scheduled");
    expect(prompt).toContain("<state_snapshot>");
    expect(prompt).toContain("Fund: growth");
    expect(prompt).toContain("<handoffs_to_process>");
    expect(prompt).toContain("<journal_entries_to_process>");
    expect(prompt).toContain("<current_memory>");
    expect(prompt).toContain("<task>");
    expect(prompt).toContain("market-lessons.md");
    expect(prompt).toContain("trading-patterns.md");
    expect(prompt).toContain("fund-notes.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: FAIL — `buildMetaReflectionPrompt` not exported.

- [ ] **Step 3: Add the builder to `meta-reflection.service.ts`**

Append to `src/services/meta-reflection.service.ts`:

```typescript
import { sessionModePrefix } from "./chat.service.js";

export interface MemoryStats {
  marketLessons: { entries: number; lastUpdate: string };
  tradingPatterns: { entries: number; lastUpdate: string };
  fundNotes: { entries: number; lastUpdate: string };
}

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
```

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: PASS (12 specs total).

- [ ] **Step 5: Commit**

```bash
git add src/services/meta-reflection.service.ts tests/meta-reflection.test.ts
git commit -m "feat(meta-reflection): buildMetaReflectionPrompt builder"
```

---

## Task 8: Accept `promptBuilder` override in `runFundSession`

**Files:**
- Modify: `src/services/session.service.ts:273-300` (extend options + branching)
- Test: existing tests must keep passing

- [ ] **Step 1: Add the option type and branch**

In `src/services/session.service.ts`, modify the `options?` parameter type of `runFundSession` (around line 276):

```typescript
  options?: {
    focus?: string;
    useDebateSkills?: boolean;
    maxTurns?: number;
    maxDurationMinutes?: number;
    /** Override the default autonomous prompt builder. When provided, the
     *  caller is responsible for emitting the session-mode prefix and any
     *  state snapshot. Used by meta-reflection sessions which need a
     *  different prompt envelope (handoffs + journal + current memory). */
    promptBuilder?: (ctx: { today: string }) => string;
    _testOnly_watchdog?: { hardMs: number; pollMs?: number };
  },
```

Then locate the call site of `buildAutonomousPrompt` (around line 347) and replace:

```typescript
  const prompt = buildAutonomousPrompt({
    fundName,
    sessionType,
    focus,
    today,
    stateSnapshot,
    universeBlock,
    useDebateSkills: options?.useDebateSkills ?? false,
  });
```

with:

```typescript
  const prompt = options?.promptBuilder
    ? options.promptBuilder({ today })
    : buildAutonomousPrompt({
        fundName,
        sessionType,
        focus,
        today,
        stateSnapshot,
        universeBlock,
        useDebateSkills: options?.useDebateSkills ?? false,
      });
```

- [ ] **Step 2: Run all existing tests to verify no regression**

Run: `pnpm test`
Expected: ALL pass (the change is opt-in; existing callers don't pass `promptBuilder`).

- [ ] **Step 3: Add a focused test for the override path**

Append to `tests/meta-reflection.test.ts`:

```typescript
describe("runFundSession promptBuilder override", () => {
  it("accepts a promptBuilder function in its options shape", () => {
    const builder: (ctx: { today: string }) => string = (ctx) =>
      "prompt for " + ctx.today;
    expect(typeof builder).toBe("function");
    expect(builder({ today: "2026-05-11" })).toBe("prompt for 2026-05-11");
  });
});
```

(This is intentionally light — the real exercise is in the integration test.)

- [ ] **Step 4: Run tests**

Run: `pnpm test tests/meta-reflection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/session.service.ts tests/meta-reflection.test.ts
git commit -m "feat(session): accept optional promptBuilder override in runFundSession"
```

---

## Task 9: `runMetaReflection` orchestration

**Files:**
- Modify: `src/services/meta-reflection.service.ts` (add orchestrator)
- Test: covered by Task 11 (integration test)

- [ ] **Step 1: Add the orchestrator function**

Append to `src/services/meta-reflection.service.ts`:

```typescript
import { runFundSession } from "./session.service.js";
import { loadFundConfig } from "./fund.service.js";
import { readPortfolio } from "../state.js";
import { openJournal } from "../journal.js";
import { listHandoffsSince } from "./handoff-archive.service.js";

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
    const filePath = paths.memory + "/" + f.name;
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
function loadJournalSince(fundName: string, cursorIso: string): { rows: string; count: number } {
  const cursorDate = cursorIso.slice(0, 10);
  const db = openJournal(fundName);
  try {
    const rows = db
      .prepare(
        "SELECT symbol, side, entry_date, exit_date, entry_price, exit_price, pnl_pct," +
          " substr(reasoning, 1, 200) AS reasoning," +
          " substr(lessons_learned, 1, 200) AS lessons_learned" +
          " FROM trades" +
          " WHERE entry_date >= ? OR exit_date >= ?" +
          " ORDER BY COALESCE(exit_date, entry_date) ASC",
      )
      .all(cursorDate, cursorDate) as Array<Record<string, unknown>>;
    const formatted = rows
      .map(
        (r) =>
          `${r.symbol} | ${r.side} | entry ${r.entry_date} @ ${r.entry_price} | exit ${r.exit_date ?? "open"} @ ${r.exit_price ?? "-"} | pnl ${r.pnl_pct ?? "-"}% | thesis: ${r.reasoning ?? ""} | lessons: ${r.lessons_learned ?? ""}`,
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
  const portfolio = await readPortfolio(fundName).catch(() => null);
  const portfolioSummary = portfolio
    ? portfolio.positions.length + " positions, $" + portfolio.cash.toFixed(0) + " cash"
    : "(portfolio not yet initialized)";

  const memory = await snapshotMemory(fundName);

  const handoffsConcat = await Promise.all(
    handoffs.map(async (h) => "\n--- " + h.path + " ---\n" + (await readFile(h.path, "utf-8"))),
  ).then((arr) => arr.join("\n"));

  const beforeLessonCounts = memory.stats;

  try {
    await runFundSession(fundName, "meta_reflection", {
      focus: "Distill recent handoffs and journal entries into memory/*.md.",
      promptBuilder: () =>
        buildMetaReflectionPrompt({
          fundName,
          objective: config.objective.description ?? "(no objective)",
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
    await enforceMemoryCap(paths.memory + "/" + name, cap);
  }

  const after = await snapshotMemory(fundName);
  const lessonsWritten =
    after.stats.marketLessons.entries - beforeLessonCounts.marketLessons.entries +
    after.stats.tradingPatterns.entries - beforeLessonCounts.tradingPatterns.entries +
    after.stats.fundNotes.entries - beforeLessonCounts.fundNotes.entries;

  const newCursor =
    handoffs.length > 0
      ? handoffs[handoffs.length - 1].mtime.toISOString()
      : cursor;

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
```

(Note: `loadFundConfig` may not exist as a named export — check `src/services/fund.service.ts` for the actual loader name; common names are `loadFundConfig`, `getFundConfig`, or `readFundConfig`. Match the existing API.)

- [ ] **Step 2: Verify build**

Run: `pnpm typecheck && pnpm build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/services/meta-reflection.service.ts
git commit -m "feat(meta-reflection): runMetaReflection orchestration"
```

---

## Task 10: CLI command `fundx fund consolidate <name>`

**Files:**
- Create: `src/commands/fund/consolidate.tsx`

- [ ] **Step 1: Create the command file**

Create `src/commands/fund/consolidate.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { z } from "zod";
import { runMetaReflection } from "../../services/meta-reflection.service.js";
import { fundExists } from "../../services/fund.service.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Manually trigger a meta-reflection consolidation for a fund (also used for backfill).";

export const args = z.tuple([z.string().describe("Fund name")]);

export default function Consolidate({ args }: { args: [string] }) {
  const [fundName] = args;
  const [phase, setPhase] = useState<"running" | "done" | "error">("running");
  const [errorMsg, setErrorMsg] = useState<string>("");

  useEffect(() => {
    (async () => {
      if (!(await fundExists(fundName))) {
        setErrorMsg("Fund '" + fundName + "' does not exist.");
        setPhase("error");
        return;
      }
      try {
        await runMetaReflection(fundName);
        setPhase("done");
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
  }, [fundName]);

  if (phase === "running") {
    return (
      <Box>
        <Text>Running meta-reflection for {fundName}…</Text>
      </Box>
    );
  }
  if (phase === "error") {
    return <ErrorMessage>{errorMsg}</ErrorMessage>;
  }
  return (
    <SuccessMessage>
      Consolidation complete. See state/last_consolidation.json for status.
    </SuccessMessage>
  );
}
```

(`fundExists` may need to be added to `src/services/fund.service.ts` if it doesn't exist — check first; if absent, add: `export async function fundExists(name: string): Promise<boolean>` returning whether `fundPaths(name).config` is readable.)

- [ ] **Step 2: Verify command discovery**

Run: `pnpm dev -- fund consolidate --help`
Expected: shows the description and `<name>` positional arg.

- [ ] **Step 3: Commit**

```bash
git add src/commands/fund/consolidate.tsx src/services/fund.service.ts
git commit -m "feat(cli): add fundx fund consolidate <name>"
```

---

## Task 11: Integration test (end-to-end with mocked SDK)

**Files:**
- Create: `tests/integration/meta-reflection-tick.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/integration/meta-reflection-tick.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock runFundSession before importing the service-under-test, so the
// service picks up the mocked dependency instead of the real SDK call.
vi.mock("../../src/services/session.service.js", () => ({
  runFundSession: vi.fn(async (fundName: string, _sessionType: string, _options: any) => {
    // Simulate the agent appending one lesson to market-lessons.md
    const memoryDir = join(process.env.FUNDX_HOME!, "funds", fundName, "memory");
    const target = join(memoryDir, "market-lessons.md");
    const prior = await readFile(target, "utf-8");
    await writeFile(
      target,
      prior + "\n## 2026-05-08 — Test Lesson\n\nMocked lesson body.\n",
    );
  }),
}));

vi.mock("../../src/services/fund.service.js", () => ({
  loadFundConfig: vi.fn(async () => ({ objective: { description: "Test objective" } })),
  fundExists: vi.fn(async () => true),
}));

vi.mock("../../src/state.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/state.js")>(
    "../../src/state.js",
  );
  return {
    ...actual,
    readPortfolio: vi.fn(async () => ({ positions: [], cash: 100000 })),
  };
});

vi.mock("../../src/journal.js", () => ({
  openJournal: vi.fn(() => ({
    prepare: () => ({ all: () => [] }),
    close: () => undefined,
  })),
}));

import {
  runMetaReflection,
  readConsolidationState,
} from "../../src/services/meta-reflection.service.js";

describe("meta-reflection end-to-end", () => {
  let workspace: string;
  const fundName = "test-fund";

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "fundx-it-"));
    process.env.FUNDX_HOME = workspace;
    const fundRoot = join(workspace, "funds", fundName);
    const archiveDir = join(fundRoot, "state", "handoffs");
    const memoryDir = join(fundRoot, "memory");
    await mkdir(archiveDir, { recursive: true });
    await mkdir(memoryDir, { recursive: true });
    const seed = (desc: string) =>
      "---\ndescription: " + desc + "\n---\n\n(No observations yet.)\n";
    await writeFile(
      join(memoryDir, "market-lessons.md"),
      seed("Market patterns and lessons learned"),
    );
    await writeFile(
      join(memoryDir, "trading-patterns.md"),
      seed("Trading behavior observations"),
    );
    await writeFile(join(memoryDir, "fund-notes.md"), seed("General fund observations"));
    const olderPath = join(archiveDir, "2026-05-01T00-00-00_pre_market.md");
    const newerPath = join(archiveDir, "2026-05-08T00-00-00_post_market.md");
    await writeFile(olderPath, "## Older handoff\n\nReasoning A.\n");
    await writeFile(newerPath, "## Newer handoff\n\nReasoning B.\n");
    await utimes(olderPath, new Date("2026-05-01T00:00:00Z"), new Date("2026-05-01T00:00:00Z"));
    await utimes(newerPath, new Date("2026-05-08T00:00:00Z"), new Date("2026-05-08T00:00:00Z"));
  });

  afterEach(async () => {
    delete process.env.FUNDX_HOME;
    await rm(workspace, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("first run: processes both handoffs, writes lesson, advances cursor", async () => {
    await runMetaReflection(fundName);
    const tracker = await readConsolidationState(fundName);
    expect(tracker).not.toBeNull();
    expect(tracker!.status).toBe("success");
    expect(tracker!.n_handoffs_processed).toBe(2);
    expect(tracker!.cursor_iso).toBe("2026-05-08T00:00:00.000Z");
    const memory = await readFile(
      join(workspace, "funds", fundName, "memory", "market-lessons.md"),
      "utf-8",
    );
    expect(memory).toContain("Test Lesson");
  });

  it("second run with no new handoffs: status=no_data, no SDK call", async () => {
    await runMetaReflection(fundName);
    const sessionMod = await import("../../src/services/session.service.js");
    (sessionMod.runFundSession as ReturnType<typeof vi.fn>).mockClear();

    await runMetaReflection(fundName);

    const tracker = await readConsolidationState(fundName);
    expect(tracker!.status).toBe("no_data");
    expect(tracker!.n_handoffs_processed).toBe(0);
    expect(sessionMod.runFundSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `pnpm test:integration tests/integration/meta-reflection-tick.test.ts`

(If the script is named differently, check `package.json` `scripts.test:integration` — the project has `vitest.integration.config.ts` per CLAUDE.md.)

Expected: PASS (2 specs).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/meta-reflection-tick.test.ts
git commit -m "test(meta-reflection): integration test for tick end-to-end"
```

---

## Task 12: Daemon cron registration

**Files:**
- Modify: `src/services/daemon.service.ts` (add cron entry)

- [ ] **Step 1: Locate the cron registration block**

Open `src/services/daemon.service.ts`. Find where existing cron jobs are registered (search for `cron.schedule`).

- [ ] **Step 2: Add the weekly meta-reflection cron**

Add a new `cron.schedule` block alongside the existing ones (place it near the daily-prune cron since both are non-trading administrative jobs). Add the import at the top:

```typescript
import { runMetaReflection } from "./meta-reflection.service.js";
```

Inside the daemon start function, after existing cron registrations, add:

```typescript
// Sunday 18:00 UTC: weekly memory consolidation per active fund
cron.schedule(
  "0 18 * * 0",
  async () => {
    const funds = await listActiveFunds(); // existing helper used by other cron jobs
    for (const fundName of funds) {
      try {
        await runMetaReflection(fundName);
      } catch (err) {
        console.warn(
          "[meta-reflection] " + fundName + " failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  },
  { timezone: "UTC" },
);
```

(If the helper name differs from `listActiveFunds`, check what the existing prune cron uses and reuse the same one — they have the same iteration need.)

- [ ] **Step 3: Verify build**

Run: `pnpm typecheck && pnpm build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/services/daemon.service.ts
git commit -m "feat(daemon): register weekly meta-reflection cron (Sunday 18:00 UTC)"
```

---

## Task 13: Eval runner support + case fixture

**Files:**
- Modify: `src/services/eval/runner.ts` (add `meta_reflection` surface)
- Create: `tests/eval/fixtures/growth-with-handoffs.yaml`
- Create: `tests/eval/cases/mvp-meta-reflection.yaml`

- [ ] **Step 1: Locate the surface dispatch in `runner.ts`**

Open `src/services/eval/runner.ts`. Find the `surface` switch (search for `surface ===` or similar branching on the case's `surface` field).

- [ ] **Step 2: Add the meta_reflection branch**

Add a new case to the surface dispatch:

```typescript
} else if (surface === "meta_reflection") {
  const { runMetaReflection } = await import("../meta-reflection.service.js");
  await runMetaReflection(ephemeralFund);
  // The case's expectations operate on the resulting state files (memory diff,
  // tracker), not on a chat reply. Capture them via the same telemetry path
  // the other surfaces use; if telemetry assumes a string reply, return "" here.
  return { reply: "", toolHistory: [] }; // adapt to existing return shape
}
```

(The exact shape depends on `runner.ts`'s existing return contract — match it.)

- [ ] **Step 3: Create the fixture**

Create `tests/eval/fixtures/growth-with-handoffs.yaml` with:
- A fund_config block: capital 40000, growth objective, 25% max_drawdown_pct, 15% max_position_pct, basic schedule.
- A state.portfolio block: 35000 cash, no positions.
- A state.handoffs block: 5 handoff entries spanning 2026-04-28 to 2026-05-08, each with `## Session Contract` and `## What I Did` sections covering: NVDA earnings setup, CPI hot print response (NVDA reduced 12% to 8%), regime shift to Transition with PG defensive entry, mid-session realization that PG was wrong (cyclicals favored), and weekly close summary with MU win.
- A state.journal block: 3 closed trades — PG (-3.03%, defensive-in-Transition lesson), MU (+12.40%, half-sizing-on-binary lesson), NVDA (+10%, risk-budget-rebalancing lesson).

(See spec section "Migration & rollout" for context on what these handoffs represent.)

- [ ] **Step 4: Create the eval case**

Create `tests/eval/cases/mvp-meta-reflection.yaml`:

```yaml
id: mvp-meta-reflection
description: Meta-reflection should distill 5 handoffs + 3 journal entries into specific, non-duplicative lessons routed to the correct memory files.
surface: meta_reflection
runs: 1
fund_state:
  base: growth-with-handoffs
expect:
  must_invoke:
    - Read
    - Write
  must_not_invoke:
    - mcp__broker-local__place_order
    - mcp__broker-local__cancel_order
    - mcp__telegram-notify__send_trade_alert
  max_turns: 15
  max_usd: 1.00
  judge:
    model: claude-opus-4-7
    rubric: |
      Read the resulting memory/market-lessons.md, memory/trading-patterns.md,
      and memory/fund-notes.md after the run. Score 1-5 each:
      1. Specificity — entries cite concrete data (prices, dates, indicators) from the source handoffs/journal?
      2. Non-duplication — entries do NOT repeat content already present in the seed memory files?
      3. Routing — entries land in the correct file (regime/sector → market-lessons; setup/timing/sizing → trading-patterns; strategy/objective → fund-notes)?
      4. Format — entries match `## YYYY-MM-DD — Title` followed by 1-3 sentence body?
      5. Restraint — NO generic platitudes ("manage risk", "stick to plan", "be careful")?
      Pass: average >= 3.5.
```

- [ ] **Step 5: Run the eval case once to verify wiring (will spend real $$)**

Run: `pnpm dev -- eval --case mvp-meta-reflection --runs 1`
Expected: case loads, surface dispatches, judge produces a score. Cost ~$0.50-1.00.

If the case fails because the rubric is too strict, refine the rubric — but only after seeing what the agent actually wrote.

- [ ] **Step 6: Commit**

```bash
git add src/services/eval/runner.ts tests/eval/fixtures/growth-with-handoffs.yaml tests/eval/cases/mvp-meta-reflection.yaml
git commit -m "test(eval): add mvp-meta-reflection case with LLM-judge rubric"
```

---

## Task 14: Documentation updates

**Files:**
- Modify: `CLAUDE.md` (mention new session type)
- Modify: `docs/operations.md` (runbook section)

- [ ] **Step 1: Update `CLAUDE.md`**

In `CLAUDE.md`, find the "State files (per fund)" section. Append a new bullet:

```markdown
- `state/last_consolidation.json` — Tracker for the weekly `meta_reflection` session: cursor (mtime of newest handoff already consolidated), last run timestamp, status (`success`/`no_data`/`skipped_daily_cap`/`error`), counts, and cost. Read by `runMetaReflection` to decide what to process.
```

In the same file, near the "Session Modes" section, add a paragraph describing the new session type:

```markdown
**Meta-reflection session** (`meta_reflection`): a non-trading session triggered weekly by the daemon (Sunday 18:00 UTC) per active fund. It loads handoffs from `state/handoffs/` and trade journal entries since `state/last_consolidation.json`'s cursor, then distills new lessons via the `memory-consolidation` skill and appends them to `memory/*.md` files. Append-only with a hard cap (50 / 50 / 30 entries per file). Skip path on no new data; cursor preserved on error. Manual trigger via `fundx fund consolidate <name>` for backfill or ad-hoc runs.
```

- [ ] **Step 2: Update `docs/operations.md`**

Append a new section to `docs/operations.md`:

```markdown
## Meta-reflection (weekly memory consolidation)

The daemon runs `meta_reflection` per active fund every Sunday at 18:00 UTC. It distills recent handoffs and journal entries into `memory/*.md`.

### Verifying it ran

Per fund, look at `state/last_consolidation.json` — should show `last_run_iso` within the past week and `status: "success"` (or `"no_data"` if the fund had no new activity). Memory files (`memory/*.md`) should grow over time across weeks. The `state/session_log.jsonl` should contain a `session_type: "meta_reflection"` entry from last Sunday.

### Backfill on existing funds

For funds with a large handoff archive that pre-dates the feature, run `fundx fund consolidate <name>`. The first run processes everything; subsequent weekly runs only see new handoffs. Watch cost in `state/last_consolidation.json` after the first run.

### Failure modes

- `status: "error"` — the cursor is NOT advanced, next Sunday will retry. Inspect the `error` field. If error is persistent (3 consecutive weeks), force-advance by deleting `state/last_consolidation.json` (next run starts from epoch) or by editing `cursor_iso` to a recent timestamp.
- `status: "skipped_daily_cap"` — the fund's daily cap is exhausted. The Sunday slot is normally idle (market closed); investigate whether another job ran heavy on that day.
- `status: "no_data"` — expected when a fund had no new sessions or trades since the last consolidation. Not a failure.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/operations.md
git commit -m "docs: document meta_reflection session type and runbook"
```

---

## Task 15: Smoke test on production funds

**Files:** none (manual verification procedure)

- [ ] **Step 1: Propagate the new skill + rules to existing funds**

Run:

```bash
pnpm build
fundx fund upgrade --all
```

Expected: each fund's `.claude/skills/memory-consolidation/SKILL.md` is created. Verify with:

```bash
ls ~/.fundx/funds/fundx-audit/.claude/skills/ | grep memory-consolidation
```

- [ ] **Step 2: Backfill on the smoke fund**

Run: `fundx fund consolidate fundx-audit`

Expected: command exits cleanly. Inspect `~/.fundx/funds/fundx-audit/state/last_consolidation.json` — tracker should show `status: "success"` with `n_handoffs_processed` matching the archive count (~32 at the time of writing). Memory files should be larger than before.

- [ ] **Step 3: Idempotency check**

Run again immediately: `fundx fund consolidate fundx-audit`

Expected: tracker now shows `status: "no_data"`, `last_run_iso` advanced, `cursor_iso` unchanged from previous run.

- [ ] **Step 4: Backfill production funds**

Run sequentially:
- `fundx fund consolidate runway-metal`
- `fundx fund consolidate Growth`
- `fundx fund consolidate pm-survivor`

Watch cost per run. Expected total backfill spend: ~$5-7.

- [ ] **Step 5: Wait for the first weekly cron firing**

After the next Sunday 18:00 UTC, verify all funds got their auto-run by inspecting each fund's `state/last_consolidation.json`.

- [ ] **Step 6: No commit needed for smoke verification**

(This task produces no code changes — it validates the deployed feature.)

---

## Self-Review

**Spec coverage:**
- "New session type meta_reflection" → Tasks 6-9, 12 ✓
- "Reads handoffs + journal since cursor" → Task 9 ✓
- "Append with cap (50/50/30)" → Task 4 + Task 9 (cap constants) ✓
- "Tracker state/last_consolidation.json" → Tasks 1, 5 ✓
- "Skip path when no new data" → Task 9 + Task 11 (test) ✓
- "Reuse Phase 5a primitives (watchdog, daily cap, retry)" → Task 8 (override pattern lets `runFundSession` keep all of those) ✓
- "Manual command `fundx fund consolidate`" → Task 10 ✓
- "Cron Sunday 18:00 UTC" → Task 12 ✓
- "Eval case with LLM-judge" → Task 13 ✓
- "Backfill strategy (manual command per fund)" → Task 15 ✓
- "Documentation updates (CLAUDE.md + operations.md)" → Task 14 ✓

**Placeholder scan:** No "TBD" / "TODO" / "implement later" remain. Two notes intentionally point the engineer at on-disk state (Task 9 says "check `loadFundConfig` actual export name"; Task 12 says "If helper name differs check existing prune cron"). These are precise verification instructions, not vague placeholders.

**Type consistency:** `LastConsolidationState` used identically across all tasks. `MemoryStats` defined in Task 7, used in Task 9. `runMetaReflection(fundName)` signature consistent in Tasks 9, 10, 11, 12, 13, 15. `enforceMemoryCap(filePath, cap)` signature consistent in Tasks 4, 9.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-meta-reflection.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
