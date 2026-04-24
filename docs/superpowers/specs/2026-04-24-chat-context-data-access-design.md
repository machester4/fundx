# Chat Context + Data Access Rule — Design Spec

**Date:** 2026-04-24
**Status:** Draft → pending user review
**Scope:** Sub-project (2) of the four-part prompt ecosystem initiative. Targets the MVP eval failures observed in the baseline established by spec (1).

## Motivation

The eval harness baseline (`reports/2026-04-24-baseline.json`, commit `cda61ec`) surfaced three MVP cases failing against main:

- `mvp-opportunity-english` — 0/3 FAIL, cause: `max_turns: 10` exceeded because the agent invokes `watchlist_query` + `screen_run` + `get_account` + `get_economic_calendar` + `get_multi_snapshots` + `get_sector_performance` plus multiple `Read`/`Glob` calls.
- `mvp-portfolio-review-spanish` — 0/3 FAIL, cause: the agent uses `Bash`, `Glob`, `Read` against `portfolio.json` instead of invoking `mcp__broker-local__get_positions`.
- `mvp-market-regime-spanish` — 1/3 FAIL, cause: inconsistent market-data tool choice; sometimes `get_multi_snapshots`, sometimes `get_quote` or `get_sector_performance`; plus `Read`/`Bash` bloat.

Additionally, the baseline revealed that `mvp-opportunity-spanish` passes 3/3 — the originally reported bug does not reproduce against a watchlist-seeded eval fund. The real signal is a systemic preference for generic tools (`Read`, `Bash`, `Glob`) over the project's MCPs (`broker-local`, `screener`, `market-data`).

Two root causes hypothesized:

1. **The `session-init.md` rule directs the agent to "read handoff + portfolio + tracker + session log"** — the agent translates "read" to `Read` calls against state files rather than reading the chat context where much of that state is already summarized.
2. **The chat context does not surface the watchlist at all** — when the user asks about opportunities, the agent has no visible cue that a screener DB with candidates exists, so it falls back to free exploration (`Glob` + `Read` around the repo).

This spec fixes both with two complementary levers.

## Non-goals for this spec

- Refactoring the `session-init.md` rule itself (belongs to sub-project (3) — prompt ecosystem audit)
- Injecting market snapshots, news, or sentiment into the chat context
- Changing how the watchlist is populated (the screener MCP already does this)
- Touching autonomous sessions or the `ask` command (sub-project (4))
- Expanding the eval harness — v1 is stable and we use it as the validation gate

## Success criteria

| Case | Baseline (pre-fix) | Target (post-fix) |
|---|---|---|
| `mvp-opportunity-spanish` | 3/3 PASS | ≥ 2/3 with **revised assertions** (`must_not_invoke: [Read, Glob, Bash]`, `max_turns: 5`) |
| `mvp-opportunity-english` | 0/3 FAIL | **flip to ≥ 2/3** with revised assertions |
| `mvp-opportunity-explicit-screener` | 2/3 PASS | hold at ≥ 2/3 (assertions unchanged) |
| `mvp-portfolio-review-spanish` | 0/3 FAIL | **flip to ≥ 2/3** with existing assertion |
| `mvp-market-regime-spanish` | 1/3 FAIL | **flip to ≥ 2/3** with existing assertion |

**Minimum acceptance:** 4 of 5 cases PASS, including the flip of `mvp-opportunity-english` (the originally motivating case).

**Full win:** 5 of 5 PASS. If `portfolio-review` or `market-regime` do not flip, sub-project (3) picks them up — this spec is not considered failed at 4/5.

## Locked architectural decisions (from brainstorming on 2026-04-24)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Cover all 3 failing MVP cases (not just the original opportunity-surfacing bug) | All 3 share root cause — generic tool preference over MCPs |
| Primary mechanism | Context injection + behavioral rule (both) | Context reduces the *temptation* to `Read`; the rule handles the remaining cases where an MCP is the right answer |
| Context data added | Watchlist top 5 + data-freshness timestamps | Minimum necessary to resolve opportunity queries; freshness gives the agent a heuristic for when to re-fetch |
| Market snapshots / news | **Not** injected in v1 | FMP rate cost; news store (zvec) is lock-contended under the daemon |
| Rule location | Single new file `data-access.md` in `FUND_RULES` | Cohesive (both directives stem from same principle); YAGNI over splitting |
| Existing rules (`session-init.md`, etc.) | **Not** modified in this spec | Belongs to sub-project (3) audit; additive new rule has lower regression risk |
| Watchlist limit in context | Top 5 by `peak_score` | Predictable token cost; agent calls MCP if it needs more |
| Opportunity cases assertions | Measure outcome (`must_not_invoke [Read/Glob/Bash]`, `max_turns: 5`), not mechanism (`must_invoke watchlist_query`) | With watchlist in context, forcing a tool call is a false constraint |
| Other cases assertions | Unchanged | Their MCP calls are still the right outcome (no context shortcut) |

## Architecture

### Changes to `src/services/chat.service.ts`

Extend `buildChatContext(fundName)` to push two new sections between the existing "Objective Progress" and "Trade Summary" blocks:

#### Section A — Watchlist top 5

```ts
// pseudo-code; full code in the plan
try {
  const db = openWatchlistDb();
  try {
    const entries = queryWatchlist(db, {
      fund: fundName,
      status: ["candidate", "watching"],
      limit: 100,
    });
    if (entries.length === 0) {
      sections.push("### Watchlist", "empty — run `screen_run` to populate", "");
    } else {
      const sorted = [...entries].sort(
        (a, b) =>
          (b.peak_score ?? 0) - (a.peak_score ?? 0) ||
          b.last_evaluated_at - a.last_evaluated_at ||
          a.ticker.localeCompare(b.ticker),
      );
      const top = sorted.slice(0, 5);
      const header = entries.length > 5
        ? `### Watchlist — top 5 of ${entries.length} (by peak_score)`
        : `### Watchlist (by peak_score)`;
      sections.push(header);
      for (const e of top) {
        const days = Math.floor((Date.now() - e.first_surfaced_at) / 86400000);
        const score = e.peak_score !== null ? e.peak_score.toFixed(2) : "—";
        sections.push(
          `  - ${e.ticker.padEnd(5)} [${e.status}]  score=${score}  ${days}d on list  [${e.current_screens.join(",")}]`,
        );
      }
      if (entries.length > 5) {
        sections.push(`  (${entries.length - 5} more candidates available via screener.watchlist_query)`);
      }
      sections.push("");
    }
  } finally {
    db.close();
  }
} catch (err) {
  sections.push("### Watchlist: unavailable", `(${(err as Error).message})`, "");
}
```

Sort order: `peak_score` desc, then `last_evaluated_at` desc, then ticker asc (for determinism).

#### Section B — Data freshness

```ts
import { stat } from "node:fs/promises";
import { fundPaths } from "../paths.js";

const freshness: string[] = [];
try {
  const port = await readPortfolio(fundName);
  freshness.push(`portfolio: updated ${relTime(port.last_updated)}`);
} catch { /* skip */ }
try {
  const tracker = await readTracker(fundName);
  freshness.push(`tracker: updated ${relTime(tracker.last_updated)}`);
} catch { /* skip */ }
// Watchlist freshness: max(last_evaluated_at) from the entries loaded in section A
// (hoist a `watchlistMostRecent` variable out of the try block, then push here)
// handoff freshness via file mtime (readSessionHandoff returns only the raw markdown)
try {
  const handoffPath = fundPaths(fundName).state.sessionHandoff;
  const st = await stat(handoffPath);
  freshness.push(`handoff: written ${relTime(st.mtimeMs)}`);
} catch { /* file missing or unreadable — skip */ }
if (freshness.length > 0) {
  sections.push("### Data freshness");
  for (const f of freshness) sections.push(`  - ${f}`);
  sections.push("");
}
```

Note: `readSessionHandoff(fundName)` returns only the raw markdown string (`string | null`), so handoff timestamp uses the file's `mtime` via `node:fs/promises.stat`. The path helper `fundPaths(fundName).state.sessionHandoff` resolves to `~/.fundx/funds/<name>/state/session-handoff.md`.

#### Helper — `relTime`

```ts
function relTime(isoOrEpoch: string | number): string {
  const ts = typeof isoOrEpoch === "string" ? new Date(isoOrEpoch).getTime() : isoOrEpoch;
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}
```

#### Invariants

- Each new section is wrapped in its own try/catch. A lock on the watchlist DB (e.g., daemon screening run) renders "### Watchlist: unavailable" and the rest of the context proceeds.
- The `handoff` branch silently omits if `readSessionHandoff` returns null — no "written undefined ago" artifacts.
- No new runtime dependencies; reuses `openWatchlistDb`, `queryWatchlist`, `readPortfolio`, `readTracker`, `readSessionHandoff` already imported or easily importable.
- Token budget: +~200-260 tokens per chat turn.

### Changes to `src/skills.ts`

Append a new `FUND_RULES` entry named `data-access.md`. Exact content:

```markdown
# Data Access & Tool Preference

Your session context already includes fund config, current portfolio, objective
tracker, recent trades, and the top watchlist candidates. Read the context
first — if the answer is visible there, respond from context.

## When the user asks about opportunities

User prompts like "¿hay oportunidades?", "qué comprar", "what's interesting",
"any new entries detected" map to the watchlist, not to free exploration.

- The `### Watchlist` section of the context is the source of truth for active
  candidates. Prefer its content for the first response.
- If the user needs more than the top 5 shown, call
  `mcp__screener__watchlist_query` filtered by this fund.
- If the user explicitly asks to run a new screen, call
  `mcp__screener__screen_run`.

Why: the watchlist is systematically updated by the screener. Inventing tickers
from memory bypasses universe, risk, and fund-tag guardrails — every claimed
"opportunity" should trace back to a watchlist row or a screen you ran this
session.

## For fund state, use MCPs instead of file reads

The fund keeps its state in `~/.fundx/funds/<name>/state/*.json` and a SQLite
watchlist DB. Do **not** `Read`, `cat`, or `Bash`-inspect these paths when you
need their contents — the MCPs expose them with fresher values and schema
validation.

| Need | Use | Not |
|------|-----|-----|
| Cash, balances, positions | `mcp__broker-local__get_account`, `get_positions` | `Read state/portfolio.json` |
| Watchlist candidates / trajectories | `mcp__screener__watchlist_query`, `watchlist_trajectory` | `Read state/watchlist.sqlite` |
| Live quotes, snapshots, sector moves | `mcp__market-data__*` | `Bash curl ...`, hardcoded prices |
| Run a screen | `mcp__screener__screen_run` / `screen_discover` | building a screen by hand |

## When Read / Bash / Glob are appropriate

- Your own analysis archives in `analysis/`
- Scripts under `scripts/`
- Source or config files outside `state/` and outside the fund dir
- The `session-handoff.md` when the context's data-freshness block suggests
  you need the narrative around the latest state

For anything under `state/` or the watchlist DB, reach for the MCP.

## Data freshness

The `### Data freshness` section tells you how stale the context is. If a value
is more than an hour old and the user is asking about *right now*, that's a
signal to call the MCP for fresh numbers.
```

**Tone calibration (per `CLAUDE.md` Prompting Conventions):**

- No `MUST` / `NEVER` / `CRITICAL` — these are preferences with reasoning, not hard safety constraints.
- Natural language, senior-colleague tone.
- Each directive pairs with a "Why" to help generalization.
- Bilingual example triggers reflect mixed ES/EN chat usage.
- ~55 lines / ~500-600 tokens of per-session overhead on top of the 10 existing rules.

### Changes to eval cases

#### `tests/eval/cases/mvp-opportunity-spanish.yaml`

```yaml
id: mvp-opportunity-spanish
description: Usuario pregunta por oportunidades nuevas en español; watchlist visible en contexto — debe responder rápido sin Read/Glob/Bash
prompt: "¿has detectado oportunidades para nuevas entradas?"
language: es
fund_state:
  base: runway-with-candidates
expect:
  must_not_invoke: [Read, Glob, Bash]
  max_turns: 5
  max_tokens_out: 3000
runs: 3
threshold: 2
```

#### `tests/eval/cases/mvp-opportunity-english.yaml`

```yaml
id: mvp-opportunity-english
description: User asks for opportunities in English; watchlist visible in context — should respond fast without Read/Glob/Bash
prompt: "Any opportunities for new entries you've detected?"
language: en
fund_state:
  base: runway-with-candidates
expect:
  must_not_invoke: [Read, Glob, Bash]
  max_turns: 5
  max_tokens_out: 3000
runs: 3
threshold: 2
```

The other 3 MVP cases remain unchanged. Their assertions are still the right target because nothing in this spec short-circuits their MCP paths:

- `mvp-opportunity-explicit-screener` requires `screen_run` explicitly.
- `mvp-portfolio-review-spanish` targets `get_positions` — the context does not recompute `market_value` on live prices, so the MCP remains the right call.
- `mvp-market-regime-spanish` targets `get_multi_snapshots` — no market snapshot in context by design.

### Testing strategy

**Unit tests** (new file `tests/chat-context.test.ts`):

- Watchlist section renders correctly for: empty watchlist, 3 entries (no "top 5 of" header), 10 entries ("top 5 of 10" header + correct sort).
- Watchlist section handles unreachable DB (renders "unavailable" with the error message).
- Data freshness includes portfolio + tracker + handoff timestamps when available; silently omits entries whose sources failed.
- `relTime` helper: <60s → "Ns ago"; minutes; hours; days.

Each test seeds a tempdir watchlist DB via `FUNDX_WATCHLIST_DB_PATH` and reuses the patterns from `tests/eval-seed.test.ts`.

**Integration validation** — the eval harness. Re-run MVP suite after each commit:

```bash
pnpm dev -- eval --filter mvp- --json reports/2026-04-24-post-fix.json
```

Compare summary and per-case pass rates against `reports/2026-04-24-baseline.json`.

### Migration for existing funds

Users with existing funds must run `fundx fund upgrade --all` once after this spec lands, so their `.claude/rules/` directories receive the new `data-access.md` file. The eval harness seeder (`ensureFundRules()` in ephemeral funds) picks it up automatically on each seed.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Agent ignores the rule and still reads files | Context injection reduces temptation; if ignored, sub-project (3) audit reinforces linguistically |
| Injecting watchlist adds latency to first chat turn | `queryWatchlist` with `limit: 100` is ~10ms on local SQLite; negligible vs. Claude render time |
| Watchlist DB locked during a daemon screening run | `try/catch` surfaces "### Watchlist: unavailable" with the error; chat degrades gracefully |
| Relaxed assertions produce false positives | `must_not_invoke [Read, Glob, Bash]` + `max_turns: 5` together rule out free exploration; a false positive requires the agent to answer correctly in 5 turns without any of those tools, which implies it did use the context |
| Rule costs extra tokens per session | ~500-600 tokens on top of the 10 existing rules; marginal |
| Watchlist context misaligns with fund universe | Existing `queryWatchlist({ fund })` already filters by the fund's universe-compatibility table (see `watchlist_fund_tags`); for funds without explicit tags the filter is loose — acceptable given the MCP is still one call away |

## Token and cost impact

| | Baseline | Post-fix estimated |
|---|---|---|
| Per-turn context (input) | ~4500 tokens | ~4750 tokens (+watchlist +freshness) |
| Per-turn response (output, opportunity cases) | ~1500 tokens | ~1000 tokens (more direct, less "let me check multiple sources") |
| MVP suite total cost | $3.29 | Estimated similar or slightly lower |
| MVP suite wall clock | 394s | Estimated lower (fewer turns in the 3 flipped cases) |

Net direction: neutral to favorable. The fix should not increase eval costs meaningfully.

## Out-of-scope reminder

This spec does **not**:

- Refactor `session-init.md`, `analysis-standards.md`, or any of the existing 10 `FUND_RULES`
- Inject market snapshots or news into the chat context
- Change the eval harness internals (`src/services/eval/*` stays as-is)
- Touch autonomous sessions, the `ask` command, or workspace chat
- Modify the `opportunity-screening` skill (it complements, not conflicts with, the new rule)
- Add new MCP tools or new watchlist screens

When the success criteria are met (4 of 5 MVP cases PASS including `mvp-opportunity-english`), this spec is done. Sub-project (3) — prompt ecosystem audit — picks up anything that remains.
