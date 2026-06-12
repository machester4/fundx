# Unfreeze Autonomous Trading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the four stacked failures that keep FundX funds 100% in cash: a brittle execution gate, a sleep-fragile scheduler with no quota handling, a news pipeline that burns the shared subscription quota on false-positive noise ×5 funds, and poisoned per-fund handoff state.

**Architecture:** Surgical fixes inside the existing service layer — no new subsystems. Front 1 hardens `verdict-tracker.ts` and adds a 24h verdict persistence file (`state/verdicts.json`) plus an `<execution_gate_guidance>` snapshot block that de-authorizes the persisted phantom-hook beliefs at decision time (the lever that worked for entry paralysis). Front 2 adds wake-gap detection + quota backoff to `daemon.service.ts` and closes the `pending_sessions.json` read-modify-write race via a functional update helper in `state.ts`. Front 3 makes `detectTickers` precision-first and narrows news fan-out relevance from full-universe to portfolio ∪ watchlist. Front 4 is operational state surgery (pause 2 funds, correct 3 handoffs, restart daemon, smoke test).

**Tech Stack:** TypeScript ESM, Vitest, Zod, node-cron, better-sqlite3. Tests mock fs/services per existing conventions.

**Diagnosis reference:** memory `project_no_trading_diagnosis_2026_06` (2026-06-12 workflow, 11 agents + 3 adversarial verifiers).

---

## Context for a zero-context engineer

- Funds live in `~/.fundx/funds/<name>/`; the repo is `/Users/michael/Proyectos/fundx`. The daemon (PID file `~/.fundx/daemon.pid`) runs `tsx src/index.tsx --_daemon-mode` — **source is live only after a daemon restart**.
- The "verdict gate" is a Claude Agent SDK `PreToolUse` hook on `mcp__broker-local__place_order` built in `src/services/session.service.ts` (`buildTrackerHookOptions`) backed by `src/services/verdict-tracker.ts`. BUY needs trade-evaluator `RECOMMENDATION: PROCEED` + risk-guardian `VERDICT: APPROVED`; SELL needs risk-guardian only. Today the tracker is constructed empty per session, the parser rejects `APPROVED (with warnings)`, and agents have written "the hook is a deliberate control, do not attempt orders" into their handoffs.
- Run tests with `npx vitest run tests/<file>.test.ts`; full suite `pnpm test`; typecheck `pnpm typecheck`.
- Commit style: conventional commits, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 0: Commit the pending denyPlaceOrder fix

The working tree already contains the (verified, tested) fix that puts deny reasons in agent-visible fields. It must land as its own commit before new work.

**Files:**
- Already modified: `src/services/verdict-tracker.ts`, `tests/verdict-tracker.test.ts`

- [ ] **Step 0.1: Run the existing test file**

Run: `npx vitest run tests/verdict-tracker.test.ts`
Expected: PASS (all tests, including the two "deny reason reaches the model" regressions)

- [ ] **Step 0.2: Commit**

```bash
git add src/services/verdict-tracker.ts tests/verdict-tracker.test.ts
git commit -m "fix(verdict-gate): emit deny reason in agent-visible fields (reason + permissionDecisionReason)

The actionable deny text lived only in systemMessage, which the SDK shows
to the operator and never relays to the agent. Agents could not learn how
to satisfy the gate, froze their exit queues for weeks, and hallucinated a
non-existent settings.json hook as the cause.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 1: Tolerant verdict parser

`VERDICT_RE` / `RECOMMENDATION_RE` anchor with `\s*$`, so `VERDICT: APPROVED (with warnings)` parses as *malformed* → silent deny. pm-survivor's June 3 GLD entry (both gates legitimately run) died on exactly this.

**Files:**
- Modify: `src/services/verdict-tracker.ts:50-51`
- Test: `tests/verdict-tracker.test.ts`

- [ ] **Step 1.1: Write failing tests**

Add to `tests/verdict-tracker.test.ts` (reuse the file's existing `userToolResultMessage` helper for fabricating SDK messages):

```typescript
describe("VerdictTracker — tolerant verdict parsing", () => {
  it("accepts VERDICT: APPROVED with trailing qualifier", () => {
    const t = new VerdictTracker();
    t.observe(userToolResultMessage(`<risk_validation>
TICKER: GLD
SIDE: buy
VERDICT: APPROVED (with warnings)
</risk_validation>`));
    expect(t._verdicts).toHaveLength(1);
    expect(t._verdicts[0]).toMatchObject({ ticker: "GLD", approved: true });
  });

  it("accepts RECOMMENDATION: PROCEED with trailing qualifier", () => {
    const t = new VerdictTracker();
    t.observe(userToolResultMessage(`<trade_evaluation>
TICKER: CMI
SIDE: buy
RECOMMENDATION: PROCEED — half size given FOMC week
</trade_evaluation>`));
    expect(t._verdicts).toHaveLength(1);
    expect(t._verdicts[0]).toMatchObject({ ticker: "CMI", recommendation: "PROCEED", approved: true });
  });

  it("does not match APPROVED_X style tokens", () => {
    const t = new VerdictTracker();
    t.observe(userToolResultMessage(`<risk_validation>
TICKER: GLD
SIDE: buy
VERDICT: APPROVEDISH
</risk_validation>`));
    expect(t._verdicts).toHaveLength(0);
  });
});
```

- [ ] **Step 1.2: Run to verify failure**

Run: `npx vitest run tests/verdict-tracker.test.ts`
Expected: first two new tests FAIL (0 verdicts parsed)

- [ ] **Step 1.3: Implement**

In `src/services/verdict-tracker.ts` replace lines 50-51:

```typescript
// Accept trailing qualifiers after the keyword ("APPROVED (with warnings)",
// "PROCEED — half size"). Anchoring with \s*$ silently discarded legitimate
// verdicts and produced unexplained denials.
const RECOMMENDATION_RE = /^[ \t]*RECOMMENDATION:\s*(PROCEED|RECONSIDER|REJECT)\b/m;
const VERDICT_RE = /^[ \t]*VERDICT:\s*(APPROVED|REJECTED)\b/m;
```

- [ ] **Step 1.4: Run tests**

Run: `npx vitest run tests/verdict-tracker.test.ts`
Expected: PASS (all, including pre-existing strict-format tests — `\b` keeps `APPROVEDISH` out)

- [ ] **Step 1.5: Commit**

```bash
git add src/services/verdict-tracker.ts tests/verdict-tracker.test.ts
git commit -m "fix(verdict-gate): accept trailing qualifiers in VERDICT/RECOMMENDATION lines

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Verdict persistence plumbing (paths + types + state)

Verdicts currently die with the session, so executing a previously-validated trigger requires re-running both validators inside the executing session — impossible in a 10-turn news_reaction. Persist verdicts per fund with a 24h TTL.

**Files:**
- Modify: `src/paths.ts:117-137` (state block)
- Modify: `src/types.ts` (after `pendingSessionSchema`, ~line 722)
- Modify: `src/state.ts` (new section after Pending Sessions)
- Test: `tests/state-verdicts.test.ts` (create)

- [ ] **Step 2.1: Add path entry**

In `src/paths.ts`, inside the `state: {` object (after `lastConsolidation`):

```typescript
      verdicts: join(root, "state", "verdicts.json"),
```

- [ ] **Step 2.2: Add schema in `src/types.ts`** (after `pendingSessionSchema` block):

```typescript
// ── Verdict Persistence (pre-trade gate, 24h TTL) ─────────────

export const persistedVerdictSchema = z.object({
  ticker: z.string(),
  side: z.enum(["buy", "sell"]),
  source: z.enum(["trade-evaluator", "risk-guardian"]),
  recommendation: z.enum(["PROCEED", "RECONSIDER", "REJECT", "APPROVED", "REJECTED"]),
  approved: z.boolean(),
  observedAt: z.number(),
});

export type PersistedVerdict = z.infer<typeof persistedVerdictSchema>;
```

- [ ] **Step 2.3: Write failing tests** — create `tests/state-verdicts.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let workspaceDir: string;
vi.mock("../src/paths.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/paths.js")>();
  return {
    ...original,
    fundPaths: (name: string) => {
      const root = join(workspaceDir, "funds", name);
      return {
        ...original.fundPaths(name),
        state: {
          ...original.fundPaths(name).state,
          dir: join(root, "state"),
          verdicts: join(root, "state", "verdicts.json"),
        },
      };
    },
  };
});

import { readVerdicts, writeVerdicts } from "../src/state.js";

describe("verdict persistence state CRUD", () => {
  beforeEach(async () => {
    workspaceDir = await mkdtemp(join(tmpdir(), "fundx-verdicts-"));
    return async () => rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns [] when the file does not exist", async () => {
    expect(await readVerdicts("nofund")).toEqual([]);
  });

  it("round-trips verdicts and drops malformed entries", async () => {
    const v = {
      ticker: "GLD", side: "buy" as const, source: "risk-guardian" as const,
      recommendation: "APPROVED" as const, approved: true, observedAt: 1_750_000_000_000,
    };
    await writeVerdicts("f1", [v, { garbage: true } as never]);
    expect(await readVerdicts("f1")).toEqual([v]);
  });
});
```

(If the existing test suite mocks paths differently — see `tests/handoff-archive.test.ts` for the established pattern — follow that pattern instead.)

- [ ] **Step 2.4: Run to verify failure**

Run: `npx vitest run tests/state-verdicts.test.ts`
Expected: FAIL — `readVerdicts` not exported

- [ ] **Step 2.5: Implement in `src/state.ts`** (new section; import `PersistedVerdict, persistedVerdictSchema` from `./types.js`; ensure the state dir exists like sibling writers do):

```typescript
// ── Persisted Verdicts (pre-trade gate, loaded with TTL by session runner) ──

export async function readVerdicts(fundName: string): Promise<PersistedVerdict[]> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.verdicts);
    const arr = Array.isArray(data) ? data : [];
    return arr
      .map((item) => persistedVerdictSchema.safeParse(item))
      .filter((r): r is { success: true; data: PersistedVerdict } => r.success)
      .map((r) => r.data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function writeVerdicts(fundName: string, verdicts: PersistedVerdict[]): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.verdicts, verdicts);
}
```

- [ ] **Step 2.6: Run tests** — `npx vitest run tests/state-verdicts.test.ts` → PASS

- [ ] **Step 2.7: Commit**

```bash
git add src/paths.ts src/types.ts src/state.ts tests/state-verdicts.test.ts
git commit -m "feat(verdict-gate): per-fund verdicts.json state CRUD

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: VerdictTracker seeding + freshness filter

**Files:**
- Modify: `src/services/verdict-tracker.ts`
- Test: `tests/verdict-tracker.test.ts`

- [ ] **Step 3.1: Write failing tests**

```typescript
import { filterFreshVerdicts, VERDICT_TTL_MS } from "../src/services/verdict-tracker.js";

describe("VerdictTracker — persistence across sessions", () => {
  const mk = (over: Partial<Verdict>): Verdict => ({
    ticker: "GLD", side: "buy", source: "risk-guardian",
    recommendation: "APPROVED", approved: true, observedAt: Date.now(), ...over,
  });

  it("filterFreshVerdicts drops entries older than the TTL", () => {
    const now = 2_000_000_000_000;
    const fresh = mk({ observedAt: now - VERDICT_TTL_MS + 60_000 });
    const stale = mk({ observedAt: now - VERDICT_TTL_MS - 60_000 });
    expect(filterFreshVerdicts([fresh, stale], now)).toEqual([fresh]);
  });

  it("constructor seeds prior verdicts so the gate approves without re-running validators", () => {
    const seed = [
      mk({ source: "trade-evaluator", recommendation: "PROCEED" }),
      mk({ source: "risk-guardian", recommendation: "APPROVED" }),
    ];
    const t = new VerdictTracker(seed);
    expect(t.checkPlaceOrder({ symbol: "GLD", side: "buy" }).decision).toBe("approve");
  });

  it("verdicts getter exposes the combined list for persistence", () => {
    const t = new VerdictTracker([mk({})]);
    expect(t.verdicts).toHaveLength(1);
  });
});
```

- [ ] **Step 3.2: Run to verify failure** — `npx vitest run tests/verdict-tracker.test.ts` → FAIL (no export / constructor arity)

- [ ] **Step 3.3: Implement** in `src/services/verdict-tracker.ts`:

```typescript
/** Verdicts persist across sessions for this long. Long enough to bridge a
 *  post_market approval to the next pre_market execution; short enough that a
 *  materially-moved market forces re-validation. */
export const VERDICT_TTL_MS = 24 * 60 * 60 * 1000;

/** Pure: drop verdicts whose observedAt is outside the TTL window. */
export function filterFreshVerdicts(verdicts: Verdict[], nowMs: number): Verdict[] {
  return verdicts.filter((v) => nowMs - v.observedAt <= VERDICT_TTL_MS);
}
```

and in the class:

```typescript
export class VerdictTracker {
  /** Public for test introspection only — do not use externally. */
  _verdicts: Verdict[] = [];

  constructor(initialVerdicts: Verdict[] = []) {
    this._verdicts = [...initialVerdicts];
  }

  /** All observed + seeded verdicts, for persistence at session end. */
  get verdicts(): Verdict[] {
    return [...this._verdicts];
  }
  // ... rest unchanged
```

Also update both deny messages (lines ~163-165 and ~175-177) to mention persistence, e.g. append to the BUY message:

```typescript
          `Required: invoke trade-evaluator (Task tool) and risk-guardian for this trade before retrying. ` +
          `Verdicts persist 24h, so approvals from a recent prior session also count.`,
```

and to the SELL message:

```typescript
          `Required: invoke risk-guardian (Task tool) for this trade before retrying. ` +
          `Verdicts persist 24h, so approvals from a recent prior session also count.`,
```

- [ ] **Step 3.4: Run tests** — `npx vitest run tests/verdict-tracker.test.ts` → PASS

- [ ] **Step 3.5: Commit**

```bash
git add src/services/verdict-tracker.ts tests/verdict-tracker.test.ts
git commit -m "feat(verdict-gate): seedable tracker + 24h freshness filter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire persistence into runFundSession

**Files:**
- Modify: `src/services/session.service.ts:405` (tracker construction) and after session completion (~line 531)
- Test: `tests/session-verdict-persistence.test.ts` (create; mock heavyweight deps like `tests/` siblings do — see `tests/budget.test.ts` / existing session tests for the mock harness)

- [ ] **Step 4.1: Write failing test** asserting that `runFundSession` (a) constructs the tracker from `readVerdicts` filtered by freshness, and (b) writes `verdictTracker.verdicts` back via `writeVerdicts` after the query resolves. Mock `../src/agent.js` (`runAgentQuery` resolving a minimal success result), `../src/state.js` (spy `readVerdicts`/`writeVerdicts`), `../src/services/fund.service.js`, `../src/config.js`, `../src/services/universe.service.js`, `../src/services/snapshot.service.js`, `../src/services/handoff-archive.service.js`, notifications. Follow the established mock pattern in the existing session tests.

```typescript
it("seeds the gate from persisted verdicts and persists observed ones", async () => {
  const prior = {
    ticker: "GLD", side: "buy" as const, source: "risk-guardian" as const,
    recommendation: "APPROVED" as const, approved: true, observedAt: Date.now() - 60_000,
  };
  vi.mocked(readVerdicts).mockResolvedValue([prior]);
  await runFundSession("f1", "pre_market");
  expect(readVerdicts).toHaveBeenCalledWith("f1");
  expect(writeVerdicts).toHaveBeenCalledWith("f1", expect.arrayContaining([
    expect.objectContaining({ ticker: "GLD", source: "risk-guardian" }),
  ]));
});
```

- [ ] **Step 4.2: Run to verify failure**

- [ ] **Step 4.3: Implement** in `src/services/session.service.ts`:

Imports: add `readVerdicts, writeVerdicts` to the `../state.js` import; add `filterFreshVerdicts` to the verdict-tracker import.

Replace line 405:

```typescript
  // Seed the pre-trade gate with verdicts persisted from recent sessions
  // (24h TTL). Without this, executing a previously-validated trigger
  // requires re-running both validators inside the executing session —
  // impossible in a 10-turn news_reaction follow-up.
  const persistedVerdicts = await readVerdicts(fundName).catch(() => []);
  const verdictTracker = new VerdictTracker(
    filterFreshVerdicts(persistedVerdicts, Date.now()),
  );
```

After `await appendSessionLogEntry(fundName, log);` (line ~532) add:

```typescript
  // Persist verdicts (seeded + observed this session) for the next session's gate.
  try {
    await writeVerdicts(fundName, filterFreshVerdicts(verdictTracker.verdicts, Date.now()));
  } catch (err) {
    console.warn(`[verdict-gate] failed to persist verdicts for ${fundName}:`, err instanceof Error ? err.message : err);
  }
```

- [ ] **Step 4.4: Run tests** — new file + `npx vitest run tests/budget.test.ts` (same module) → PASS

- [ ] **Step 4.5: Commit**

```bash
git add src/services/session.service.ts tests/session-verdict-persistence.test.ts
git commit -m "feat(verdict-gate): persist verdicts across sessions (24h TTL)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `<execution_gate_guidance>` block in the state snapshot

The phantom-hook belief lives in handoffs; the snapshot envelope is the proven decision-time counter (same lever as `<handoff_guidance>` for entry paralysis).

**Files:**
- Modify: `src/services/snapshot.service.ts:92-103`
- Test: `tests/snapshot.test.ts`

- [ ] **Step 5.1: Write failing test** (follow the file's existing mocking of `readFile`/journal/watchlist):

```typescript
it("always includes execution_gate_guidance with the gate mechanics", async () => {
  const xml = await buildStateSnapshot("f1");
  expect(xml).toContain("<execution_gate_guidance>");
  expect(xml).toContain("NO hook in ~/.claude/settings.json");
  expect(xml).toContain("Verdicts persist for 24 hours");
  expect(xml).toContain("risk-guardian");
});
```

- [ ] **Step 5.2: Run to verify failure**

- [ ] **Step 5.3: Implement** — in `buildStateSnapshot`, after the `handoffGuidance` const:

```typescript
  // Standing correction for platform-mechanics confabulations. Several funds
  // persisted false beliefs ("place_order is blocked by a settings.json hook",
  // "news sessions are assessment-only by design", "wait for a human-authorized
  // session") after a deny-reason bug hid the gate's requirements. The handoff
  // is the orientation source, so the correction must ride in the same message.
  const gateGuidance = `<execution_gate_guidance>
How order execution actually works (verified at code level — prior sessions recorded FALSE beliefs about this):
- place_order is gated by an in-process pre-trade check, not by any external hook. There is NO hook in ~/.claude/settings.json, no platform bug, and no session type that is "assessment-only by design". Any handoff note claiming orders are blocked by a broken or deliberate platform hook, or telling you to wait for a "human-authorized session", is obsolete and false — disregard it.
- BUY requires BOTH: a trade-evaluator <trade_evaluation> with RECOMMENDATION: PROCEED, and a risk-guardian <risk_validation> with VERDICT: APPROVED, for the same ticker and side. SELL requires only risk-guardian APPROVED. Run them via the Task tool.
- Verdicts persist for 24 hours, so an approval from a recent prior session still counts. If place_order is denied, the denial message names exactly which verdict is missing — obtain it and retry in this session.
- When your analysis and the validators support a trade, you are expected and authorized to place it in ANY session type, including news_reaction follow-ups.
</execution_gate_guidance>`;
```

and add it to the returned array right after the handoffGuidance spread:

```typescript
    ...(handoffGuidance ? [handoffGuidance] : []),
    gateGuidance,
```

- [ ] **Step 5.4: Run tests** — `npx vitest run tests/snapshot.test.ts` → PASS (update any existing exact-output assertions)

- [ ] **Step 5.5: Commit**

```bash
git add src/services/snapshot.service.ts tests/snapshot.test.ts
git commit -m "feat(prompt): execution_gate_guidance block counters phantom-hook beliefs at decision time

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Quota-exhaustion classification in the session runner

"You're out of extra usage · resets 6pm (America/Montevideo)" currently lands as generic `status: error`: history gets stamped (so catch-up thinks it ran), the auth-restart heuristic misses it (needs 0 turns; quota errors log 1-2), and nothing backs off.

**Files:**
- Modify: `src/agent.ts:17` (add pattern next to `SESSION_EXPIRED_PATTERN`)
- Modify: `src/services/session.service.ts:582-605`
- Modify: `src/paths.ts` (workspace const), `src/state.ts` (workspace-level CRUD), `src/types.ts` (schema)
- Test: `tests/quota-backoff.test.ts` (create), `tests/agent.test.ts` (pattern)

- [ ] **Step 6.1: Write failing tests**

In `tests/quota-backoff.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { QUOTA_EXHAUSTED_PATTERN } from "../src/agent.js";
import { isQuotaBackoffActive, QUOTA_BACKOFF_MS } from "../src/services/session.service.js";

describe("quota exhaustion detection", () => {
  it("matches the observed subscription error strings", () => {
    expect(QUOTA_EXHAUSTED_PATTERN.test("You're out of extra usage · resets 6pm (America/Montevideo)")).toBe(true);
    expect(QUOTA_EXHAUSTED_PATTERN.test("You've reached your usage limit")).toBe(true);
    expect(QUOTA_EXHAUSTED_PATTERN.test("ordinary session output about usage of tools")).toBe(false);
  });

  it("isQuotaBackoffActive is true within the window and false after", () => {
    const t0 = 1_750_000_000_000;
    expect(isQuotaBackoffActive(t0, t0 + QUOTA_BACKOFF_MS - 1)).toBe(true);
    expect(isQuotaBackoffActive(t0, t0 + QUOTA_BACKOFF_MS + 1)).toBe(false);
    expect(isQuotaBackoffActive(null, t0)).toBe(false);
  });
});
```

- [ ] **Step 6.2: Run to verify failure**

- [ ] **Step 6.3: Implement**

`src/agent.ts` (next to SESSION_EXPIRED_PATTERN):

```typescript
/** Claude subscription quota exhaustion. The SDK returns these as non-throwing
 *  `status: "error"` results with ~1 turn and $0 cost. */
export const QUOTA_EXHAUSTED_PATTERN = /out of (extra )?usage|usage limit/i;
```

`src/paths.ts` (after `DAEMON_NEEDS_RESTART`):

```typescript
// Workspace-level quota backoff marker (subscription usage exhausted)
export const QUOTA_BACKOFF = join(WORKSPACE, "state", "quota_backoff.json");
```

`src/types.ts`:

```typescript
export const quotaBackoffSchema = z.object({ last_quota_error_at: z.string() });
export type QuotaBackoffState = z.infer<typeof quotaBackoffSchema>;
```

`src/state.ts`:

```typescript
// ── Quota Backoff (workspace-level, subscription usage exhaustion) ──

export async function readQuotaBackoff(): Promise<QuotaBackoffState | null> {
  try {
    return quotaBackoffSchema.parse(await readJson(QUOTA_BACKOFF));
  } catch {
    return null; // missing or malformed → no backoff
  }
}

export async function writeQuotaBackoff(state: QuotaBackoffState): Promise<void> {
  await mkdir(dirname(QUOTA_BACKOFF), { recursive: true }).catch(() => {});
  await writeJsonAtomic(QUOTA_BACKOFF, state);
}
```

`src/services/session.service.ts`:

```typescript
/** How long the daemon refrains from launching sessions after a quota error. */
export const QUOTA_BACKOFF_MS = 60 * 60 * 1000;

/** Pure: whether the backoff window from the last quota error is still open. */
export function isQuotaBackoffActive(lastErrorAtMs: number | null, nowMs: number): boolean {
  return lastErrorAtMs !== null && nowMs - lastErrorAtMs < QUOTA_BACKOFF_MS;
}
```

In `runFundSession`, right after `const log: SessionLogV2 = {...}` is built, compute:

```typescript
  const quotaKilled =
    result.status === "error" && QUOTA_EXHAUSTED_PATTERN.test(result.output ?? "");
```

then (a) guard the history stamp (lines 582-589):

```typescript
  // Update per-session-type history for catch-up detection.
  // Quota-killed sessions are deliberately NOT stamped: the session did not
  // run, and the wake/recovery catch-up must be able to re-run it.
  if (!quotaKilled) {
    try {
      const history = await readSessionHistory(fundName);
      history[sessionType] = new Date().toISOString();
      await writeSessionHistory(fundName, history);
    } catch { /* non-critical */ }
  }
```

(b) after the history block, add the marker + distinct notification:

```typescript
  if (quotaKilled) {
    try {
      await writeQuotaBackoff({ last_quota_error_at: new Date().toISOString() });
    } catch { /* best effort */ }
    await notifySession(
      `⏳ <b>${displayName}</b> — ${sessionType} blocked: Claude subscription usage exhausted. ` +
      `Daemon will pause session launches ~1h and catch up after the window resets.`,
    );
  }
```

(c) exclude quota kills from the auth-restart heuristic by adding `&& !quotaKilled` to the condition at line ~593 (defensive; quota errors usually have 1-2 turns anyway).

Imports to add: `QUOTA_EXHAUSTED_PATTERN` from `../agent.js`; `writeQuotaBackoff` from `../state.js`. In `state.ts` import `mkdir` from `node:fs/promises`, `dirname` from `node:path`, `QUOTA_BACKOFF` from `./paths.js`.

- [ ] **Step 6.4: Run tests** — `npx vitest run tests/quota-backoff.test.ts tests/agent.test.ts tests/budget.test.ts` → PASS

- [ ] **Step 6.5: Commit**

```bash
git add src/agent.ts src/paths.ts src/types.ts src/state.ts src/services/session.service.ts tests/quota-backoff.test.ts
git commit -m "feat(daemon): classify subscription-quota kills — no history stamp, backoff marker, distinct alert

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Daemon wake catch-up + quota gating + recovery catch-up

node-cron drops ticks during macOS sleep; `checkMissedSessions` runs only at startup with a 60-min tolerance. 14 of 33 trading slots were lost in 11 weekdays.

**Files:**
- Modify: `src/services/daemon.service.ts:486` (tolerance), `:500` (signature), `:663-924` (tickFn)
- Test: `tests/daemon-wake-catchup.test.ts` (create)

- [ ] **Step 7.1: Write failing test** for the pure gap detector:

```typescript
import { describe, it, expect } from "vitest";
import { detectWakeGap, WAKE_GAP_THRESHOLD_MS } from "../src/services/daemon.service.js";

describe("detectWakeGap", () => {
  it("fires when the inter-tick gap exceeds the threshold", () => {
    const t0 = 1_750_000_000_000;
    expect(detectWakeGap(t0, t0 + WAKE_GAP_THRESHOLD_MS + 1)).toBe(true);
    expect(detectWakeGap(t0, t0 + 60_000)).toBe(false);
    expect(detectWakeGap(0, t0)).toBe(false); // first tick — no anchor
  });
});
```

- [ ] **Step 7.2: Run to verify failure**

- [ ] **Step 7.3: Implement** in `src/services/daemon.service.ts`:

Constants & helper (near CATCHUP_TOLERANCE_MS):

```typescript
// Raised from 60min: with most-recent-only catch-up per fund, a longer window
// recovers same-day sessions after multi-hour laptop sleeps at bounded cost.
const CATCHUP_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/** Inter-tick gap that indicates the host slept through cron minutes. */
export const WAKE_GAP_THRESHOLD_MS = 5 * 60 * 1000;

/** Pure: true when the previous tick anchor exists and the gap exceeds threshold. */
export function detectWakeGap(prevTickMs: number, nowMs: number): boolean {
  return prevTickMs > 0 && nowMs - prevTickMs > WAKE_GAP_THRESHOLD_MS;
}
```

Parameterize `checkMissedSessions(toleranceMs: number = CATCHUP_TOLERANCE_MS)` and use `toleranceMs` instead of the constant inside (line ~545).

Module state above `tickFn`:

```typescript
let lastTickAtMs = 0;
let quotaBackoffWasActive = false;
```

At the top of `tickFn` (after the `isProcessing` guard, inside the try):

```typescript
      const nowMs = Date.now();

      // ── Wake catch-up: node-cron silently drops ticks during OS sleep ──
      if (detectWakeGap(lastTickAtMs, nowMs)) {
        await log(`[wake-catchup] ${Math.round((nowMs - lastTickAtMs) / 60000)}min tick gap detected — running missed-session catch-up`);
        try { await checkMissedSessions(); } catch (err) { await log(`[wake-catchup] failed: ${err}`); }
      }
      lastTickAtMs = nowMs;

      // ── Quota backoff: don't burn the pending queue into a dead window ──
      const quotaState = await readQuotaBackoff().catch(() => null);
      const quotaActive = isQuotaBackoffActive(
        quotaState ? Date.parse(quotaState.last_quota_error_at) : null,
        nowMs,
      );
      if (quotaActive && !quotaBackoffWasActive) {
        await log(`[quota-backoff] active since ${quotaState!.last_quota_error_at} — pausing session launches`);
      }
      if (!quotaActive && quotaBackoffWasActive) {
        await log(`[quota-backoff] window expired — running recovery catch-up`);
        try { await checkMissedSessions(); } catch (err) { await log(`[quota-backoff] recovery catch-up failed: ${err}`); }
      }
      quotaBackoffWasActive = quotaActive;
```

Gate launches on `quotaActive`: wrap the scheduled-sessions loop, the special-sessions loop, and the pending-sessions branch with `if (!quotaActive) { ... }` (stop-loss checks, reports, milestones, heartbeat stay live). Implementation detail: introduce the flag into the per-fund closure via the outer scope (it is computed before `names.map(...)`).

Imports: `readQuotaBackoff` from `../state.js`, `isQuotaBackoffActive` from `./session.service.js`.

- [ ] **Step 7.4: Run tests** — new file + `npx vitest run tests/daemon-integration.test.ts` → PASS

- [ ] **Step 7.5: Commit**

```bash
git add src/services/daemon.service.ts tests/daemon-wake-catchup.test.ts
git commit -m "feat(daemon): wake-gap catch-up, 6h catch-up tolerance, quota-backoff launch gating + recovery

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Close the pending_sessions read-modify-write race

The tick reads `pending`, awaits a session for minutes, then writes the stale copy back — clobbering anything enqueued meanwhile (~9 documented preemptions on pm-survivor). Stale entries (>1h) are also discarded silently, deleting dead executors forever.

**Files:**
- Modify: `src/state.ts` (functional helper), `src/services/daemon.service.ts:820-915`, `src/services/news.service.ts:604-619`
- Test: `tests/pending-sessions-race.test.ts` (create)

- [ ] **Step 8.1: Write failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
// mock paths to a tmp workspace as in tests/state-verdicts.test.ts
import { readPendingSessions, writePendingSessions, updatePendingSessions } from "../src/state.js";

const entry = (id: string) => ({
  id, type: "agent_followup" as const, focus: "x",
  scheduled_at: new Date().toISOString(), created_at: new Date().toISOString(),
  source: "agent" as const, max_turns: 10, max_duration_minutes: 5, priority: "high" as const,
});

it("updatePendingSessions applies fn over the CURRENT file contents", async () => {
  await writePendingSessions("f1", [entry("a")]);
  // Simulate a concurrent enqueue between a stale read and our update:
  await writePendingSessions("f1", [entry("a"), entry("b")]);
  await updatePendingSessions("f1", (list) => list.filter((s) => s.id !== "a"));
  expect((await readPendingSessions("f1")).map((s) => s.id)).toEqual(["b"]);
});
```

- [ ] **Step 8.2: Run to verify failure** — `updatePendingSessions` not exported

- [ ] **Step 8.3: Implement**

`src/state.ts`:

```typescript
/** Read-apply-write update for the pending queue. Closes the minutes-long
 *  read-modify-write window in the daemon tick (which awaited a session
 *  between read and write, clobbering concurrent enqueues) down to the
 *  microseconds inside this function. Writers in other processes (agents
 *  editing the file directly) can still race that tiny window — acceptable. */
export async function updatePendingSessions(
  fundName: string,
  fn: (sessions: PendingSession[]) => PendingSession[],
): Promise<PendingSession[]> {
  const current = await readPendingSessions(fundName);
  const next = fn(current);
  await writePendingSessions(fundName, next);
  return next;
}
```

`src/services/daemon.service.ts` — rewrite the pending block (lines 821-915). Shape:

```typescript
            // ── Pending sessions (proactive: news reactions, agent follow-ups) ──
            try {
              const pending = await readPendingSessions(name);
              if (pending.length > 0) {
                const nowMs2 = Date.now();
                const nowIso = new Date().toISOString();

                // Identify discards (stale >1h past / >24h future) — and LOG them.
                const isStale = (s: PendingSession) => nowMs2 - new Date(s.scheduled_at).getTime() > 60 * 60 * 1000;
                const isTooFar = (s: PendingSession) => new Date(s.scheduled_at).getTime() - nowMs2 > 24 * 60 * 60 * 1000;
                const discards = pending.filter((s) => isStale(s) || isTooFar(s));
                for (const d of discards) {
                  await log(`[proactive] discarding ${isStale(d) ? "stale" : "far-future"} pending ${d.type} for '${name}' (scheduled ${d.scheduled_at}, source ${d.source})`);
                  if (d.source === "agent") {
                    await notifyDaemonEvent(
                      `Dropped follow-up: ${name}`,
                      `Agent-scheduled ${d.type} (${d.scheduled_at}) expired unexecuted — it will NOT auto-retry.`,
                    );
                  }
                }
                if (discards.length > 0) {
                  const dropIds = new Set(discards.map((d) => d.id));
                  await updatePendingSessions(name, (list) => list.filter((s) => !dropIds.has(s.id)));
                }

                const live = pending.filter((s) => !isStale(s) && !isTooFar(s));
                const due = live
                  .filter((s) => new Date(s.scheduled_at).getTime() <= nowMs2)
                  .sort((a, b) => {
                    const prio = (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1);
                    if (prio !== 0) return prio;
                    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
                  });

                if (due.length > 0) {
                  const session = due[0]!;
                  const counts = await readSessionCountsForToday(name);
                  let withinLimits = true;
                  if (session.source === "agent") {
                    if (counts.agent >= 5) withinLimits = false;
                    if (counts.last_agent_at && nowMs2 - new Date(counts.last_agent_at).getTime() < 5 * 60 * 1000) withinLimits = false;
                  } else if (session.source === "news") {
                    if (counts.news >= 5) withinLimits = false;
                    if (counts.last_news_at && nowMs2 - new Date(counts.last_news_at).getTime() < 60 * 60 * 1000) withinLimits = false;
                  }

                  let shouldRemove = false;
                  if (withinLimits) {
                    const locked = await acquireFundLock(name, session.type);
                    if (locked) {
                      shouldRemove = true;
                      try {
                        await log(`[proactive] Running ${session.type} for '${name}' (source: ${session.source})`);
                        await sessionSemaphore(() =>
                          withTimeout(
                            runFundSession(name, session.type, {
                              focus: session.focus,
                              maxTurns: session.max_turns,
                              maxDurationMinutes: session.max_duration_minutes,
                            }),
                            (session.max_duration_minutes ?? 5) * 60 * 1000,
                          ),
                        );
                        if (session.source === "agent") {
                          counts.agent += 1; counts.last_agent_at = nowIso;
                        } else {
                          counts.news += 1; counts.last_news_at = nowIso;
                        }
                        await writeSessionCounts(name, counts);
                      } catch (err) {
                        await log(`[proactive] Error in ${session.type} for '${name}': ${err}`);
                      } finally {
                        await releaseFundLock(name);
                      }
                    }
                  } else {
                    shouldRemove = true;
                    await log(`[proactive] Limit reached for '${name}' (${session.source}), skipping ${session.type}`);
                  }

                  if (shouldRemove) {
                    // Re-read + remove by id — never write back the pre-session snapshot.
                    await updatePendingSessions(name, (list) => list.filter((s) => s.id !== session.id));
                  }
                }
              }
            } catch (err) {
              await log(`[proactive] Error processing pending sessions for '${name}': ${err}`);
            }
```

`src/services/news.service.ts` — replace the enqueue read+push+write (lines 604-618) with:

```typescript
            // Enqueue via functional update — a plain read+push+write here can
            // clobber (or be clobbered by) the daemon tick's queue maintenance.
            const symbols = article.symbols.length > 0 ? article.symbols.join(", ") : "general market";
            const { updatePendingSessions } = await import("../state.js");
            await updatePendingSessions(fundName, (list) => [
              ...list,
              {
                id: randomUUID(),
                type: "news_reaction" as const,
                focus: `NEWS REACTION SESSION: ${article.source} reported "${article.title}".\nSymbols mentioned: ${symbols}.\nAnalyze the impact on your portfolio. If immediate action is needed (stop-loss adjustment, position reduction, hedge), execute it. If no action needed, document your reasoning in memory.\nThis is a short session (5 min, 10 turns) — be decisive.`,
                scheduled_at: new Date(Date.now() + 60_000).toISOString(),
                created_at: new Date().toISOString(),
                source: "news" as const,
                max_turns: 10,
                max_duration_minutes: 5,
                priority: "high" as const,
              },
            ]);
```

(static import of `updatePendingSessions` alongside the existing `readPendingSessions, writePendingSessions` import is fine — prefer that; shown dynamic only if cycles bite.)

- [ ] **Step 8.4: Run tests** — new file + `npx vitest run tests/daemon-integration.test.ts tests/news.test.ts` → PASS

- [ ] **Step 8.5: Commit**

```bash
git add src/state.ts src/services/daemon.service.ts src/services/news.service.ts tests/pending-sessions-race.test.ts
git commit -m "fix(daemon): close pending_sessions read-modify-write race; log + notify dropped follow-ups

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Precision detectTickers

92% of symbol tags in the live store are common-word false positives (`\bON\b` with `/i` matches "on"). Precision over recall: explicit `$X`/`(X)` always count; bare matches must be exact-uppercase and never count for word-tickers.

**Files:**
- Modify: `src/services/news.service.ts:92-103`
- Test: `tests/news.test.ts`

- [ ] **Step 9.1: Write failing tests**

```typescript
describe("detectTickers precision", () => {
  const known = ["ON", "IT", "ARE", "A", "T", "AAPL", "CMI", "COHR"];

  it("ignores common words in ordinary headlines", () => {
    expect(detectTickers(
      "South Africa Treasury Says Upgrades Show Path to Investment Grade", known,
    )).toEqual([]);
  });

  it("keeps explicit $TICKER and (TICKER) forms", () => {
    expect(detectTickers("Apple ($AAPL) and ON Semi (ON) beat estimates", known))
      .toEqual(expect.arrayContaining(["AAPL", "ON"]));
  });

  it("matches bare non-word tickers case-sensitively", () => {
    expect(detectTickers("CMI surges after earnings", known)).toEqual(["CMI"]);
    expect(detectTickers("cmi surges after earnings", known)).toEqual([]);
  });

  it("never bare-matches word-tickers even in ALL-CAPS headlines", () => {
    expect(detectTickers("BREAKING: TARIFFS ON CHIPS ARE COMING", known)).toEqual([]);
  });
});
```

- [ ] **Step 9.2: Run to verify failure** (also note which existing detectTickers tests now assert the old behavior — update them in step 9.3)

- [ ] **Step 9.3: Implement**

```typescript
/** Tickers that double as common English words. Bare-word matches for these
 *  measured 92% false-positive in the live news store — they only count in
 *  explicit $TICKER or (TICKER) form. */
export const WORD_TICKER_STOPLIST = new Set([
  "A", "ALL", "AMP", "ARE", "BIG", "BRO", "C", "CAN", "COST", "D", "DAY", "EAT",
  "FAST", "FIX", "FOR", "GO", "GOOD", "HAS", "HE", "IT", "KEY", "L", "LOW",
  "MET", "NEXT", "NICE", "NOW", "O", "ON", "ONE", "OPEN", "OR", "OUT", "PLAY",
  "REAL", "SEE", "SO", "T", "TAP", "TECH", "UP", "WELL",
]);

export function detectTickers(text: string, knownTickers: string[]): string[] {
  const found: string[] = [];
  for (const ticker of knownTickers) {
    const escaped = escapeRegex(ticker);
    // Explicit forms are unambiguous regardless of case
    const explicit = new RegExp(`(\\$${escaped}\\b|\\(${escaped}\\))`, "i");
    if (explicit.test(text)) {
      found.push(ticker);
      continue;
    }
    // Bare form: exact-uppercase only, and never for common-word tickers
    if (WORD_TICKER_STOPLIST.has(ticker)) continue;
    if (new RegExp(`\\b${escaped}\\b`).test(text)) found.push(ticker);
  }
  return [...new Set(found)];
}
```

- [ ] **Step 9.4: Run tests** — `npx vitest run tests/news.test.ts` → PASS

- [ ] **Step 9.5: Commit**

```bash
git add src/services/news.service.ts tests/news.test.ts
git commit -m "fix(news): precision-first ticker detection (case-sensitive bare matches, word-ticker stoplist)

92% of tag instances in the live store were common-word false positives
(A/ON/IT/ARE/HAS), fanning $3+ Opus news sessions out to all funds per
irrelevant headline.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Narrow news_reaction relevance to portfolio ∪ watchlist

Every fund resolves the sp500 preset, so any tagged headline was "relevant" to all 5 funds. Real relevance: tickers the fund holds or is actively watching.

**Files:**
- Modify: `src/services/news.service.ts:528-541` (checkBreakingNews fund-ticker map)
- Test: `tests/news.test.ts`

- [ ] **Step 10.1: Write failing test** (mock `fund.service.js`, `state.js#readPortfolio`, and `watchlist.service.js` per the file's existing checkBreakingNews tests):

```typescript
it("only enqueues news_reaction for funds whose portfolio/watchlist match", async () => {
  // fund A holds COHR; fund B holds nothing and watches nothing
  // article tags [COHR] and is high impact
  await checkBreakingNews([articleWith({ symbols: ["COHR"], title: "COHR earnings surge" })]);
  expect(updatePendingSessions).toHaveBeenCalledTimes(1);
  expect(updatePendingSessions).toHaveBeenCalledWith("fundA", expect.any(Function));
});
```

- [ ] **Step 10.2: Run to verify failure**

- [ ] **Step 10.3: Implement** — in `checkBreakingNews`, replace the fund-ticker map construction (lines 532-541):

```typescript
  // Relevance = portfolio positions ∪ watchlist (candidate/watching), NOT the
  // resolved universe. With every fund on the sp500 preset, universe-based
  // relevance fanned every tagged headline out to all funds ($513 of news
  // sessions in 18 days, 80% dismissed as noise).
  let wdb: ReturnType<typeof openWatchlistDb> | null = null;
  try {
    wdb = openWatchlistDb();
  } catch { /* watchlist unavailable — portfolio-only relevance */ }

  try {
    for (const name of names) {
      try {
        const config = await loadFundConfig(name);
        if (config.fund.status !== "active") continue;
        const tickers: string[] = [];
        const portfolio = await readPortfolio(name).catch(() => null);
        if (portfolio) portfolio.positions.forEach((p) => tickers.push(p.symbol));
        if (wdb) {
          try {
            for (const row of queryWatchlist(wdb, { fund: name, status: ["candidate", "watching"], limit: 50 })) {
              tickers.push(row.ticker);
            }
          } catch { /* portfolio-only */ }
        }
        fundTickers.set(name, [...new Set(tickers)]);
      } catch { /* skip */ }
    }
  } finally {
    wdb?.close();
  }
```

Import at top: `import { openWatchlistDb, queryWatchlist } from "./watchlist.service.js";`. `getKnownUniverseTickers` remains in use by `gatherKnownTickers` (article tagging) — do not remove it.

- [ ] **Step 10.4: Run tests** — `npx vitest run tests/news.test.ts tests/news.integration.test.ts` → PASS

- [ ] **Step 10.5: Commit**

```bash
git add src/services/news.service.ts tests/news.test.ts
git commit -m "feat(news): scope news_reaction fan-out to portfolio + watchlist relevance

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Watchlist top-10 by score in the snapshot

`queryWatchlist` orders by `last_evaluated_at DESC`; nightly screening stamps every row with the same timestamp, so `LIMIT 10` returns the first 10 alphabetically — the top-scored candidates never reach the agent.

**Files:**
- Modify: `src/services/watchlist.service.ts:155-183` (orderBy option), `src/services/snapshot.service.ts:46-50`
- Test: `tests/watchlist.test.ts` (or the file housing queryWatchlist tests)

- [ ] **Step 11.1: Write failing test**

```typescript
it("orders by peak_score when requested", () => {
  // seed three tickers with peak_score 1.0 / 9.9 / 5.0 and identical last_evaluated_at
  const rows = queryWatchlist(db, { status: ["candidate", "watching"], orderBy: "peak_score", limit: 2 });
  expect(rows.map((r) => r.ticker)).toEqual(["HIGH", "MID"]);
});
```

- [ ] **Step 11.2: Run to verify failure** (TS error: orderBy not in WatchlistQuery)

- [ ] **Step 11.3: Implement** — add `orderBy?: "last_evaluated_at" | "peak_score"` to the `WatchlistQuery` interface (it lives where the service defines it; if in `types.ts`, add there). In `queryWatchlist` replace the ORDER BY:

```typescript
  const orderSql =
    q.orderBy === "peak_score"
      ? " ORDER BY COALESCE(w.peak_score, -1e9) DESC, w.last_evaluated_at DESC"
      : " ORDER BY w.last_evaluated_at DESC";
  const sql =
    "SELECT * FROM watchlist w" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    orderSql +
    (q.limit ? ` LIMIT ${Math.min(q.limit, 1000)}` : "");
```

In `snapshot.service.ts` `tryWatchlistTop`, pass `orderBy: "peak_score"` in the query options.

- [ ] **Step 11.4: Run tests** → PASS

- [ ] **Step 11.5: Commit**

```bash
git add src/services/watchlist.service.ts src/services/snapshot.service.ts src/types.ts tests/watchlist.test.ts
git commit -m "fix(snapshot): watchlist top-10 ordered by peak_score, not alphabetical tie-break

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification

- [ ] **Step 12.1:** `pnpm typecheck` → 0 errors
- [ ] **Step 12.2:** `pnpm lint` → clean (fix anything introduced)
- [ ] **Step 12.3:** `pnpm test` → full suite green
- [ ] **Step 12.4:** `pnpm build` → tsup OK (dist refresh; daemon runs tsx but dist staleness has bitten before)

---

### Task 13: Operational rollout (state surgery + restart + smoke)

- [ ] **Step 13.1: Pause pm-survivor and prueba** — in `~/.fundx/funds/pm-survivor/fund_config.yaml` and `~/.fundx/funds/prueba/fund_config.yaml`, set `status: paused` under the `fund:` block (reversible; do NOT delete the funds). Note pm-survivor additionally has `sessions: {}` — leave as-is while paused; fixing its schedule is a separate decision if it's ever reactivated.

- [ ] **Step 13.2: Operator correction note** — prepend to `state/session-handoff.md` of Growth, runway-metal, fundx-audit (English, persisted artifact):

```markdown
## ⚠️ OPERATOR CORRECTION (2026-06-12) — read before trusting prior notes

Platform mechanics were misdiagnosed in earlier sessions. Verified at code level by the operator:

- There is NO place_order hook in `~/.claude/settings.json` and there never was. The "hook blocker", "assessment-only sessions", "deliberate authorization control", and "wait for a human-authorized session" beliefs recorded below are FALSE — discard them.
- The real gate: BUY needs trade-evaluator `RECOMMENDATION: PROCEED` + risk-guardian `VERDICT: APPROVED`; SELL needs risk-guardian `APPROVED`. Run them via the Task tool. Verdicts now persist 24h across sessions. Denials now spell out exactly what is missing.
- Orders are expected and authorized in EVERY session type when your analysis and the validators support them.
- Several scheduled sessions on Jun 10-12 were killed by subscription-quota exhaustion and host sleep, NOT by any decision of yours. Treat armed triggers from those days as unevaluated, not invalidated: re-price them against current data this session.
```

- [ ] **Step 13.3: Restart the daemon** so all code changes go live (tsx loads source at process start):

```bash
pnpm dev -- stop && sleep 3 && pnpm dev -- start
```

Verify: `cat ~/.fundx/daemon.pid` (new PID), `tail -20 ~/.fundx/daemon.log` shows `Daemon started` + `Session concurrency cap` + possible startup catch-up lines.

- [ ] **Step 13.4: Smoke session on fundx-audit** (standing smoke fund per memory) exercising the gate end to end:

```bash
pnpm dev -- session run --fund fundx-audit --type mid_session
```

Success criteria: session log entry written; if the agent attempts place_order without validators, the deny text (now agent-visible) names the missing verdict; with validators run, the order executes. Check `~/.fundx/funds/fundx-audit/state/session_log.jsonl` tail + `state/verdicts.json` existence.

- [ ] **Step 13.5: Final commit of plan/docs deltas + push** (if any doc updated).

---

### Task 14 (optional, budget-aware): Eval validation

Run the autonomous reproduction case to confirm the new snapshot block doesn't regress the entry-paralysis fix (~$5, ~25 min, runs:3/threshold:2):

```bash
pnpm dev -- eval --case autonomous-entry-paralysis --timeout 600
```

If quota is tight after the day's incidents, defer to tonight after the usage window resets.

---

## Self-review checklist

- Spec coverage: F1 → Tasks 0-5 + 13.2; F2 → Tasks 6-8; F3 → Tasks 9-11; F4 → Tasks 13.1-13.4. ✓
- No placeholders: every code step shows the code. ✓ (Tests that depend on existing in-file mock harnesses reference the concrete sibling file to copy the pattern from.)
- Type consistency: `Verdict`/`PersistedVerdict` share field shapes; `filterFreshVerdicts(verdicts, nowMs)` used identically in Tasks 3/4; `updatePendingSessions(name, fn)` matches Tasks 8 daemon+news call sites; `orderBy` literal union matches Task 11 call site. ✓
