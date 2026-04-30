# Phase 3a — Handoff Archive + Stop Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two coordinated additions to `runFundSession` — (1) archive every previous handoff to `state/handoffs/<iso-ts>_<session-type>.md` before each session starts (history preservation), and (2) register an SDK `Stop` hook that flags `handoff_written: false` in the session log when the agent ends without modifying `state/session-handoff.md`. The Stop hook does NOT block; it observes and surfaces a Telegram alert when `status === "success" && !handoff_written` (the suspicious combo).

**Architecture:** Two small new modules (`handoff-archive.service.ts`, `handoff-tracker.ts`) + one path field (`state.handoffsDir`) + one schema field (`sessionLogV2Schema.handoff_written`) + extension to the existing `buildTrackerHookOptions` helper (extracted in Phase 2 polish at `src/services/session.service.ts:35`) to optionally accept a `HandoffTracker`. Wire-in within `runFundSession` is small and surgical.

**Tech Stack:** TypeScript (strict ESM), Vitest (test framework), pnpm. Tests in `tests/`, source in `src/`. Imports use `.js` extension for ESM compat.

**Spec:** [`docs/superpowers/specs/2026-04-30-harness-phase-3a-handoff-design.md`](../specs/2026-04-30-harness-phase-3a-handoff-design.md)

---

## File Structure

| Path | Type | Responsibility |
|---|---|---|
| `src/services/handoff-archive.service.ts` | Create | `archiveHandoffIfExists(fundName, sessionType): Promise<string \| null>` — pure async helper. |
| `src/services/handoff-tracker.ts` | Create | `HandoffTracker` class — `checkOnStop()` returns whether handoff mtime > sessionStartedAt. |
| `src/paths.ts` | Modify | Add `handoffsDir` field to `state` object in `fundPaths` return. |
| `src/types.ts` | Modify | Add `handoff_written: z.boolean().optional()` to `sessionLogV2Schema`. |
| `src/services/session.service.ts` | Modify | Extend `buildTrackerHookOptions` to accept optional `HandoffTracker`; wire archive + tracker + Stop hook + handoff_written log + Telegram alert into `runFundSession`. |
| `tests/handoff-archive.test.ts` | Create | ~6 unit tests for archive helper. |
| `tests/handoff-tracker.test.ts` | Create | ~5 unit tests for HandoffTracker. |
| `tests/session.test.ts` | Modify | ~3 new assertions (HandoffTracker mocked + instantiated + Stop hook present + log field set). |
| `CLAUDE.md` | Modify | One-line mention in "Configuration" section. |

---

## Task 1: `archiveHandoffIfExists` helper

**Files:**
- Create: `src/services/handoff-archive.service.ts`
- Create: `tests/handoff-archive.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/handoff-archive.test.ts`:

```typescript
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
    // The timestamp portion must not contain colons
    const filename = result!.split("/").pop()!;
    expect(filename).not.toContain(":");
    // It should still be ISO-like with T separator
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_pre_market\.md$/);
  });

  it("creates state/handoffs/ directory if missing", async () => {
    await seedHandoff("f4", "x");
    // Verify state/handoffs/ does not exist before
    await expect(
      stat(join(tmpRoot, "funds", "f4", "state", "handoffs")),
    ).rejects.toThrow();
    await archiveHandoffIfExists("f4", "post_market");
    // Verify it exists after
    const dirStat = await stat(join(tmpRoot, "funds", "f4", "state", "handoffs"));
    expect(dirStat.isDirectory()).toBe(true);
  });

  it("returns null on permission/read errors (no throw)", async () => {
    // Seed a handoff then make it unreadable by simulating via a path that doesn't resolve
    // Easier: pass a fund whose handoff path leads to a directory (read fails)
    const stateDir = join(tmpRoot, "funds", "f5", "state");
    await mkdir(stateDir, { recursive: true });
    // Create session-handoff.md as a directory instead of file
    await mkdir(join(stateDir, "session-handoff.md"), { recursive: true });
    const result = await archiveHandoffIfExists("f5", "pre_market");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/handoff-archive.test.ts`
Expected: FAIL with "Cannot find module '../src/services/handoff-archive.service.js'".

- [ ] **Step 3: Add `handoffsDir` to `paths.ts` first** (required by the test mock and the implementation)

In `src/paths.ts`, find the `state:` object inside `fundPaths` (around line 118). Add this line at the end of the `state` object literal, just before the closing `}`:

```typescript
      handoffsDir: join(root, "state", "handoffs"),
```

So the state object now ends with:
```typescript
      universe: join(root, "state", "universe.json"),
      handoffsDir: join(root, "state", "handoffs"),
    },
```

- [ ] **Step 4: Implement `archiveHandoffIfExists`**

Create `src/services/handoff-archive.service.ts`:

```typescript
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- tests/handoff-archive.test.ts`
Expected: PASS — 6 tests green.

- [ ] **Step 6: Run full test suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: full suite green, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/paths.ts src/services/handoff-archive.service.ts tests/handoff-archive.test.ts
git commit -m "feat(handoff): archive previous handoff to state/handoffs/<ts>_<type>.md before each session"
```

---

## Task 2: `HandoffTracker` class

**Files:**
- Create: `src/services/handoff-tracker.ts`
- Create: `tests/handoff-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/handoff-tracker.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { writeFile, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffTracker } from "../src/services/handoff-tracker.js";

const tmpDir = join(tmpdir(), `handoff-tracker-test-${Date.now()}`);

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
});

describe("HandoffTracker", () => {
  it("checkOnStop returns written:true when file mtime > sessionStartedAt", async () => {
    const handoffPath = join(tmpDir, "handoff.md");
    const startedAtMs = Date.now() - 10_000; // 10 seconds ago
    await writeFile(handoffPath, "fresh content", "utf-8");
    // mtime is now (more recent than startedAtMs)
    const tracker = new HandoffTracker(handoffPath, startedAtMs);
    const out = tracker.checkOnStop();
    expect(out.written).toBe(true);
    expect(tracker.handoffWritten).toBe(true);
  });

  it("checkOnStop returns written:false when file is missing (ENOENT)", () => {
    const handoffPath = join(tmpDir, "nonexistent.md");
    const tracker = new HandoffTracker(handoffPath, Date.now());
    const out = tracker.checkOnStop();
    expect(out.written).toBe(false);
    expect(tracker.handoffWritten).toBe(false);
  });

  it("checkOnStop returns written:false when mtime < sessionStartedAt (stale handoff)", async () => {
    const handoffPath = join(tmpDir, "stale.md");
    await writeFile(handoffPath, "old content", "utf-8");
    // Force mtime to be in the past
    const pastSec = Math.floor((Date.now() - 60_000) / 1000); // 60s ago
    await utimes(handoffPath, pastSec, pastSec);
    const startedAtMs = Date.now(); // started AFTER the file's mtime
    const tracker = new HandoffTracker(handoffPath, startedAtMs);
    const out = tracker.checkOnStop();
    expect(out.written).toBe(false);
  });

  it("handoffWritten field is updated as side effect of checkOnStop", async () => {
    const handoffPath = join(tmpDir, "h.md");
    await writeFile(handoffPath, "x", "utf-8");
    const tracker = new HandoffTracker(handoffPath, Date.now() - 5000);
    expect(tracker.handoffWritten).toBe(false); // initial
    tracker.checkOnStop();
    expect(tracker.handoffWritten).toBe(true); // post-call
  });

  it("constructor stores path and start time", () => {
    const tracker = new HandoffTracker("/some/path", 12345);
    // Internal fields are private; verify by behavior
    const out = tracker.checkOnStop();
    expect(out.written).toBe(false); // path doesn't exist → false (proves stat was attempted)
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/handoff-tracker.test.ts`
Expected: FAIL with "Cannot find module '../src/services/handoff-tracker.js'".

- [ ] **Step 3: Implement HandoffTracker**

Create `src/services/handoff-tracker.ts`:

```typescript
import { statSync } from "node:fs";

/** Tracks whether the agent wrote a fresh handoff during the session.
 *  Used by the SDK Stop hook to flag missing handoffs in the session log. */
export class HandoffTracker {
  /** True iff the most recent checkOnStop() found mtime > sessionStartedAtMs.
   *  Read by runFundSession after the session ends to populate session_log. */
  handoffWritten: boolean = false;

  constructor(
    private readonly handoffPath: string,
    private readonly sessionStartedAtMs: number,
  ) {}

  /** Check if the handoff file's mtime is later than the session start time.
   *  Pure logic + single sync stat. Idempotent. Side effect: updates handoffWritten. */
  checkOnStop(): { written: boolean } {
    try {
      const stat = statSync(this.handoffPath);
      this.handoffWritten = stat.mtimeMs > this.sessionStartedAtMs;
    } catch {
      // ENOENT or any read error → not written
      this.handoffWritten = false;
    }
    return { written: this.handoffWritten };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/handoff-tracker.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/services/handoff-tracker.ts tests/handoff-tracker.test.ts
git commit -m "feat(handoff): HandoffTracker class for Stop-hook handoff verification via mtime"
```

---

## Task 3: Add `handoff_written` to `sessionLogV2Schema`

**Files:**
- Modify: `src/types.ts`
- Modify: `tests/budget.test.ts` (extend an existing assertion since it already covers SessionLogV2)

- [ ] **Step 1: Find the `sessionLogV2Schema` definition**

Run: `grep -n "sessionLogV2Schema" /Users/michael/Proyectos/fundx/src/types.ts | head -5`

Note the line range. The schema is built via `sessionLogSchema.extend({...})`.

- [ ] **Step 2: Add the new field**

In `src/types.ts`, find the `.extend({` block for `sessionLogV2Schema`. Add the new field as the last entry inside the extend object (preserving all existing fields):

```typescript
  handoff_written: z.boolean().optional(),
```

For example, if the current schema ends with:
```typescript
    status: z.enum(["success", "error_max_turns", "error_max_budget", "error", "timeout"]).optional(),
    budget_resolved: budgetSchema.optional(),
  });
```

Update to:
```typescript
    status: z.enum(["success", "error_max_turns", "error_max_budget", "error", "timeout"]).optional(),
    budget_resolved: budgetSchema.optional(),
    handoff_written: z.boolean().optional(),
  });
```

- [ ] **Step 3: Add a back-compat unit test in `tests/budget.test.ts`**

Find the existing `describe("sessionLogV2Schema with budget_resolved", ...)` block. After its existing tests, add a new test inside the same describe (so it's grouped with related schema tests):

```typescript
  it("accepts a session log with handoff_written field", () => {
    const out = sessionLogV2Schema.parse({
      fund: "f",
      session_type: "pre_market",
      started_at: "2026-04-30T10:00:00.000Z",
      handoff_written: true,
    });
    expect(out.handoff_written).toBe(true);
  });

  it("accepts a session log without handoff_written (back-compat)", () => {
    const out = sessionLogV2Schema.parse({
      fund: "f",
      session_type: "pre_market",
      started_at: "2026-04-30T10:00:00.000Z",
    });
    expect(out.handoff_written).toBeUndefined();
  });
```

- [ ] **Step 4: Run the budget tests + full suite + typecheck**

Run: `pnpm test -- tests/budget.test.ts && pnpm test && pnpm typecheck`
Expected: PASS, all green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/budget.test.ts
git commit -m "feat(types): add handoff_written field to SessionLogV2 (back-compat optional)"
```

---

## Task 4: Extend `buildTrackerHookOptions` + wire into `runFundSession`

This is the main integration task. It modifies `runFundSession` to wire the archive call (Task 1), the HandoffTracker (Task 2), the Stop hook, the log field (Task 3), and a Telegram alert.

**Files:**
- Modify: `src/services/session.service.ts`
- Modify: `tests/session.test.ts`

- [ ] **Step 1: Verify baseline**

Run: `pnpm test`
Expected: PASS. Note the baseline test count.

- [ ] **Step 2: Add imports to `src/services/session.service.ts`**

At the top of the file (with other service imports), add:

```typescript
import { archiveHandoffIfExists } from "./handoff-archive.service.js";
import { HandoffTracker } from "./handoff-tracker.js";
```

- [ ] **Step 3: Extend `buildTrackerHookOptions` to optionally accept HandoffTracker**

Find the existing helper at line ~35 of `src/services/session.service.ts`:

```typescript
function buildTrackerHookOptions(tracker: VerdictTracker) {
  return {
    onMessage: (msg) => tracker.observe(msg),
    hooks: {
      PreToolUse: [
        // ... existing place_order gate
      ],
    },
  } as const;
}
```

Replace with:

```typescript
function buildTrackerHookOptions(
  verdictTracker: VerdictTracker,
  handoffTracker?: HandoffTracker,
) {
  return {
    onMessage: (msg: import("@anthropic-ai/claude-agent-sdk").SDKMessage) =>
      verdictTracker.observe(msg),
    hooks: {
      PreToolUse: [
        // ... PRESERVE the existing place_order gate exactly as-is
      ],
      ...(handoffTracker
        ? {
            Stop: [
              {
                hooks: [
                  async () => {
                    const { written } = handoffTracker.checkOnStop();
                    if (!written) {
                      console.warn(
                        `[stop-hook] handoff not written this session — flagged in session_log`,
                      );
                    }
                    return {};
                  },
                ],
              },
            ],
          }
        : {}),
    },
  } as const;
}
```

(Preserve the existing PreToolUse block exactly — don't restructure it. Only add the parameter, the conditional `Stop` hook spread, and the explicit type on `onMessage`'s msg parameter.)

- [ ] **Step 4: Wire archive + tracker + log + alert into `runFundSession`**

In `runFundSession`, locate the section right after `loadFundConfig` + `loadGlobalConfig`. Before the `buildStateSnapshot` call (which already exists), add:

```typescript
  // Archive previous handoff to state/handoffs/<ts>_<type>.md (no-op on first session)
  const archivedPath = await archiveHandoffIfExists(fundName, sessionType);
  if (archivedPath) {
    console.log(`[handoff-archive] archived to ${archivedPath}`);
  }
```

Find the existing line `const startedAt = new Date().toISOString();` (somewhere around line 220). Right after it, capture the ms timestamp and create the HandoffTracker:

```typescript
  const startedAtMs = Date.parse(startedAt);
  const handoffTracker = new HandoffTracker(paths.state.sessionHandoff, startedAtMs);
```

(`paths` should already be in scope from earlier in the function via `fundPaths(fundName)`.)

Update both `runAgentQuery` invocations to pass the handoffTracker via the helper. Find the two existing call sites that have:

```typescript
      ...buildTrackerHookOptions(verdictTracker),
```

and replace each with:

```typescript
      ...buildTrackerHookOptions(verdictTracker, handoffTracker),
```

(Apply the change at BOTH call sites — the initial query and the SESSION_EXPIRED retry. Both must receive the Stop hook.)

Find the `const log: SessionLogV2 = {` literal. Add the new field at the end of the literal (just before the closing `};`):

```typescript
    handoff_written: handoffTracker.handoffWritten,
```

Find the existing post-session notify path (around the `buildBudgetAlert` invocation). After the existing budget-kill branch and the normal completion notification, add a new conditional alert:

```typescript
  if (log.handoff_written === false && log.status === "success") {
    await notifySession(
      `⚠️ <b>${displayName}</b> — ${sessionType} ended successfully but did NOT write a handoff. Next session will read stale state.`,
    );
  }
```

(Use `⚠️` for the warning emoji and `—` for the em-dash to keep the source ASCII-safe and consistent with how the file already escapes special chars.)

- [ ] **Step 5: Update `tests/session.test.ts` mocks + assertions**

In `tests/session.test.ts`, near the existing `vi.mock` blocks at the top of the file, add:

```typescript
vi.mock("../src/services/handoff-archive.service.js", () => ({
  archiveHandoffIfExists: vi.fn(async () => "/tmp/mock-archive.md"),
}));

vi.mock("../src/services/handoff-tracker.js", () => ({
  HandoffTracker: vi.fn().mockImplementation(() => ({
    handoffWritten: true, // default to true so existing happy-path tests don't trip the alert
    checkOnStop: vi.fn(() => ({ written: true })),
  })),
}));
```

In the `describe("runFundSession", ...)` block, add three new test assertions:

```typescript
  it("instantiates HandoffTracker and passes Stop hook to runAgentQuery", async () => {
    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.hooks).toBeDefined();
    expect(opts.hooks.Stop).toBeInstanceOf(Array);
    expect(opts.hooks.Stop[0].hooks).toBeInstanceOf(Array);
  });

  it("calls archiveHandoffIfExists with fund name and session type", async () => {
    const { archiveHandoffIfExists } = await import("../src/services/handoff-archive.service.js");
    await runFundSession("test-fund", "pre_market");
    expect(vi.mocked(archiveHandoffIfExists)).toHaveBeenCalledWith("test-fund", "pre_market");
  });

  it("includes handoff_written field in the session log", async () => {
    await runFundSession("test-fund", "pre_market");
    const [, log] = mockWriteSessionLog.mock.calls[0];
    expect(log.handoff_written).toBeDefined();
    expect(typeof log.handoff_written).toBe("boolean");
  });
```

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: full suite green (3 new tests + all prior), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/session.service.ts tests/session.test.ts
git commit -m "feat(session): wire handoff archive + Stop hook + handoff_written log + missing-handoff alert"
```

---

## Task 5: Smoke tests + MVP eval verification

**Files:**
- Manual: 2 paper sessions on `fundx-audit` + MVP eval
- Modify: `docs/superpowers/audit-1b/audit-log.md` (verification ledger entry)

- [ ] **Step 1: Verify daemon is stopped**

Run: `pnpm dev -- status 2>&1 | grep -E "Daemon|Supervisor"`
Expected: both "stopped". If running, stop with `pnpm dev -- stop`.

- [ ] **Step 2: Confirm `fundx-audit` exists with current handoff**

```bash
ls -la ~/.fundx/funds/fundx-audit/state/session-handoff.md 2>&1 | head -2
ls ~/.fundx/funds/fundx-audit/state/handoffs/ 2>&1 | head -3
```

The existing handoff (Phase 2 carryover) should exist. The handoffs/ directory likely doesn't exist yet — that's fine; Task 1 creates it on first archive.

- [ ] **Step 3: Backup the fund's config (consistent with Phase 2 smoke-test pattern)**

```bash
cp ~/.fundx/funds/fundx-audit/fund_config.yaml ~/.fundx/funds/fundx-audit/fund_config.yaml.task5-backup
ls -la ~/.fundx/funds/fundx-audit/fund_config.yaml.task5-backup
```

Backup must exist before proceeding.

- [ ] **Step 4: Smoke test 1 — Normal session with reflection**

Edit `~/.fundx/funds/fundx-audit/fund_config.yaml`'s `pre_market.focus`:

```yaml
      focus: SMOKE-TEST-3a-1 — Run a brief orient + reflection cycle. Read the snapshot. Note any open concerns. Use the session-reflection skill to write a fresh handoff to state/session-handoff.md describing what you reviewed. Do NOT execute any trades.
```

Run:
```bash
pnpm dev -- session run fundx-audit pre_market
```

Verify (in this order):

```bash
# 1. Archive directory was created and contains the previous handoff
ls -la ~/.fundx/funds/fundx-audit/state/handoffs/
# Expect: at least one file matching <ts>_pre_market.md

# 2. New handoff was written (mtime > session start)
stat ~/.fundx/funds/fundx-audit/state/session-handoff.md

# 3. Session log shows handoff_written: true
python3 -c "
import json
with open('/Users/michael/.fundx/funds/fundx-audit/state/session_log.json') as f:
    s = json.load(f)
print(f'cost: \${s[\"cost_usd\"]:.2f} | turns: {s[\"num_turns\"]} | status: {s[\"status\"]}')
print(f'handoff_written: {s.get(\"handoff_written\")}')
"
# Expect: handoff_written: True
```

If `handoff_written` is `false`: investigate. The Telegram alert (if Telegram configured) should NOT have fired.

- [ ] **Step 5: Smoke test 2 — Session that skips reflection**

Edit `~/.fundx/funds/fundx-audit/fund_config.yaml`'s `pre_market.focus`:

```yaml
      focus: SMOKE-TEST-3a-2 — Briefly read the snapshot. Acknowledge the orient state. Do NOT invoke session-reflection skill, do NOT modify state/session-handoff.md. Just write a one-line summary to analysis/2026-04-30_smoke3a-2.md and end. The Stop hook should flag handoff_written=false.
```

Run:
```bash
pnpm dev -- session run fundx-audit pre_market
```

Verify:

```bash
# 1. Archive directory has another file (the post-smoke-1 handoff)
ls -la ~/.fundx/funds/fundx-audit/state/handoffs/

# 2. session-handoff.md mtime is from the PREVIOUS session, not this one
# (proxy check: read it and verify content references the prior session, not smoke-test-3a-2)
head -3 ~/.fundx/funds/fundx-audit/state/session-handoff.md

# 3. Session log shows handoff_written: false
python3 -c "
import json
with open('/Users/michael/.fundx/funds/fundx-audit/state/session_log.json') as f:
    s = json.load(f)
print(f'status: {s[\"status\"]} | handoff_written: {s.get(\"handoff_written\")}')
"
# Expect: status: 'success', handoff_written: False
```

The Telegram warning alert (if Telegram is configured) should have fired with the wording "ended successfully but did NOT write a handoff".

- [ ] **Step 6: Restore config from backup + cleanup**

```bash
cp ~/.fundx/funds/fundx-audit/fund_config.yaml.task5-backup ~/.fundx/funds/fundx-audit/fund_config.yaml
diff ~/.fundx/funds/fundx-audit/fund_config.yaml ~/.fundx/funds/fundx-audit/fund_config.yaml.task5-backup
# Expect: no diff
rm ~/.fundx/funds/fundx-audit/fund_config.yaml.task5-backup
ls ~/.fundx/funds/fundx-audit/fund_config.yaml.task5-backup 2>&1 | head -1
# Expect: "No such file or directory"
```

- [ ] **Step 7: Run MVP eval**

```bash
cd /Users/michael/Proyectos/fundx
pnpm dev -- eval --filter mvp- --json /tmp/phase3a-eval.json
```

Verify all 8 cases PASS:

```bash
python3 -c "
import json
with open('/tmp/phase3a-eval.json') as f:
    data = json.load(f)
print(f'Summary: {data[\"summary\"]}')
print(f'Total cost: \${data[\"total_cost_usd\"]:.2f}')
"
# Expect: cases_passed: 8, cases_failed: 0
```

- [ ] **Step 8: Update audit log**

Append to `docs/superpowers/audit-1b/audit-log.md`:

```markdown

---

## Phase 3a verification — 2026-04-30

| Test | Result | Cost | Notes |
|---|---|---:|---|
| Smoke 1 (normal session, reflection invoked → handoff_written=true) | PASS / FAIL | $X.XX | Archive created at state/handoffs/<ts>_pre_market.md; new handoff written; no warning alert |
| Smoke 2 (session skips reflection → handoff_written=false) | PASS / FAIL | $X.XX | Telegram warning fired; daemon.log has [stop-hook] entry; handoff stale |
| MVP eval suite | 8/8 PASS | ~$3 | No regression |
| **Phase 3a cumulative** | | $XX.XX | |
```

Fill in PASS/FAIL and actual costs.

- [ ] **Step 9: Commit verification log**

```bash
cd /Users/michael/Proyectos/fundx
git add docs/superpowers/audit-1b/audit-log.md
git commit -m "audit(phase-3a): smoke tests + MVP eval verification"
```

---

## Task 6: Documentation + roadmap status

**Files:**
- Modify: `CLAUDE.md` (one-line mention)
- Modify: `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md` (status log)

- [ ] **Step 1: Update CLAUDE.md "Configuration" section**

In `CLAUDE.md`, find the "Configuration" section. After the existing "State pre-population + verdict gate" bullet (added in Phase 2), add:

```markdown
- Handoff archive + verification: every autonomous session archives the previous `state/session-handoff.md` to `state/handoffs/<iso-ts>_<session-type>.md` before starting (full audit trail). An SDK `Stop` hook checks if the agent wrote a fresh handoff (mtime > session start); if not, the session log records `handoff_written: false` and a Telegram warning fires when the SDK status is `success`. See `src/services/handoff-archive.service.ts` and `src/services/handoff-tracker.ts`.
```

- [ ] **Step 2: Update roadmap status log**

In `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md`, find the "Status log" table at the bottom. Append:

```markdown
| 2026-04-30 | Phase 3a complete (G4 v1 minimal): handoff archive (every session preserves prior handoff to `state/handoffs/<ts>_<type>.md`) + SDK `Stop` hook flags `handoff_written: false` in `session_log.json` + Telegram warning when `success && !handoff_written`. New components: `src/services/handoff-archive.service.ts`, `src/services/handoff-tracker.ts`. JSON-validated handoff section dropped per YAGNI (no consumer today). G5 (LLM-judge eval grader) split into Phase 3b. See [phase-3a spec](./2026-04-30-harness-phase-3a-handoff-design.md). |
```

- [ ] **Step 3: Commit docs**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md
git commit -m "docs: phase 3a complete — handoff archive + Stop hook for handoff verification"
```

- [ ] **Step 4: Final test sweep**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS, 0 errors, build succeeds.

---

## Self-Review Checklist (before marking phase complete)

After all 6 tasks complete:

- [ ] `pnpm test` is green (full suite).
- [ ] `pnpm typecheck` is clean.
- [ ] `pnpm build` succeeds.
- [ ] `git log --oneline -10` shows ~7 commits with descriptive messages.
- [ ] Smoke tests 1 and 2 actually ran and produced the expected `handoff_written: true` / `false`.
- [ ] MVP eval 8/8 PASS post-merge.
- [ ] `state/handoffs/` directory exists in `fundx-audit` with at least 2 archived handoffs.
- [ ] `CLAUDE.md` reflects the new mechanism.
- [ ] Roadmap status log has Phase 3a completion entry.
- [ ] Backup config file deleted (no `.task5-backup` artifacts left).

If any item is not true, the phase is **not** done.
