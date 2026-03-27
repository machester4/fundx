# Proactive Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FundX agents proactive — able to react to breaking news with analysis sessions and schedule their own follow-up sessions via a file-based pending queue processed by the daemon.

**Architecture:** A `pending_sessions.json` file per fund serves as a queue. The daemon processes due entries each tick. Breaking news enqueues short analysis sessions. Agents self-schedule by writing to the queue. Rate limits (5/day agent, 1/hour + 5/day news) prevent abuse. A new rule teaches agents the self-scheduling protocol.

**Tech Stack:** TypeScript, Zod, node-cron (existing), Vitest

**Spec:** `docs/superpowers/specs/2026-03-27-proactive-agent-design.md`

---

## File Structure

### Modified files

| File | Changes |
|------|---------|
| `src/types.ts` | `pendingSessionSchema`, `sessionCountsSchema` |
| `src/paths.ts` | Add `pendingSessions`, `sessionCounts` to `fundPaths().state` |
| `src/state.ts` | CRUD for pending sessions and session counts |
| `src/services/session.service.ts` | Accept `maxTurns`, `maxDurationMinutes` overrides |
| `src/services/news.service.ts` | `checkBreakingNews()` enqueues pending session |
| `src/services/daemon.service.ts` | Pending session processor in cron tick |
| `src/skills.ts` | Add `SELF_SCHEDULING_RULE` to `FUND_RULES` |
| `tests/daemon-integration.test.ts` | Mock for state pending session functions |

---

## Task 1: Types, Paths, and State CRUD

**Files:**
- Modify: `src/types.ts`
- Modify: `src/paths.ts`
- Modify: `src/state.ts`

- [ ] **Step 1: Add schemas to `src/types.ts`**

Append after the `FundCredentials` type:

```typescript
// ── Proactive Agent Schemas ──────────────────────────────────

export const pendingSessionSchema = z.object({
  id: z.string(),
  type: z.enum(["news_reaction", "agent_followup"]),
  focus: z.string(),
  scheduled_at: z.string(),
  created_at: z.string(),
  source: z.enum(["news", "agent"]),
  max_turns: z.number().positive().default(10),
  max_duration_minutes: z.number().positive().default(5),
  priority: z.enum(["high", "normal"]).default("normal"),
});

export type PendingSession = z.infer<typeof pendingSessionSchema>;

export const sessionCountsSchema = z.object({
  date: z.string(),
  agent: z.number().default(0),
  news: z.number().default(0),
  last_agent_at: z.string().optional(),
  last_news_at: z.string().optional(),
});

export type SessionCounts = z.infer<typeof sessionCountsSchema>;
```

- [ ] **Step 2: Add paths to `src/paths.ts`**

Inside `fundPaths().state` block, after `lock`:

```typescript
pendingSessions: join(root, "state", "pending_sessions.json"),
sessionCounts: join(root, "state", "session_counts.json"),
```

- [ ] **Step 3: Add state CRUD to `src/state.ts`**

Add imports:
```typescript
import {
  pendingSessionSchema,
  sessionCountsSchema,
  type PendingSession,
  type SessionCounts,
} from "./types.js";
```

Add before `initFundState`:

```typescript
// ── Pending Sessions ──────────────────────────────────────────

export async function readPendingSessions(fundName: string): Promise<PendingSession[]> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.pendingSessions);
    const arr = Array.isArray(data) ? data : [];
    return arr.map((item) => pendingSessionSchema.parse(item));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  }
}

export async function writePendingSessions(fundName: string, sessions: PendingSession[]): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.pendingSessions, sessions);
}

// ── Session Counts ────────────────────────────────────────────

export async function readSessionCounts(fundName: string): Promise<SessionCounts> {
  const paths = fundPaths(fundName);
  try {
    const data = await readJson(paths.state.sessionCounts);
    return sessionCountsSchema.parse(data);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { date: new Date().toISOString().split("T")[0], agent: 0, news: 0 };
    }
    throw err;
  }
}

export async function writeSessionCounts(fundName: string, counts: SessionCounts): Promise<void> {
  const paths = fundPaths(fundName);
  await writeJsonAtomic(paths.state.sessionCounts, counts);
}
```

- [ ] **Step 4: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/paths.ts src/state.ts
git commit -m "feat(proactive): add pending session and session counts schemas, paths, state CRUD"
```

---

## Task 2: Session Service — Accept Overrides

**Files:**
- Modify: `src/services/session.service.ts`

- [ ] **Step 1: Update `runFundSession` signature and override logic**

Change the options type (line 27):

```typescript
  options?: {
    focus?: string;
    useDebateSkills?: boolean;
    maxTurns?: number;
    maxDurationMinutes?: number;
  },
```

Update the focus resolution (line 32) to NOT throw when sessionConfig is missing but options.focus is provided:

```typescript
  const sessionConfig = config.schedule.sessions[sessionType];
  const focus = options?.focus ?? sessionConfig?.focus;
  if (!focus) {
    throw new Error(
      `Session type '${sessionType}' not found in fund '${fundName}'`,
    );
  }
```

This already works — `options.focus` takes priority. No change needed here.

Update the timeout and maxTurns to use overrides (around lines 68-69):

```typescript
  const model = config.claude.model || undefined;
  const effectiveMaxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
  const effectiveDuration = options?.maxDurationMinutes
    ?? sessionConfig?.max_duration_minutes
    ?? DEFAULT_SESSION_TIMEOUT_MINUTES;
  const timeout = effectiveDuration * 60 * 1000;
```

Update both `runAgentQuery` calls to use `effectiveMaxTurns` instead of `DEFAULT_MAX_TURNS`.

- [ ] **Step 2: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/session.service.ts
git commit -m "feat(proactive): accept maxTurns and maxDurationMinutes overrides in runFundSession"
```

---

## Task 3: News-Triggered Sessions

**Files:**
- Modify: `src/services/news.service.ts`

- [ ] **Step 1: Add imports and enqueue logic to `checkBreakingNews`**

Add imports at top:
```typescript
import { randomUUID } from "node:crypto";
import { readPendingSessions, writePendingSessions, readSessionCounts, writeSessionCounts } from "../state.js";
```

Inside `checkBreakingNews`, after the existing Telegram alert sending (after the `sendTelegramNotification` call), add session enqueuing:

```typescript
        // Enqueue news reaction session for each affected fund
        for (const fundName of notifyFunds) {
          try {
            const counts = await readSessionCounts(fundName);
            const today = new Date().toISOString().split("T")[0];

            // Reset counts if date changed
            if (counts.date !== today) {
              counts.date = today;
              counts.news = 0;
              counts.agent = 0;
              counts.last_news_at = undefined;
              counts.last_agent_at = undefined;
            }

            // Check limits: max 5/day, max 1/hour
            if (counts.news >= 5) continue;
            if (counts.last_news_at) {
              const elapsed = Date.now() - new Date(counts.last_news_at).getTime();
              if (elapsed < 60 * 60 * 1000) continue; // 1 hour min interval
            }

            // Enqueue pending session
            const pending = await readPendingSessions(fundName);
            const symbols = article.symbols.length > 0 ? article.symbols.join(", ") : "general market";
            pending.push({
              id: randomUUID(),
              type: "news_reaction",
              focus: `NEWS REACTION SESSION: ${article.source} reported "${article.title}".\nSymbols mentioned: ${symbols}.\nAnalyze the impact on your portfolio. If immediate action is needed (stop-loss adjustment, position reduction, hedge), execute it. If no action needed, document your reasoning in memory.\nThis is a short session (5 min, 10 turns) — be decisive.`,
              scheduled_at: new Date(Date.now() + 60_000).toISOString(), // +1 min
              created_at: new Date().toISOString(),
              source: "news",
              max_turns: 10,
              max_duration_minutes: 5,
              priority: "high",
            });
            await writePendingSessions(fundName, pending);

            // Update counts
            counts.news += 1;
            counts.last_news_at = new Date().toISOString();
            await writeSessionCounts(fundName, counts);
          } catch { /* best effort — alert was already sent */ }
        }
```

- [ ] **Step 2: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/services/news.service.ts
git commit -m "feat(proactive): enqueue news reaction sessions on breaking news"
```

---

## Task 4: Daemon — Pending Session Processor

**Files:**
- Modify: `src/services/daemon.service.ts`
- Modify: `tests/daemon-integration.test.ts`

- [ ] **Step 1: Add imports to daemon**

```typescript
import { readPendingSessions, writePendingSessions, readSessionCounts, writeSessionCounts } from "../state.js";
```

- [ ] **Step 2: Add pending session processor inside the per-fund callback**

After the stop-loss check block (after the `releaseFundLock` for stoploss) and before the `catch` block that closes the per-fund processing, add:

```typescript
            // ── Pending sessions (proactive: news reactions, agent follow-ups) ──
            try {
              let pending = await readPendingSessions(name);
              if (pending.length === 0) { /* skip */ }
              else {
                const nowMs = Date.now();
                const nowIso = new Date().toISOString();
                const today = nowIso.split("T")[0];

                // Discard stale (>1h past) and too-far-future (>24h) entries
                pending = pending.filter((s) => {
                  const schedMs = new Date(s.scheduled_at).getTime();
                  if (nowMs - schedMs > 60 * 60 * 1000) return false; // stale
                  if (schedMs - nowMs > 24 * 60 * 60 * 1000) return false; // too far
                  return true;
                });

                // Find due entries
                const due = pending
                  .filter((s) => new Date(s.scheduled_at).getTime() <= nowMs)
                  .sort((a, b) => {
                    const prio = (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1);
                    if (prio !== 0) return prio;
                    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
                  });

                if (due.length > 0) {
                  const session = due[0]!;
                  let counts = await readSessionCounts(name);

                  // Reset counts if date changed
                  if (counts.date !== today) {
                    counts = { date: today, agent: 0, news: 0 };
                  }

                  // Check source-specific limits
                  let withinLimits = true;
                  if (session.source === "agent") {
                    if (counts.agent >= 5) withinLimits = false;
                    if (counts.last_agent_at) {
                      const elapsed = nowMs - new Date(counts.last_agent_at).getTime();
                      if (elapsed < 5 * 60 * 1000) withinLimits = false;
                    }
                  } else if (session.source === "news") {
                    if (counts.news >= 5) withinLimits = false;
                    if (counts.last_news_at) {
                      const elapsed = nowMs - new Date(counts.last_news_at).getTime();
                      if (elapsed < 60 * 60 * 1000) withinLimits = false;
                    }
                  }

                  if (withinLimits && (await acquireFundLock(name, session.type))) {
                    try {
                      await log(`[proactive] Running ${session.type} for '${name}' (source: ${session.source})`);
                      await withTimeout(
                        runFundSession(name, session.type, {
                          focus: session.focus,
                          maxTurns: session.max_turns,
                          maxDurationMinutes: session.max_duration_minutes,
                        }),
                        (session.max_duration_minutes ?? 5) * 60 * 1000,
                      );

                      // Update counts
                      if (session.source === "agent") {
                        counts.agent += 1;
                        counts.last_agent_at = nowIso;
                      } else {
                        counts.news += 1;
                        counts.last_news_at = nowIso;
                      }
                      await writeSessionCounts(name, counts);
                    } catch (err) {
                      await log(`[proactive] Error in ${session.type} for '${name}': ${err}`);
                    } finally {
                      await releaseFundLock(name);
                    }
                  } else if (!withinLimits) {
                    await log(`[proactive] Limit reached for '${name}' (${session.source}), skipping ${session.type}`);
                  }

                  // Remove executed or skipped session from queue
                  pending = pending.filter((s) => s.id !== session.id);
                }

                // Write back cleaned pending list
                await writePendingSessions(name, pending);
              }
            } catch (err) {
              await log(`[proactive] Error processing pending sessions for '${name}': ${err}`);
            }
```

- [ ] **Step 3: Add mocks to daemon integration tests**

In `tests/daemon-integration.test.ts`, add to the `../src/state.js` mock:

```typescript
readPendingSessions: vi.fn().mockResolvedValue([]),
writePendingSessions: vi.fn().mockResolvedValue(undefined),
readSessionCounts: vi.fn().mockResolvedValue({ date: "2026-01-01", agent: 0, news: 0 }),
writeSessionCounts: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 4: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/daemon.service.ts tests/daemon-integration.test.ts
git commit -m "feat(proactive): process pending sessions in daemon cron tick with rate limiting"
```

---

## Task 5: Self-Scheduling Rule

**Files:**
- Modify: `src/skills.ts`

- [ ] **Step 1: Add `SELF_SCHEDULING_RULE` to `FUND_RULES` array**

Read `src/skills.ts` and find the `FUND_RULES` array. Add a new entry:

```typescript
  {
    fileName: "self-scheduling.md",
    content: `# Self-Scheduling

You can schedule follow-up sessions by writing to \`state/pending_sessions.json\`.

## When to Use
- You need to check a price level later (support/resistance break)
- You started an analysis but need fresh data in N minutes
- You placed a limit order and want to verify execution
- You want to review a position after a specific event window

## How
Read \`state/pending_sessions.json\` (create as \`[]\` if missing). Append an entry:

\`\`\`json
{
  "id": "<generate a unique id>",
  "type": "agent_followup",
  "focus": "<specific objective for the follow-up session>",
  "scheduled_at": "<ISO timestamp, minimum 5 min from now>",
  "created_at": "<current ISO timestamp>",
  "source": "agent",
  "max_turns": 10,
  "max_duration_minutes": 5,
  "priority": "normal"
}
\`\`\`

Then write the updated array back to \`state/pending_sessions.json\`.

## Limits
- Max 5 self-scheduled sessions per day
- Minimum 5 minutes between sessions
- Maximum 24 hours in the future
- Keep follow-ups short and focused — one objective per session
- Do NOT schedule follow-ups for routine work that the next regular session will handle

## Good Follow-Up Reasons
- "Check if GLD broke $420 support in the next 30 min"
- "Verify limit order for 50 shares GDXJ filled after market open"
- "Review portfolio after FOMC statement release at 14:30"

## Bad Follow-Up Reasons
- "Continue general analysis" (wait for next scheduled session)
- "Check market again" (too vague — what specifically?)
`,
  },
```

- [ ] **Step 2: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/skills.ts
git commit -m "feat(proactive): add self-scheduling rule for agent follow-up sessions"
```

---

## Task 6: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 4: Upgrade all funds to get the new rule**

```bash
for f in Growth pm-survivor prueba runway-metal; do
  npx tsx -e "import { upgradeFund } from './src/services/fund.service.js'; upgradeFund('$f').then(r => console.log('Upgraded:', r.fundName))"
done
```

Verify:
```bash
cat ~/.fundx/funds/prueba/.claude/rules/self-scheduling.md | head -5
# Should show "# Self-Scheduling"
```

- [ ] **Step 5: Manual smoke test**

```bash
# Restart daemon
pnpm dev -- stop && pnpm dev -- start

# Wait for a news fetch cycle (5 min) with high-impact news
# Check daemon log for proactive session triggers:
grep proactive ~/.fundx/daemon.log

# Create a test pending session manually:
echo '[{"id":"test-1","type":"agent_followup","focus":"Test follow-up","scheduled_at":"'$(date -u -v+2M +%Y-%m-%dT%H:%M:%SZ)'","created_at":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","source":"agent","max_turns":10,"max_duration_minutes":5,"priority":"normal"}]' > ~/.fundx/funds/prueba/state/pending_sessions.json

# Wait 2-3 min, check if it ran:
grep proactive ~/.fundx/daemon.log
```

- [ ] **Step 6: Commit if fixes needed**

```bash
git add -A
git commit -m "fix(proactive): integration fixes"
```
