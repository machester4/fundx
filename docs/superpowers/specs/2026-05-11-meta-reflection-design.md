# Meta-Reflection — Weekly Memory Consolidation

**Date:** 2026-05-11
**Status:** Draft (awaiting user review)
**Owner:** michael
**Roadmap context:** First evolutionary-harness phase after L3 reliability close-out (`docs/superpowers/specs/2026-05-10-l3-reliability-design.md`). Refines L3 by closing the learning loop. Explicitly **not** chasing L4 (no auto-modification of skills/rules).

## Goal

Add a weekly autonomous session (`meta_reflection`) that distills archived handoffs and recent journal entries into consolidated lessons in the per-fund `memory/*.md` files. This closes the gap observed empirically (see "Motivation") where the agent is learning per-session but not persisting consolidated knowledge across sessions.

**Out of scope** (deferred):
- Auto-modification of skills/rules from drift signals (L4 territory).
- Cross-fund memory consolidation — each fund consolidates its own memory.
- Regime-specialist sub-agents, BOCPD drift detection, regime-policies hard switch — separate phase candidates from the same literature review. This spec covers the learning-loop axis only; regime-adaptation gets its own spec when prioritized.
- CoALA formal reorganization of `state/` directory (`episodic/` / `semantic/` / `procedural/` split). The current implicit separation (handoffs+journal=episodic, memory=semantic, skills=procedural) is sufficient; no rename needed.

## Motivation

Empirical audit on 2026-05-11 across four production funds revealed a clear gap:

| Fund | Archived handoffs | Trades | Memory lines written by agent (excl. seeds) |
|---|---|---|---|
| runway-metal | 27 | 21 | **~0** |
| pm-survivor | 8 | 0 | **~0** |
| Growth | 27 | 1 | **~19** (rich, specific) |
| fundx-audit | 32 | 7 | **~75** (rich, specific) |

The agent **does** learn per-session (handoffs contain rich reasoning like "Gold falling because: oil inflation → Fed hold → real rates firm → gold headwind", "USO $110 unblock rule maintained", regime-conditioned sizing decisions). But this knowledge stays trapped in handoffs:

- The active `state/session-handoff.md` is rewritten each session — it's a *snapshot*, not consolidation.
- The `state/handoffs/<ts>.md` archive accumulates (27+ files in runway-metal) without distillation. Finding "the USO $110 unblock rule" requires reading 27 files.
- `memory/*.md` is the designed destination for distilled knowledge but is **infrautilized** because the existing `memory-usage.md` rule is non-forcing and the agent prefers the single-file handoff.

Consequence: each session re-derives much of its mental model from snapshots instead of leveraging accumulated lessons. The infrastructure exists (memory files, rule, journal+FTS5+embeddings, snapshot envelope, skills) — what's missing is a **forcing function** for consolidation.

This matches the canonical pattern from Generative Agents (Park et al., Stanford 2023) and CoALA semantic layer (Sumers et al., 2024): periodic reflection synthesis that distills N episodic events into a small number of higher-level beliefs.

## Architecture & module layout

A new session type `meta_reflection` runs weekly (Sunday 18:00 UTC) per active fund, separately from the trading session schedule. It reads recent handoffs and journal entries, distills lessons via a dedicated skill, and appends them to the existing `memory/*.md` files.

```
src/
  services/
    meta-reflection.service.ts      (NEW) — orchestration: list handoffs since cursor,
                                              build prompt input, enforce caps post-run,
                                              tracker CRUD
    session.service.ts              (modify) — extend SessionType union, add branch in
                                              buildAutonomousPrompt for meta_reflection,
                                              respect daily cap and watchdog
    daemon.service.ts               (modify) — register weekly cron entry per active fund
    handoff-archive.service.ts      (modify) — export listHandoffsSince(fundRoot, cursorIso)
                                              helper (filter by mtime)
  skills.ts                          (modify) — append BUILTIN_SKILLS entry: memory-consolidation
  types.ts                           (modify) — extend SessionType Zod, add LastConsolidationState
                                              schema and inferred type
  paths.ts                           (modify) — add lastConsolidationPath(fundName) helper
  commands/
    fund/
      consolidate.tsx               (NEW) — `fundx fund consolidate <name>` for manual
                                              backfill / ad-hoc trigger
tests/
  meta-reflection.test.ts           (NEW) — unit tests for cursor logic, cap enforcement,
                                              tracker CRUD, skip path
  integration/
    meta-reflection-tick.test.ts    (NEW) — end-to-end: ephemeral fund, seeded archive,
                                              mocked SDK, verify memory growth + cursor advance
  eval/
    cases/
      mvp-meta-reflection.yaml      (NEW) — eval case with LLM-judge rubric on distillation quality
docs/
  operations.md                     (modify) — runbook section: how to verify weekly consolidations
                                              ran, how to backfill, what to do on errors
CLAUDE.md                           (modify) — document the new session type and its semantics
```

### Why a new session type vs piggybacking

The `session-reflection` skill already runs at the end of trading sessions and could in principle be extended to also write `memory/*.md`. We rejected that because:

1. **Concerns mixed**: trading-session reflection focuses on the most recent decisions; meta-reflection focuses on patterns across N sessions. The mental modes are different.
2. **No forcing function gain**: the rule already says to write memory; the reason it doesn't get followed isn't that it's missing from the reflect phase — it's that there's no isolated, focused consolidation step.
3. **Cost amplification**: every trading session would carry consolidation overhead (~$0.30+/session × 4 sessions/day × 7 days = $8+/week vs. ~$0.50/week for the dedicated session).
4. **Verifiability**: a separate session type produces its own log entry and tracker, making it trivial to audit "did consolidations run, when, with what cost, producing how many lessons".

## Data flow

### Tracker file: `state/last_consolidation.json`

```typescript
// types.ts
export const lastConsolidationStateSchema = z.object({
  cursor_iso: z.string().datetime(),       // mtime of newest handoff processed last run
  last_run_iso: z.string().datetime(),     // when the job last executed (may differ if no_data)
  status: z.enum(["success", "no_data", "skipped_daily_cap", "error"]),
  n_handoffs_processed: z.number().int().min(0),
  n_journal_entries: z.number().int().min(0),
  n_lessons_written: z.number().int().min(0),
  cost_usd: z.number().min(0),
  error: z.string().optional(),            // populated when status=error
});
export type LastConsolidationState = z.infer<typeof lastConsolidationStateSchema>;
```

If the file does not exist on first run → cursor virtual = epoch 0 (process all available handoffs and journal entries). The first invocation per fund may therefore be larger; see "Migration & rollout" for backfill strategy.

### Input building (`buildMetaReflectionPrompt`)

Pseudocode:

```
const cursor = readTracker(fund).cursor_iso ?? "1970-01-01T00:00:00Z";

const newHandoffs = await listHandoffsSince(fund, cursor);  // sorted by mtime asc
const newJournalRows = queryJournal(fund, "entry_date >= ? OR exit_date >= ?", [cursor, cursor]);
const currentMemory = await readMemoryFiles(fund);

if (newHandoffs.length === 0 && newJournalRows.length === 0) {
  writeTracker(fund, { ...prev, last_run_iso: nowIso, status: "no_data" });
  return;  // skip SDK call entirely
}

const prompt = renderTemplate({
  fund, cursor, newHandoffs, newJournalRows, currentMemory,
});
```

Prompt structure (consistent with the existing `<state_snapshot>` envelope convention from Phase 2):

```
Session mode: autonomous scheduled

<state_snapshot>
Fund: {name}
Objective: {one-line summary}
Portfolio: {one-line summary — positions count, cash, total value}
Memory state:
  - market-lessons.md: {N} entries, last update {date}
  - trading-patterns.md: {N} entries, last update {date}
  - fund-notes.md: {N} entries, last update {date}
Last consolidation: {cursor_iso} ({days_ago} days ago)
</state_snapshot>

<handoffs_to_process>
{N handoffs concatenated, oldest first, separated by ---}
</handoffs_to_process>

<journal_entries_to_process>
{Rows from trade_journal.sqlite as compact records}
</journal_entries_to_process>

<current_memory>
{Full contents of the three memory files}
</current_memory>

<task>
Distill new lessons from the handoffs and journal entries above. Each lesson must:
- Be 1-3 sentences with specific data (prices, dates, indicators).
- Not duplicate anything already in <current_memory>.
- Route to the appropriate file:
  - market-lessons.md: regime/sector/macro patterns observed
  - trading-patterns.md: setup/timing/sizing patterns observed
  - fund-notes.md: fund-strategy reflections (objective progress, drawdown handling)

Use the Write tool to APPEND each lesson to the appropriate memory file in this format:

## YYYY-MM-DD — Title

Body (1-3 sentences with specific data).

If no genuinely new lesson is worth recording, write nothing — quality over quantity.
</task>
```

The skill `memory-consolidation` (defined in `BUILTIN_SKILLS`) provides reusable technique guidance (when to use, what counts as a good lesson, anti-patterns) referenced from the prompt's task section.

### Cap enforcement (post-run, deterministic helper)

After `runFundSession` returns (success path), `meta-reflection.service.ts` runs `enforceMemoryCap(filePath, cap)` per memory file:

- Read file
- Split content by regex `/^## (\d{4}-\d{2}-\d{2}) — /m` — each match starts a new entry block
- Preserve frontmatter (the `---\ndescription: ...\n---` block created by `ensureFundMemory`) and any prelude before the first entry
- If `entries.length > cap`: drop the oldest (entries are appended, so oldest = earliest in file order)
- Rewrite file using the same tmp + rename atomic pattern used in `src/state.ts` (extract a small `writeFileAtomic` helper into `src/state.ts` if it doesn't already exist; today only `writeJsonAtomic` is exposed)

Cap enforcement is **not** placed in a Stop hook because: (a) Stop hooks are reserved for verdict-gating logic where atomicity with the SDK call matters; (b) the cap is a tidy-up step that doesn't affect what the agent sees in this session, only what future sessions see; (c) keeping it in `meta-reflection.service.ts` keeps the module's responsibility complete and self-contained.

Caps:
- `market-lessons.md`: 50 entries
- `trading-patterns.md`: 50 entries
- `fund-notes.md`: 30 entries

These caps are tunable in a future iteration if observed growth shows they're too tight or too loose. Initial values are conservative (~1 year of weekly entries).

### Cursor advance

After the SDK session ends successfully:

```
const newCursor = max(handoff.mtime for handoff in newHandoffs);  // or current cursor if no handoffs
writeTracker(fund, {
  cursor_iso: newCursor,
  last_run_iso: nowIso,
  status: "success",
  n_handoffs_processed: newHandoffs.length,
  n_journal_entries: newJournalRows.length,
  n_lessons_written: countAddedEntries(memoryDiff),
  cost_usd: sessionCostUsd,
});
```

If the SDK session errors or times out: the cursor is **not** advanced. Next run will reprocess. Idempotency is preserved by the agent's instruction to not duplicate existing memory entries.

### Daily cap interaction

Sunday 18:00 UTC = market closed; no competition with trading sessions. The meta-reflection cost still counts toward the fund's `dailyCapUsd` (default $20 since Phase 5c). Expected cost per run is ~$0.30-0.75, well under the cap. If the cap is somehow already exhausted, status becomes `skipped_daily_cap`, `last_run_iso` advances to today, and the job retries next Sunday.

## Implementation outline

### `memory-consolidation` skill (in `BUILTIN_SKILLS`)

```yaml
---
name: memory-consolidation
description: Distill recent handoffs and journal entries into lessons appended to memory/*.md. Use only during meta_reflection sessions, never during trading sessions.
---

# Memory Consolidation

## When to Use
Only during sessions started with type `meta_reflection`. The session input contains
<handoffs_to_process>, <journal_entries_to_process>, and <current_memory>.

## When NOT to Use
- Trading sessions (pre_market / mid_session / post_market / news_reaction): they use
  session-reflection at end-of-session for per-session writes.
- If <handoffs_to_process> and <journal_entries_to_process> are both empty: the
  orchestrator should have skipped the SDK call; nothing to do.

## Technique
1. Read <current_memory> first to understand what is already recorded.
2. Scan handoffs chronologically. For each, look for:
   - Regime-conditioned outcomes ("X strategy worked/failed in regime Y")
   - Setup invalidations ("X pattern broke down because Y")
   - Sector/sub-sector behavior tied to specific catalysts
   - Sizing decisions that paid off or backfired
   - Calibration evidence ("predicted X, actual Y")
3. Cross-check journal entries: look for repeated themes across multiple trades
   that wouldn't be obvious from one handoff.
4. Aggressive deduplication: if the lesson is already in <current_memory>, skip it.
5. Quality over quantity: it is acceptable (and preferable) to write zero new lessons
   if nothing genuinely new emerged. An average week should produce 2-5 new lessons.

## Anti-patterns
- "This week the market was volatile." — not specific, not actionable.
- "AAPL went up." — observation, not lesson.
- Re-statement of an existing memory entry with different wording — duplication.
- Generic platitudes ("manage risk", "stick to the plan") — already encoded in skills/rules.

## Output Format
Use the Write tool to append entries to the appropriate file:

  ## YYYY-MM-DD — Concise Title

  Body: 1-3 sentences with specific data points (prices, ratios, dates, indicators).
  End with the lesson made explicit.

Routing:
- `memory/market-lessons.md`: regime/sector/macro patterns
- `memory/trading-patterns.md`: setup/timing/sizing patterns
- `memory/fund-notes.md`: fund-strategy reflections

Do not modify entries already in the files. Append only.
```

### Cron registration in `daemon.service.ts`

Add per-active-fund cron entry at startup:

```typescript
// Sunday 18:00 UTC
cron.schedule("0 18 * * 0", async () => {
  for (const fund of getActiveFunds()) {
    await runFundSession({ fund, sessionType: "meta_reflection" });
  }
}, { timezone: "UTC" });
```

If a fund is paused, `runFundSession` skips it (existing behavior).

### Manual command: `fundx fund consolidate <name>`

Pastel command that invokes the same path as the cron job for a single fund. Used for:
- Initial backfill on existing funds with large handoff archives.
- Ad-hoc trigger when the user knows there's significant new context worth consolidating.
- Smoke testing after deployment.

Streams output to terminal (reuse existing `useStreaming` hook pattern from chat REPL).

## Testing

### Unit tests (`tests/meta-reflection.test.ts`)

- `listHandoffsSince(cursor)`:
  - Returns all handoffs newer than cursor, sorted by mtime ascending.
  - Empty array when no archive exists.
  - Empty array when all handoffs older than cursor.
- `enforceMemoryCap(filePath, cap)`:
  - `entries.length < cap` → file unchanged.
  - `entries.length > cap` → oldest dropped to reach cap, frontmatter preserved.
  - Seed-only file (no entries) → unchanged.
  - File with malformed entries (no `## YYYY-MM-DD`) → preserved, no drop.
- `LastConsolidationState` Zod schema:
  - Valid object parses.
  - Missing fields rejected.
  - Bad ISO date rejected.
- Cursor advance helper:
  - `newCursor = max(handoff mtimes)`.
  - Falls back to current cursor when `n_new = 0`.
- Skip path:
  - `n_handoffs_new + n_journal_new === 0` → no SDK call, status=`no_data`, `last_run_iso` advances.

### Integration test (`tests/integration/meta-reflection-tick.test.ts`)

Vitest project under existing `vitest.integration.config.ts`:

- Setup: ephemeral fund (using existing `seedEvalFund` helper), seed 5 handoffs in `state/handoffs/`, seed 2 journal rows.
- Mock SDK responses to write 3 entries across the three memory files.
- Trigger via `fundx fund consolidate <name>`.
- Assert:
  - `memory/market-lessons.md`, `memory/trading-patterns.md`, `memory/fund-notes.md` contain the new entries.
  - `state/last_consolidation.json` populated with `status: "success"`, correct counts, cursor = max mtime of seeded handoffs.
  - `state/session_log.jsonl` has a new entry with `session_type: "meta_reflection"`.
- Re-run immediately:
  - `n_new = 0` → skip SDK call.
  - `state/last_consolidation.json` updated with `status: "no_data"`, `last_run_iso` advanced, cursor unchanged.

### Eval case (`tests/eval/cases/mvp-meta-reflection.yaml`)

Requires extending `src/services/eval/runner.ts` with a new `surface: "meta_reflection"` branch that calls `runFundSession({ sessionType: "meta_reflection" })` instead of chat/ask paths.

```yaml
id: mvp-meta-reflection
surface: meta_reflection
fund_state:
  base: growth-with-handoffs        # new fixture: fund with 5 realistic handoffs + 3 trades
expect:
  must_invoke: [Read, Write]
  must_not_invoke:
    - mcp__broker-local__place_order
    - mcp__broker-local__cancel_order
    - mcp__telegram-notify__send_trade_alert
  max_turns: 15
  max_usd: 1.00
  judge:
    model: claude-opus-4-7
    rubric: |
      Score 1-5 each:
      1. Specificity: do entries include concrete data (prices, dates, indicators)?
      2. Non-duplication: do entries avoid repeating what was already in current_memory?
      3. Routing: did entries land in the right file (market-lessons vs trading-patterns vs fund-notes)?
      4. Format: do entries match `## YYYY-MM-DD — Title\n\nBody.` exactly?
      5. Restraint: are there NO generic platitudes ("manage risk", "stick to plan")?
      Pass = avg >= 3.5.
```

### Smoke procedure (post-deploy)

1. `pnpm build && fundx fund upgrade --all` (propagate skill files to existing funds).
2. `fundx fund consolidate fundx-audit` (manual backfill on smoke fund — has 32 handoffs).
3. Verify:
   - `memory/market-lessons.md` grew with new dated entries.
   - `state/last_consolidation.json` populated correctly.
   - `state/session_log.jsonl` shows the meta_reflection entry.
4. Re-run `fundx fund consolidate fundx-audit` → expect `no_data` status (idempotency).
5. After Sunday's cron fires once, verify all funds got their first auto-run.

## Migration & rollout

### Per-fund backfill

Existing production funds (`runway-metal`, `pm-survivor`, `Growth`) have 8-27 archived handoffs sitting unconsolidated. The first consolidation on each fund will be heavier than steady-state weekly runs.

Strategy: use the manual `fundx fund consolidate <name>` command to backfill each fund individually, watching cost. Expected one-time costs:
- runway-metal (27 handoffs, 21 trades): ~$1.50-2.00.
- Growth (27 handoffs, 1 trade): ~$1.00-1.50.
- pm-survivor (8 handoffs, 0 trades): probably `no_data` after the journal/handoff filter (low activity).
- fundx-audit (32 handoffs, 7 trades): ~$1.50-2.00 (smoke fund — covered by step 2 of the smoke procedure).

Total backfill cost across production funds: ~$5-7 one-time. Steady-state cost: ~$0.30-0.75/fund/week ≈ $1-3/week total at current fund count.

### Schema migration

`state/last_consolidation.json` is a new file. Funds that don't have it use cursor = epoch 0 on first run (process all available history). No code-level migration required — just create-on-first-run behavior in `meta-reflection.service.ts`.

### Skill propagation

`fundx fund upgrade --all` rewrites `.claude/skills/` and `.claude/rules/` from `BUILTIN_SKILLS` and `FUND_RULES` in `src/skills.ts`. Adding `memory-consolidation` to `BUILTIN_SKILLS` and running upgrade-all is the propagation step (existing pattern, no new mechanism).

### Telegram notification

Meta-reflection sessions count toward the daily digest summary like normal sessions. No dedicated alert (low signal). On error, the existing watchdog/error notification path fires.

## Open questions

1. **Cap defaults (50/50/30)** — chosen conservatively. Should be revisited after 4-8 weeks of real data to see if any fund hits the cap (likely fund-notes does first, since 30 entries = ~30 weeks ≈ 7 months). If hit, options: raise cap, or add a periodic compaction step (different from cap drop) that LLM-summarizes oldest entries.

2. **Cursor advance on `error` status** — current design does not advance, so next run reprocesses. Risk: if errors are persistent (e.g., bad handoff format breaks the prompt), the same set is reprocessed every week. Mitigation: after 3 consecutive `error` runs, force-advance the cursor and Telegram-alert the user. Defer this until we observe the failure mode in production.

3. **Should `meta_reflection` invoke any sub-agent?** Current design: no. The skill is light enough to run with the main agent, no Task tool needed. If the eval shows distillation quality is weak, consider adding a `memory-curator` sub-agent specialized for this. Defer.

4. **Per-fund cadence override** — current design hardcodes weekly Sunday. A future iteration could allow `fund_config.yaml` to override (e.g., very-low-activity funds → bisemanal). Defer until a concrete fund needs it.
