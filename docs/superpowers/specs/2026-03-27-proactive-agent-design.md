# Proactive Agent Design

## Problem

FundX agents are strictly passive — they only wake up on scheduled cron times, manual CLI commands, or Telegram questions. Breaking news sends Telegram alerts but doesn't trigger analysis sessions. Agents cannot schedule their own follow-ups. This means missed trading opportunities between scheduled sessions and no autonomous reaction to market events.

## Design Decisions

- **Pending sessions queue:** File-based (`state/pending_sessions.json`) — agent writes, daemon reads. Survives restarts, no new MCP server needed.
- **News-triggered sessions:** Breaking news enqueues a short analysis session (10 turns, 5 min). Agent can execute trades if needed.
- **Agent self-scheduling:** Agent writes follow-up requests to the queue during sessions. A rule teaches it how.
- **Limits:** Self-scheduled: max 5/day, min 5 min apart. News-triggered: max 1/hour AND max 5/day.

---

## Section 1: Pending Sessions Queue

Shared infrastructure for both news-triggered and agent-scheduled sessions.

### File: `~/.fundx/funds/<name>/state/pending_sessions.json`

```json
[
  {
    "id": "uuid",
    "type": "news_reaction",
    "focus": "Breaking: Fed emergency rate cut. Analyze impact on gold positions.",
    "scheduled_at": "2026-03-27T14:35:00Z",
    "created_at": "2026-03-27T14:30:00Z",
    "source": "news",
    "max_turns": 10,
    "max_duration_minutes": 5,
    "priority": "high"
  }
]
```

### Daemon processing

Each tick of the per-minute cron (`* * * * *`), after checking regular and special sessions, the daemon:

1. Reads `pending_sessions.json` for each active fund
2. Discard stale entries: `scheduled_at` more than 1 hour in the past (missed window)
3. Discard invalid entries: `scheduled_at` more than 24 hours in the future (agent error)
4. Filters entries where `scheduled_at <= now`
5. Sorts by priority (`high` > `normal`), then by `scheduled_at` (oldest first)
6. Checks limits via `session_counts.json`
7. Executes the highest-priority due session (acquires fund lock first)
8. Removes the executed session from the pending list
9. Increments session counts and updates `last_agent_at` / `last_news_at`
10. If fund lock is held by another operation, waits for next tick

Processing happens **inside** the existing per-fund callback (after all other checks for that fund), within the same `Promise.allSettled` block. This is consistent with the existing pattern and ensures one fund's pending sessions don't block another fund's processing.

**Cooldown vs. session limit interaction:** A fund can receive a Telegram news alert (10-min cooldown) but not get a news session (1-hour interval). This is intentional — alerts are lightweight, sessions are expensive.

### Session counts: `~/.fundx/funds/<name>/state/session_counts.json`

```json
{
  "date": "2026-03-27",
  "agent": 3,
  "news": 2,
  "last_agent_at": "2026-03-27T14:30:00Z",
  "last_news_at": "2026-03-27T13:00:00Z"
}
```

Reset to zeros when date changes (checked at start of each tick).

### Limits enforcement

| Source | Max per day | Min interval |
|--------|------------|--------------|
| `agent` (self-scheduled) | 5 | 5 min between sessions |
| `news` (news-triggered) | 5 | 1 hour between sessions |

When limits are exceeded, the pending session is removed without execution and a warning is logged.

### Schemas (in `src/types.ts`)

```typescript
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

### State functions (in `src/state.ts`)

- `readPendingSessions(fundName): Promise<PendingSession[]>`
- `writePendingSessions(fundName, sessions): Promise<void>`
- `readSessionCounts(fundName): Promise<SessionCounts>`
- `writeSessionCounts(fundName, counts): Promise<void>`

### Path additions (in `src/paths.ts`)

Inside `fundPaths().state`:
- `pendingSessions: join(root, "state", "pending_sessions.json")`
- `sessionCounts: join(root, "state", "session_counts.json")`

### Modified files

- `src/types.ts` — `pendingSessionSchema`, `sessionCountsSchema`
- `src/paths.ts` — add paths to `fundPaths().state`
- `src/state.ts` — CRUD for pending sessions and session counts

---

## Section 2: News-Triggered Sessions

Enhance `checkBreakingNews()` to enqueue a short analysis session in addition to sending a Telegram alert.

### Flow

```
News fetch → checkBreakingNews()
  → Article matches fund tickers + high-impact keywords
  → Check news session limits (1/hour, 5/day via session_counts.json)
  → If within limits:
      → Enqueue pending session (type: "news_reaction", priority: "high")
      → Send Telegram alert (existing behavior, unchanged)
  → If over limits:
      → Send Telegram alert only (existing behavior)
      → Log: "[news] Session limit reached for '<fund>', alert only"
```

### Auto-generated session focus

```
NEWS REACTION SESSION: [source] reported "[headline]".
Symbols mentioned: [matched tickers].
Analyze the impact on your portfolio. If immediate action is needed
(stop-loss adjustment, position reduction, hedge), execute it.
If no action needed, document your reasoning in memory.
This is a short session (5 min, 10 turns) — be decisive.
```

### Scheduling

Session enqueued with `scheduled_at = now + 1 min` (processed in the next daemon tick). Not immediate — avoids resource contention with the fetch cycle.

### Modified files

- `src/services/news.service.ts` — `checkBreakingNews()` enqueues pending session + checks limits

---

## Section 3: Agent Self-Scheduling

The agent can schedule its own follow-up sessions by writing to `state/pending_sessions.json` during a session.

### Mechanism

The agent already has Read/Write access to its `cwd` (the fund directory). During a session:

1. Read `state/pending_sessions.json` (may not exist — treat as `[]`)
2. Append a new entry with `scheduled_at` in the future (minimum 5 min from now)
3. Write back to `state/pending_sessions.json`

The daemon picks it up on the next tick after `scheduled_at`.

### New rule: `.claude/rules/self-scheduling.md`

Generated by `ensureFundRules()` in `src/skills.ts`. Instructs the agent:

- When to self-schedule (price level checks, order verification, analysis continuation, event window review)
- How to write the pending session entry (exact JSON format)
- Limits (max 5/day, min 5 min apart)
- Best practices (one objective per follow-up, be decisive, keep focus specific)

### Modified files

- `src/skills.ts` — add `SELF_SCHEDULING_RULE` to `FUND_RULES`
- Existing funds get the rule via `fundx fund upgrade`

---

## Section 4: Daemon Integration

### Pending session processor in cron tick

Inside the existing per-minute cron callback in `daemon.service.ts`, after processing regular sessions, special sessions, reports, portfolio sync, and stop-loss checks — add pending session processing:

```
For each active fund:
  → readPendingSessions(fundName)
  → Filter: scheduled_at <= now
  → Sort: priority desc, scheduled_at asc
  → readSessionCounts(fundName)
  → Reset counts if date changed
  → For the first due session:
    → Check source-specific limits
    → If within limits AND acquireFundLock():
      → runFundSession(fundName, session.type, { focus, maxTurns, maxDuration })
      → Remove from pending list
      → Increment counts
      → Log and notify
      → releaseFundLock()
    → If over limits:
      → Remove from pending list
      → Log warning
```

### Session type passthrough

`runFundSession` accepts any `sessionType` string and `options.focus`. Pending sessions use types like `news_reaction` and `agent_followup` which are not in `config.schedule.sessions` — the focus comes from the pending session entry, not from config.

The `max_turns` and `max_duration_minutes` from the pending session override the defaults in `runFundSession`. This requires a small change to `session.service.ts` to accept these overrides via options.

### Session service update

Add optional `maxTurns` and `maxDurationMinutes` to `runFundSession` options:

```typescript
export async function runFundSession(
  fundName: string,
  sessionType: string,
  options?: {
    focus?: string;
    useDebateSkills?: boolean;
    maxTurns?: number;
    maxDurationMinutes?: number;
  },
): Promise<void>
```

Override precedence chain:
- `maxTurns`: `options.maxTurns` > `DEFAULT_MAX_TURNS` (50)
- `maxDurationMinutes`: `options.maxDurationMinutes` > `sessionConfig?.max_duration_minutes` > `DEFAULT_SESSION_TIMEOUT_MINUTES` (15)

This means pending sessions with `max_turns: 10` and `max_duration_minutes: 5` will be short and focused as intended.

### Modified files

- `src/services/daemon.service.ts` — add pending session processing to cron tick
- `src/services/session.service.ts` — accept `maxTurns` and `maxDurationMinutes` overrides

---

## Files Summary

### New files

None — all changes are additions to existing files.

### Modified files

| File | Changes |
|------|---------|
| `src/types.ts` | `pendingSessionSchema`, `sessionCountsSchema` |
| `src/paths.ts` | Add `pendingSessions`, `sessionCounts` to `fundPaths().state` |
| `src/state.ts` | CRUD for pending sessions and session counts |
| `src/services/news.service.ts` | `checkBreakingNews()` enqueues pending session + limit checks |
| `src/services/daemon.service.ts` | Pending session processor in cron tick |
| `src/services/session.service.ts` | Accept `maxTurns`, `maxDurationMinutes` overrides |
| `src/skills.ts` | Add `SELF_SCHEDULING_RULE` to `FUND_RULES` |

### Unchanged

- `src/agent.ts` — no changes (no new MCP tools)
- `src/mcp/` — no new MCP servers or tools
- `src/services/gateway.service.ts` — Telegram unchanged
- `src/credentials.ts` — unchanged
