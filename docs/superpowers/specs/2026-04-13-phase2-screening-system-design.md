# Phase 2 — Screening System (V1) Design

## Context

FundX supports 5 fund types (runway, growth, accumulation, income, custom) but has
no mechanism to systematically discover investment opportunities beyond whatever
Claude happens to think about during a session. This produces two failure modes:

1. **Narrow focus.** Claude analyses the same names repeatedly because nothing
   mechanically surfaces alternatives from the broad market.
2. **Lost context.** A ticker that was borderline three months ago — "interesting
   but not quite" — gets forgotten. When conditions change and it becomes a real
   candidate, nothing reminds Claude to revisit it.

Phase 1 (the research doc at `research/screening-strategies.md`) catalogued 30
screening strategies from the literature. Phase 2 (this design) builds the
infrastructure to actually run screens inside FundX, persist their results as a
living watchlist with trajectory, and feed that watchlist back into autonomous
sessions and chat.

V1 scope is deliberately narrow: **one screen end-to-end**, proving the full
pipeline (fetch → score → persist → re-evaluate → surface to Claude) before
multiplying. Additional screens and data sources are follow-up iterations.

## Goals

- A persistent, workspace-wide watchlist of tickers surfaced by screens, with
  status trajectory (not just point-in-time scores).
- A single deterministic screen (12-1 momentum) running end-to-end on autopilot.
- Three execution paths for the screen: daemon cron (post-market daily), on-demand
  via chat (Claude invokes an MCP tool), and CLI command (`fundx screen run`).
- Integration into the autonomous session loop: at Orient, each fund reads its
  relevant watchlist entries and includes them in the Session Contract.
- Manual override: user can tag tickers (`fundx screen tag <ticker> <status>`)
  to correct or close the loop on candidates Claude dismisses.

## Non-goals

- Additional screens beyond 12-1 momentum (mean-reversion, value, quality, income
  screens are deferred to Phase 2.2+).
- Fundamentals data integration (blocks Piotroski, Magic Formula, QMJ — Phase 2.2).
- Macro / regime overlay from FRED (Phase 2.3).
- Crypto, options, REITs, insider trading screens.
- Historical backtesting or empirical validation of screens — the literature in
  `research/screening-strategies.md` is the prior; we trust it for V1.
- Rich TUI visualisation of watchlist trajectory — V1 ships CLI tables only.

## Architecture

```
                ~/.fundx/state/watchlist.sqlite     (workspace-wide)
                           ↑  (only writer)
                           │
                  src/services/screening.service.ts
                  (pure deterministic logic)
                     ↑            ↑             ↑
                     │            │             │
            daemon cron    screener MCP     CLI command
            (post-market)  (Claude chat /   (fundx screen run)
                            autonomous)
                                 │
                                 ↓
                opportunity-screening skill
                (per-fund; used at Orient and
                 when user asks for opportunities)
```

The service is the single source of truth. Cron, MCP tools, and CLI commands are
thin callers that do not duplicate logic. Claude never touches the sqlite file
directly — it always goes through the screener MCP server.

## Data model — `~/.fundx/state/watchlist.sqlite`

All timestamps are unix ms. All JSON fields are validated with Zod on
serialisation/deserialisation; schemas live in `src/types.ts`.

```sql
-- Audit trail of every screen run
CREATE TABLE screen_runs (
  id               INTEGER PRIMARY KEY,
  screen_name      TEXT    NOT NULL,       -- 'momentum-12-1'
  universe         TEXT    NOT NULL,       -- 'sp500' | 'custom:<hash>'
  ran_at           INTEGER NOT NULL,
  tickers_scored   INTEGER NOT NULL,
  tickers_passed   INTEGER NOT NULL,
  duration_ms      INTEGER NOT NULL,
  parameters_json  TEXT    NOT NULL        -- snapshot of screen config
);

-- One row per (ticker, run). Score + pass/fail + screen-specific detail.
CREATE TABLE scores (
  id             INTEGER PRIMARY KEY,
  run_id         INTEGER NOT NULL REFERENCES screen_runs(id),
  ticker         TEXT    NOT NULL,
  screen_name    TEXT    NOT NULL,       -- denormalised for fast queries
  score          REAL    NOT NULL,       -- primary ranking metric
  passed         INTEGER NOT NULL,       -- 0 | 1
  metadata_json  TEXT    NOT NULL,       -- screen-specific: {'12m_return': 0.34, 'adv_usd': 18e6, ...}
  scored_at      INTEGER NOT NULL
);
CREATE INDEX idx_scores_ticker_time ON scores(ticker, scored_at DESC);
CREATE INDEX idx_scores_screen_time ON scores(screen_name, scored_at DESC);
CREATE INDEX idx_scores_run          ON scores(run_id);

-- Current aggregate state per ticker. One row per ticker ever seen.
CREATE TABLE watchlist (
  ticker                TEXT    PRIMARY KEY,
  status                TEXT    NOT NULL,      -- candidate | watching | fading | stale | rejected
  first_surfaced_at     INTEGER NOT NULL,
  last_evaluated_at     INTEGER NOT NULL,
  current_screens_json  TEXT    NOT NULL,      -- array of screen names currently passing
  peak_score            REAL,                  -- tracked for fading detection
  peak_score_at         INTEGER,
  notes                 TEXT                   -- free-form, editable via CLI/MCP
);

-- Fund compatibility tags. A ticker can match multiple funds simultaneously.
CREATE TABLE watchlist_fund_tags (
  ticker      TEXT    NOT NULL,
  fund_name   TEXT    NOT NULL,
  compatible  INTEGER NOT NULL,       -- 1 if passes fund's universe/constraints
  tagged_at   INTEGER NOT NULL,
  PRIMARY KEY (ticker, fund_name)
);

-- Trajectory: every state transition. Needed to answer "when did this change?"
CREATE TABLE status_transitions (
  id                INTEGER PRIMARY KEY,
  ticker            TEXT    NOT NULL,
  from_status       TEXT,                         -- NULL for initial
  to_status         TEXT    NOT NULL,
  reason            TEXT    NOT NULL,             -- 'passed_screen_momentum-12-1' | 'score_drop_20pct' | 'manual:<user>' | ...
  transitioned_at   INTEGER NOT NULL
);
CREATE INDEX idx_transitions_ticker ON status_transitions(ticker, transitioned_at DESC);
```

## State transition rules

Transitions are computed and applied at the end of each screen run. The
screening service orchestrates the run (fetch → score → insert score rows), then
delegates transition computation to `watchlist.service.ts`, which applies all
transitions for the run in a single sqlite transaction.

| From | To | Trigger |
|---|---|---|
| `ø` | `candidate` | Ticker passes a screen for the first time (no prior `watchlist` row). |
| `candidate` | `watching` | Passes the same screen in ≥ 2 consecutive runs. |
| `watching` | `fading` | Latest score is ≥ 20% below `peak_score` AND `peak_score_at` is within last 60 days. |
| `fading` | `rejected` | Fails screen in 3 consecutive runs OR 30 days elapsed with no passing run. |
| `fading` | `watching` | Re-passes the screen AND new score is within 10% of prior peak. **This is the "4–5 months later" revisit trigger.** |
| `*` | `stale` | No score update for 90 days (ticker fell out of universe, data gap, etc.). |
| `rejected` | `*` | Terminal automatically; only manual override can re-enter the funnel. |
| `any` | `any` | Manual override via CLI `fundx screen tag` or MCP `watchlist_tag`. Always allowed; logged with `reason='manual:<who>:<note>'`. |

**Peak tracking:** `peak_score` is updated to the max observed score within the
last 60 days on every new score insertion. When the 60-day window slides past the
current peak, peak is recomputed from scores in the new window.

## V1 screen — 12-1 momentum

Picked because (a) it needs only daily price history (no fundamentals), (b)
academic foundation (Jegadeesh & Titman, 1993), (c) produces a clean numeric score
that maps naturally to the state machine.

**Rules (hardcoded in V1; config-driven in a later iteration):**

- **Universe:** S&P 500 constituents (default). Override via
  `fundx screen run --universe custom:path/to/tickers.txt`.
- **Inputs:** 13 months (273 trading days) of daily closes, dividend-adjusted,
  per ticker.
- **Signal:** cumulative return from 12 months ago to 1 month ago (skip the most
  recent month). Formula: `close[t-21] / close[t-252] - 1`.
- **Exclusions:**
  - 30-day average daily dollar volume < $10M
  - Current price < $5
  - Any ticker with missing data for more than 10% of the lookback window
- **Ranking:** top decile of scored universe (~50 names from S&P 500).
- **Passed criterion:** in the top decile AND score > 0 (absolute return positive).
- **Run cadence:** daily scoring (cheap, populates trajectory). Note: this is
  the screen's re-scoring cadence, not a rebalance signal for any fund — actual
  position rebalancing decisions happen at the fund level in autonomous sessions.

## Data infrastructure

**Additions to `src/services/market.service.ts`:**

- `getHistoricalDaily(ticker: string, days: number): Promise<DailyBar[]>` — wraps
  FMP `/historical-price-full`. Returns dividend-adjusted closes.
- `getSp500Constituents(): Promise<string[]>` — wraps FMP `/sp500_constituent`. V1
  can hardcode fallback list in `src/constants.ts` if FMP endpoint isn't in the
  user's plan.

**New file `src/services/price-cache.service.ts`:** wraps an sqlite DB at
`~/.fundx/state/price_cache.sqlite` with TTL 24h on historical daily bars. The
screening service reads through this cache; on a miss it calls
`market.service.ts`, on a hit it returns the cached value. Cache invalidates
after market close.

Rate-limit protection: screening service fetches tickers in batches of 10 with a
200ms gap between batches (configurable in global config).

## Fund compatibility tagging

After a screen run, the service iterates each `fund_config.yaml` and computes
compatibility per ticker passing, based solely on `universe` membership in V1:

- If `universe` is an explicit ticker list: membership test.
- If `universe` is a named category (e.g. `sp500`, `us_equities`): map category
  → ticker set (hardcoded mapping for V1) and test membership.

Sector, market-cap, and other constraint-based matching is deferred to a later
iteration — V1 keeps tagging deterministic and auditable.

The result is written to `watchlist_fund_tags`. A ticker that passes the screen
but matches no fund still lands on the watchlist (status tracked) with zero
fund tags — surfacing via "workspace-wide opportunities" queries but not into
any fund's session.

## Execution flows

### 1. Daemon cron

In `src/services/daemon.service.ts`, register a node-cron job for
`0 22 * * 1-5` (22:00 local weekdays, post-market US). The job invokes
`screeningService.runScreen({ screen: 'momentum-12-1', universe: 'sp500' })`.
Result is logged to `daemon.log`. On failure, log and continue — no retry in V1
(next day's run will recover).

### 2. CLI

New Pastel commands under `src/commands/screen/`:

- `fundx screen run [--screen <name>] [--universe <src>]` — trigger a run
  manually. Streams progress (tickers processed, passed), prints summary table.
- `fundx screen watchlist [--fund <name>] [--status <s>] [--screen <name>] [--limit N]`
  — display current watchlist. Default: all non-rejected, non-stale. If `--fund`
  given, filter by `watchlist_fund_tags`.
- `fundx screen trajectory <ticker>` — show full score history and status
  transitions for one ticker.
- `fundx screen tag <ticker> <status> [--reason <text>]` — manual status
  override. Writes a `status_transitions` row with `reason='manual:<note>'`.

### 3. Chat / autonomous via MCP

New MCP server `src/mcp/screener.ts`. Registered in `src/agent.ts`
(`buildMcpServers`) alongside broker-local, market-data, and telegram-notify.
Tools:

| Tool | Purpose | Input | Output |
|---|---|---|---|
| `screen_run` | Trigger a run | `{ screen, universe? }` | Summary (counts, duration, top 10 by score) |
| `watchlist_query` | Query current state | `{ fund?, status?, screen?, limit? }` | Array of `{ ticker, status, current_screens, scored_at, notes }` |
| `watchlist_trajectory` | One ticker history | `{ ticker }` | `{ ticker, status, transitions[], scores[] }` |
| `watchlist_tag` | Manual override | `{ ticker, status, reason }` | Confirmation |

All tools return structured JSON validated against Zod schemas.

### 4. Session integration

Modify `src/skills.ts` — update `FUND_RULES['session-init.md']` to add a new step
after Orient:

> **Step 7 — Review watchlist.** Call the `screener.watchlist_query` tool with
> `{ fund: '<current fund name>', status: ['candidate','watching'], limit: 20 }`.
> Also call `watchlist_query` with `{ fund: '<current>', status: ['fading'] }` to
> see names that were active but cooling off. For each entry with a status
> transition since the prior session-handoff timestamp, note it in the Session
> Contract under a `Watchlist updates` heading. Candidates and fresh
> `fading → watching` transitions become inputs to the Analyze phase.

## New skill — `opportunity-screening`

Added to `BUILTIN_SKILLS` in `src/skills.ts`. Per-fund skill with standard frontmatter.

**When to use:**
- At Orient, after reading the watchlist (session-init step 7), to decide whether
  any surfaced candidate warrants further analysis this session.
- When the user asks in chat for opportunities, new ideas, or "what's
  interesting".
- When considering new positions mid-session and portfolio has open capacity.

**When NOT to use:**
- When portfolio is at its max-positions limit (per fund config).
- When current regime is clearly risk-off and the fund's objective is preservation.
- When the fund is in an active drawdown and the session's focus is damage control.

**Technique:**
- Query the watchlist filtered to the current fund; prefer `candidate` (fresh)
  and `fading → watching` (re-entrant) first, then stable `watching`.
- Inspect trajectory for top candidates (`watchlist_trajectory`) — a name with
  a clean rising score over months is stronger than one that just crossed a
  threshold today.
- Cross-reference candidates against the fund's current portfolio: do they
  introduce new sector exposure, or concentrate existing risk?
- Select 3–5 priority candidates; hand them to the existing `trade-evaluator`
  sub-agent for thesis construction.

**Output:** structured markdown block:

```
## Opportunity shortlist
For each candidate:
- Ticker, status, days since first surfaced
- Current screen scores + trajectory direction
- Why it fits this fund's objective
- Open question or risk to address in analysis
```

## New and modified files

**New:**
- `src/services/screening.service.ts`
- `src/services/watchlist.service.ts` (queries + tagging, separated from screening
  for isolation — screening writes scores, watchlist reads and transitions)
- `src/services/price-cache.service.ts`
- `src/mcp/screener.ts`
- `src/commands/screen/run.tsx`
- `src/commands/screen/watchlist.tsx`
- `src/commands/screen/trajectory.tsx`
- `src/commands/screen/tag.tsx`
- `tests/screening.test.ts`
- `tests/watchlist-transitions.test.ts`

**Modified:**
- `src/types.ts` — Zod schemas for `ScreenRun`, `Score`, `WatchlistEntry`,
  `StatusTransition`, `ScreenConfig`, MCP tool I/O.
- `src/services/market.service.ts` — `getHistoricalDaily`,
  `getSp500Constituents`.
- `src/services/daemon.service.ts` — new cron job.
- `src/paths.ts` — constants for `watchlist.sqlite`, `price_cache.sqlite`.
- `src/agent.ts` (`buildMcpServers`) — register `screener` MCP.
- `src/skills.ts` — `FUND_RULES['session-init.md']` updated with step 7; new
  entry in `BUILTIN_SKILLS` for `opportunity-screening`.
- `src/constants.ts` (if exists; create if not) — S&P 500 fallback list.
- `src/services/fund.service.ts` — on `fundx fund upgrade`, regenerate
  `session-init.md` so existing funds pick up the new step.

## Verification

**Unit tests (`tests/watchlist-transitions.test.ts`):**
Exhaustive coverage of the state-transition table using synthetic score fixtures.
Each row in the transition table gets at least one test case. Peak-window
sliding is tested with fixtures spanning > 60 days.

**Integration test (`tests/screening.test.ts`):**
Fixture file with 20 synthetic tickers × 300 days of price data. Run the screen,
assert rankings match expected top-decile, assert all state transitions fire as
expected across a simulated 90-day horizon.

**End-to-end (manual, documented in commit):**
1. `fundx screen run` — verify `~/.fundx/state/watchlist.sqlite` is created and
   populated.
2. `fundx screen watchlist` — verify tabular display.
3. `fundx screen trajectory <ticker>` — pick a passing ticker, verify full history.
4. `fundx screen run` again — verify transitions are applied (at minimum some
   `candidate → watching`).
5. Restart daemon, wait for next cron fire (or temporarily set cron to every
   minute) — verify automated run updates the db.
6. Chat test: `fundx` → "encuéntrame oportunidades para mi fondo growth" →
   verify the skill fires, MCP tool is called, response includes watchlist
   entries with trajectory.
7. Autonomous session: `fundx session run --fund <name>` → verify session
   handoff includes `Watchlist updates` section.

**Observability:**
- Every screen run logs to `daemon.log` with duration, counts, and any errors.
- `fundx logs --grep screening` surfaces screen-related entries.
- `fundx screen watchlist --status stale` catches data pipeline breakage (many
  tickers going stale signals a fetch failure).

## Rollout notes

- Existing funds created before this change must run `fundx fund upgrade --all`
  to pick up the updated `session-init.md`. This is the standard FundX upgrade
  path documented in `CLAUDE.md`.
- The screener MCP is registered globally; no per-fund opt-in in V1. A fund can
  effectively disable it by having `opportunity-screening` consistently rule
  itself out under "When NOT to use" (e.g. runway funds in risk-off).
- First run of the daemon cron will populate the watchlist from empty. Expect
  the initial run to tag ~50 S&P 500 names as `candidate`. Transitions begin on
  run #2 the next day.

## Out of scope (explicit)

- Screens beyond 12-1 momentum.
- Fundamentals-driven screens (Piotroski, Magic Formula, QMJ, dividend gates,
  balance-sheet strength).
- FRED / macro regime overlay.
- Crypto, options, REITs, insider/13F flow screens.
- Backtesting framework or empirical validation of screens.
- Visual/graphical watchlist UI (Phase 2.x if useful).
- Per-fund screening configuration (currently global; each fund filters on
  consumption, not on screen definition).
- Alert-on-transition notifications via Telegram (can be added later once we
  understand which transitions matter most in practice).
