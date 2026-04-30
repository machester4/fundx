# Phase 3a — Handoff Archive + Stop Hook (G4 v1)

**Date:** 2026-04-30
**Status:** Approved (design)
**Roadmap:** [harness-hardening-roadmap](./2026-04-27-harness-hardening-roadmap.md)
**Closes gap:** G4 (partial — v1 minimal scope) — handoff has no history preservation; sessions can end without writing handoff and go undetected
**Pattern enforced:** #1 (structured handoff with size discipline) + operational observability for missing handoffs

> **Scope split decision (2026-04-30):** Phase 3 from the roadmap covered both G4 (handoff size cap) and G5 (LLM-judge eval grader). After brainstorming, these were split into Phase 3a (this spec — G4) and Phase 3b (G5). Reasons: (1) G4 affects production session flow with concrete urgency (handoff history not preserved today); (2) G5 affects test harness only and benefits from its own brainstorm focused on rubric design.

> **Scope tightening (2026-04-30):** The original Phase 3 stub for G4 listed three sub-features — JSON-validated section, archive rotation, Stop hook. After Phase 2 shipped per-section snapshot clipping (in `snapshot.service.ts`), oversized handoffs no longer break the next session's context. The remaining urgency is **history preservation** (no audit trail today) and **missing-handoff detection** (silent gap risk). The JSON section was dropped per YAGNI — no downstream consumer exists today. Phase 3a v1 ships archive + Stop hook only.

---

## Goal

Two complementary additions to `runFundSession`:

- **Archive rotation.** Before each autonomous session, copy the existing `state/session-handoff.md` to `state/handoffs/<iso-ts>_<session-type>.md`. Result: every session's handoff is preserved on disk, providing a complete audit trail for debugging, performance analysis, and historical context.

- **Stop hook for handoff verification.** Register an SDK `Stop` hook that, when the session is about to end, checks whether the handoff file's mtime is later than the session start time. If not, the session ended without writing a handoff — flag this in the session log (`handoff_written: false`) and surface a Telegram alert when the SDK status is `success` (the suspicious combo: agent thought it was done but skipped reflection).

The Stop hook does NOT block — it observes and reports. Per the Phase 2 pattern of "hard gates for mutations, observe + alert for non-mutations".

## Non-goals

- **JSON-validated handoff section** (`next_session_should[]`, `open_concerns[]`, `deferred_decisions[]`). Dropped per YAGNI — no downstream consumer today. Revisit if Phase 4 reports need parseable handoff structure.
- **Block-on-missing-handoff.** Stop hook only logs + flags; does not force agent to retry. The operator decides what to do with the flag.
- **Archive cleanup / retention.** Storage cost is trivial (~80MB/year/fund max). Cleanup deferred to Phase 4 (operational observability) if it ever becomes a problem.
- **Changes to the `Session Reflection` skill prompt.** No prompt changes — the skill already produces the right format. We just preserve and verify post-write.
- **Snapshot pre-population changes.** Phase 2's snapshot clipping at 8KB stays as the in-context size discipline.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  runFundSession (autonomous session)                            │
│                                                                  │
│  1. Resolve budget (Phase 1a)                                   │
│  2. ★ Archive existing handoff if present  ◀─── NEW (G4)        │
│       cp state/session-handoff.md → state/handoffs/<ts>_<type>.md│
│  3. Build state snapshot (Phase 2)                              │
│  4. Build prompt (Phase 2)                                      │
│  5. Instantiate VerdictTracker (Phase 2) +                      │
│     ★ HandoffTracker (Phase 3a)                          ◀─ NEW │
│  6. runAgentQuery({                                             │
│       ...,                                                       │
│       hooks: { PreToolUse: [...], ★ Stop: [...]  ◀─ NEW         │
│     })                                                           │
│  7. Persist session log + budget alert (Phase 1a) +             │
│     ★ handoff_written field (Phase 3a)                  ◀─ NEW  │
│  8. ★ Telegram alert if success && !handoff_written      ◀─ NEW │
└────────────────────────────────────────────────────────────────┘
```

---

## Component 1 — `archiveHandoffIfExists`

**Location:** `src/services/handoff-archive.service.ts` (new)

**Signature:**

```typescript
export async function archiveHandoffIfExists(
  fundName: string,
  sessionType: string,
): Promise<string | null>
```

**Behavior:**

1. Read `state/session-handoff.md` via `fs.readFile`.
   - On ENOENT → return `null` (first session, nothing to archive).
   - On other read errors → log warning, return `null` (never throws).
2. Generate filename: `<iso-ts>_<session-type>.md` with colons replaced by dashes for shell-friendliness.
   - Example: `2026-04-30T18-29-01_pre_market.md`
3. Ensure `state/handoffs/` exists via `fs.mkdir({ recursive: true })`.
4. Write the handoff content to `state/handoffs/<filename>`. Use `fs.writeFile` (not `fs.copyFile`) since we already have the content from step 1.
5. Return the absolute path of the archive file.

**Robustness:** function never throws. All I/O wrapped in try/catch with warning logs.

---

## Component 2 — `HandoffTracker`

**Location:** `src/services/handoff-tracker.ts` (new)

**Class:**

```typescript
import { statSync } from "node:fs";

export class HandoffTracker {
  handoffWritten: boolean = false;

  constructor(
    private readonly handoffPath: string,
    private readonly sessionStartedAtMs: number,
  ) {}

  /** Check if handoff file mtime is later than session start.
   *  Called from Stop hook callback. Updates handoffWritten as side effect.
   *  Pure (sync filesystem stat); no async I/O. */
  checkOnStop(): { written: boolean } {
    try {
      const stat = statSync(this.handoffPath);
      this.handoffWritten = stat.mtimeMs > this.sessionStartedAtMs;
    } catch {
      // ENOENT or permission error → counts as not written
      this.handoffWritten = false;
    }
    return { written: this.handoffWritten };
  }
}
```

Pure logic, no I/O beyond a single `statSync`. The `handoffWritten` field is publicly readable so `runFundSession` can pull it after the session ends and write to the log.

---

## Component 3 — `paths.ts` extension

Add a new field to the `state` object returned by `fundPaths`:

```typescript
state: {
  ...,
  handoffsDir: join(root, "state", "handoffs"),
}
```

This gives `archiveHandoffIfExists` and any future caller a canonical location reference. Verify no existing consumer breaks (the additive field shouldn't affect anything).

---

## Component 4 — `sessionLogV2Schema` extension

Add to `src/types.ts`:

```typescript
handoff_written: z.boolean().optional(),
```

Optional for back-compat — old logs without the field continue to parse. The status enum is **NOT** modified; `handoff_written: false` is an orthogonal signal to `status: "success"`.

---

## Component 5 — Extend `buildTrackerHookOptions`

In `src/services/session.service.ts`, the existing helper extracted in Phase 2 polish needs to accept an optional `HandoffTracker`:

```typescript
function buildTrackerHookOptions(
  verdictTracker: VerdictTracker,
  handoffTracker?: HandoffTracker,
) {
  return {
    onMessage: (msg) => verdictTracker.observe(msg),
    hooks: {
      PreToolUse: [
        // ... existing place_order gate (unchanged)
      ],
      ...(handoffTracker ? {
        Stop: [{
          hooks: [
            async () => {
              const { written } = handoffTracker.checkOnStop();
              if (!written) {
                console.warn(`[stop-hook] handoff not written this session — flagged in session_log`);
              }
              return {}; // approve (don't block; just observe)
            },
          ],
        }],
      } : {}),
    },
  } as const;
}
```

The `Stop` hook block is conditionally added so the helper signature is back-compat (eval/test paths that don't pass a HandoffTracker continue to work).

---

## Component 6 — Wire into `runFundSession`

Before the existing snapshot/prompt build:

```typescript
// Step 1: archive previous handoff (no-op on first session)
const archivedPath = await archiveHandoffIfExists(fundName, sessionType);
if (archivedPath) {
  console.log(`[handoff-archive] archived to ${archivedPath}`);
}
```

Before the runAgentQuery calls:

```typescript
const startedAtMs = Date.now();
const startedAt = new Date(startedAtMs).toISOString();  // existing line, just refactored

// existing:
const verdictTracker = new VerdictTracker();
// new:
const handoffTracker = new HandoffTracker(paths.state.sessionHandoff, startedAtMs);

// Both runAgentQuery calls receive both trackers via helper:
result = await runAgentQuery({
  ...,
  ...buildTrackerHookOptions(verdictTracker, handoffTracker),
});
```

After the session log is built:

```typescript
const log: SessionLogV2 = {
  ...,
  handoff_written: handoffTracker.handoffWritten,
};
```

After the existing notify path of completion:

```typescript
if (log.handoff_written === false && log.status === "success") {
  await notifySession(
    `⚠️ <b>${displayName}</b> — ${sessionType} ended successfully but did NOT write a handoff. Next session will read stale state.`,
  );
}
```

---

## Definition of Done

### Unit-test level

1. **`tests/handoff-archive.test.ts`** (~6 tests):
   - Returns `null` when no source handoff exists (first session)
   - Copies handoff content to `state/handoffs/<ts>_<type>.md`
   - Original file unchanged after archive
   - Filename uses dashes for colons in ISO timestamp
   - Creates `state/handoffs/` directory if missing
   - Returns `null` on permission/read errors (logs warning, doesn't throw)

2. **`tests/handoff-tracker.test.ts`** (~5 tests):
   - `checkOnStop` returns `written: true` when file mtime > sessionStartedAt
   - `checkOnStop` returns `written: false` when file missing (ENOENT)
   - `checkOnStop` returns `written: false` when mtime < sessionStartedAt (stale handoff)
   - `handoffWritten` field updated as side effect after `checkOnStop`
   - Constructor stores path + start time correctly

3. **`tests/session.test.ts`** (~3 new assertions):
   - `runFundSession` instantiates `HandoffTracker`
   - Both `runAgentQuery` calls receive `Stop` hook in `hooks.Stop`
   - Session log includes `handoff_written` field after completion

4. **Existing tests still green** (`pnpm test`).

### Integration level

5. **Smoke test 1: Normal session on `fundx-audit`** — verify:
   - Archive created at `state/handoffs/<ts>_pre_market.md` matching previous handoff bytes
   - Session writes new handoff (overwrites canonical)
   - `session_log.json` shows `handoff_written: true`
   - No Telegram warning alert

6. **Smoke test 2: Session that skips reflection** — set focus to "answer the orient question briefly without invoking session-reflection skill":
   - Session ends with `status: "success"` but `handoff_written: false`
   - Telegram warning alert received
   - `daemon.log` shows `[stop-hook] handoff not written this session`
   - Next session reads stale handoff (snapshot pre-population still works — verified by next session running normally)

7. **MVP eval suite passes** (`pnpm dev -- eval --filter mvp-`) — eval cases use `runAsk`/`runChatTurn` (not `runFundSession`), should be unaffected.

### Documentation

8. `CLAUDE.md` "Configuration" section gets a one-line mention of handoff archive + Stop hook.
9. Roadmap status log entry: "Phase 3a complete: handoff archive + Stop hook for handoff verification."

---

## Risks

| Risk | Mitigation |
|---|---|
| Archive disk usage grows unbounded | ~80MB/year/fund max — trivial. Cleanup deferred to Phase 4. |
| Archive on every session adds latency at start | `fs.writeFile` of <15KB content is sub-millisecond. Imperceptible. |
| Stop hook fires multiple times per session | `checkOnStop` is idempotent — repeated invocations return same result. |
| Stop hook receives unexpected SDK input shape | Hook callback ignores input arg; only reads tracker state. SDK shape changes don't break it. |
| `handoff_written: false` causes false Telegram alerts | Alert gated on `status === "success"` — error/timeout sessions don't trigger duplicate alerts. |
| Race condition: archive happens while previous session still writing | Daemon ensures one session per fund at a time (existing lock file). No race. |
| `mtimeMs` granularity on macOS HFS+ is 1 second — could cause false negatives if session very fast | Sessions take many seconds at minimum (LLM round-trips). 1-second granularity is safe. |
| Handoff is overwritten DURING session (not at end) and `mtimeMs > sessionStartedAt` regardless of whether actual content changed | Acceptable — if the agent wrote ANYTHING during the session, that counts as "engaged with reflection". The risk is the rare case where agent writes a placeholder mid-session and never finishes — log shows `handoff_written: true` but content is incomplete. Phase 4 could add a content-quality check via the LLM-judge (G5) but Phase 3a doesn't. |

---

## Effort

**~2 days** distributed:

| Component | Days |
|---|---:|
| `archiveHandoffIfExists` + 6 unit tests | 0.5 |
| `HandoffTracker` + 5 unit tests | 0.25 |
| `paths.ts` `handoffsDir` field | 0.1 |
| `sessionLogV2Schema.handoff_written` | 0.1 |
| Wire into `runFundSession` (extend helper, archive call, tracker, log field, alert) + 3 session.test.ts assertions | 0.5 |
| 2 smoke tests + MVP eval | 0.3 |
| Docs + roadmap | 0.15 |
| **Total** | **~2** |

## Cost expectation

| Item | Cost |
|---|---:|
| 2 smoke tests on `fundx-audit` (~$2-4 each) | $4-8 |
| MVP eval re-run | ~$3 |
| Possible re-runs / debugging | $2-5 |
| **Total expected** | **$9-16** |

---

## Implementation order (TDD bite-sized for `writing-plans`)

1. **`archiveHandoffIfExists` helper** (TDD, isolated). Test → impl → commit.
2. **`HandoffTracker` class** (TDD, isolated). Test → impl → commit.
3. **`paths.ts` `handoffsDir` field** + verify no existing consumer breaks. Commit.
4. **`sessionLogV2Schema.handoff_written` extension** + back-compat test. Commit.
5. **Extend `buildTrackerHookOptions` + wire all into `runFundSession`** + Telegram alert branch + session.test.ts updates. Commit.
6. **2 smoke tests + MVP eval** on `fundx-audit`. Audit log entry. Commit.
7. **Docs + roadmap status log**. Commit.

7 commits total.
