# Chat Context + Data Access Rule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip 2-3 MVP eval failures by exposing the watchlist top-5 and data-freshness timestamps inside `buildChatContext` and adding a new `data-access.md` FUND_RULE that tells the agent to prefer project MCPs over `Read`/`Bash`/`Glob` for fund state.

**Architecture:** Two complementary levers. (1) Context injection: expand `buildChatContext` in `src/services/chat.service.ts` with two new sections (watchlist top-5, data freshness) and a `relTime` helper. (2) Behavioral rule: append a new `data-access.md` entry to `FUND_RULES` in `src/skills.ts`. Two opportunity eval cases have their assertions reshaped to measure outcome (no generic tools, ≤5 turns) instead of mechanism (`must_invoke watchlist_query`) now that the watchlist is visible in context.

**Tech Stack:** TypeScript ESM, Vitest, `better-sqlite3` (for the watchlist DB), existing eval harness (`fundx eval`). No new runtime dependencies.

**Prior context:**
- Design spec: `docs/superpowers/specs/2026-04-24-chat-context-data-access-design.md` (commit `92bd719`)
- Baseline from sub-project (1): `reports/2026-04-24-baseline.json` (commit `cda61ec`) — current MVP pass rates: `opportunity-spanish` 3/3, `opportunity-english` 0/3, `opportunity-explicit-screener` 2/3, `portfolio-review-spanish` 0/3, `market-regime-spanish` 1/3
- Existing modules reused: `openWatchlistDb` + `queryWatchlist` (`src/services/watchlist.service.ts`); `readPortfolio`, `readTracker`, `readSessionHandoff` (`src/state.ts`); `fundPaths` (`src/paths.ts`); `seedEvalFund` (`src/services/eval/seed.ts`) for integration-style tests; 10 existing `FUND_RULES` in `src/skills.ts`
- Working directory: `/Users/michael/Proyectos/fundx`. Branch: `main` (user has standing consent for this sub-project).

---

## File Structure

**New files:**

| Path | Responsibility |
|---|---|
| `tests/chat-context.test.ts` | Integration tests for the new `buildChatContext` sections — seeds ephemeral funds via `seedEvalFund`, calls `buildChatContext`, asserts on returned string |
| `reports/2026-04-24-post-fix.json` | Post-fix baseline committed by Task 4 |

**Modified files:**

| Path | Change |
|---|---|
| `src/services/chat.service.ts` | Add `relTime` helper + watchlist section + data-freshness section to `buildChatContext`. New imports: `stat` from `node:fs/promises`, `openWatchlistDb`/`queryWatchlist` from `./watchlist.service.js`, `fundPaths` from `../paths.js` |
| `src/skills.ts` | Append 11th entry to `FUND_RULES` array: `{ fileName: "data-access.md", content: ... }` |
| `tests/eval/cases/mvp-opportunity-spanish.yaml` | Replace `must_invoke: [mcp__screener__watchlist_query]` with `must_not_invoke: [Read, Glob, Bash]` + `max_turns: 5` + `max_tokens_out: 3000`; update description |
| `tests/eval/cases/mvp-opportunity-english.yaml` | Same reshape |

**Unchanged (explicit):**
- Other 3 MVP case YAMLs: `mvp-opportunity-explicit-screener.yaml`, `mvp-portfolio-review-spanish.yaml`, `mvp-market-regime-spanish.yaml`. Their assertions are already the right target — the new rule should push the agent toward the MCPs they expect.
- 13 backlog case YAMLs.
- Existing 10 `FUND_RULES` — no edits. Touching `session-init.md` is sub-project (3).
- `BUILTIN_SKILLS` — no edits. The `opportunity-screening` skill remains complementary.
- Eval harness internals (`src/services/eval/*`).

**Task dependency graph:**

```
Task 1: Extend buildChatContext    [foundation]
Task 2: Add data-access.md rule    [foundation; independent of Task 1]
Task 3: Reshape 2 opportunity YAMLs [foundation; independent]
Task 4: Smoke test post-fix         [needs 1 + 2 + 3]
Task 5: Final verification + docs   [needs 4]
```

Tasks 1, 2, 3 could run in parallel. Task 4 is the moment-of-truth validation.

---

## Task 1: Extend `buildChatContext` with watchlist + data-freshness sections + `relTime` helper

**Why:** The agent has no visible hint that a watchlist exists today. Inject top-5 candidates so the `Opportunity` flow can resolve from context. Add data-freshness timestamps so the agent has a heuristic for when to re-fetch. Both require one small pure helper (`relTime`).

**Files:**
- Create: `tests/chat-context.test.ts`
- Modify: `src/services/chat.service.ts`

- [ ] **Step 1.1: Write failing tests for `relTime` helper and the two new context sections**

Create `tests/chat-context.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { buildChatContext } from "../src/services/chat.service.js";
import { seedEvalFund, type SeedEvalFundHandle } from "../src/services/eval/seed.js";

// ── relTime helper (exported from chat.service.ts) ─────────────────
import { relTime } from "../src/services/chat.service.js";

describe("relTime", () => {
  it("formats seconds for deltas under a minute", () => {
    const ts = Date.now() - 5000;
    expect(relTime(ts)).toMatch(/^[0-9]+s ago$/);
  });

  it("formats minutes between 1 minute and 1 hour", () => {
    const ts = Date.now() - 10 * 60 * 1000;
    expect(relTime(ts)).toBe("10m ago");
  });

  it("formats hours between 1 hour and 1 day", () => {
    const ts = Date.now() - 5 * 3600 * 1000;
    expect(relTime(ts)).toBe("5h ago");
  });

  it("formats days for deltas of 1+ days", () => {
    const ts = Date.now() - 3 * 86400 * 1000;
    expect(relTime(ts)).toBe("3d ago");
  });

  it("accepts ISO string and epoch number", () => {
    const epoch = Date.now() - 2 * 3600 * 1000;
    const iso = new Date(epoch).toISOString();
    expect(relTime(iso)).toBe(relTime(epoch));
  });

  it("clamps negative deltas to 0s ago", () => {
    const future = Date.now() + 60_000;
    expect(relTime(future)).toBe("0s ago");
  });
});

// ── buildChatContext new sections ──────────────────────────────────
describe("buildChatContext — watchlist section", () => {
  let handle: SeedEvalFundHandle | null = null;
  afterEach(async () => {
    if (handle) { await handle.cleanup(); handle = null; }
  });

  it('renders "empty — run screen_run to populate" when watchlist has no entries', async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [],
    });
    const ctx = await buildChatContext(handle.fundName);
    expect(ctx).toContain("### Watchlist");
    expect(ctx).toMatch(/empty — run `screen_run` to populate/);
  });

  it('renders 3 entries without "top 5 of N" header when watchlist has ≤5', async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [
        { ticker: "NVDA", status: "candidate", peak_score: 0.9, screens: ["momentum-12-1"], first_surfaced_days_ago: 7 },
        { ticker: "AMD",  status: "watching",  peak_score: 0.7, screens: ["momentum-12-1"], first_surfaced_days_ago: 3 },
        { ticker: "AVGO", status: "candidate", peak_score: 0.6, screens: ["momentum-12-1"], first_surfaced_days_ago: 2 },
      ],
    });
    const ctx = await buildChatContext(handle.fundName);
    expect(ctx).toContain("### Watchlist (by peak_score)");
    expect(ctx).not.toContain("top 5 of");
    expect(ctx).toContain("NVDA");
    expect(ctx).toContain("[candidate]");
    expect(ctx).toContain("score=0.90");
    // sort by peak_score desc: NVDA first, then AMD, then AVGO
    const nvdaIdx = ctx.indexOf("NVDA");
    const amdIdx = ctx.indexOf("AMD");
    const avgoIdx = ctx.indexOf("AVGO");
    expect(nvdaIdx).toBeLessThan(amdIdx);
    expect(amdIdx).toBeLessThan(avgoIdx);
  });

  it('renders "top 5 of N" header when watchlist has >5 entries, plus hint line', async () => {
    const watchlist = Array.from({ length: 8 }, (_, i) => ({
      ticker: `T${i.toString().padStart(2, "0")}`,
      status: "candidate" as const,
      peak_score: 0.9 - i * 0.05,
      screens: ["momentum-12-1"],
      first_surfaced_days_ago: i + 1,
    }));
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist,
    });
    const ctx = await buildChatContext(handle.fundName);
    expect(ctx).toContain("### Watchlist — top 5 of 8 (by peak_score)");
    expect(ctx).toContain("(3 more candidates available via screener.watchlist_query)");
    // First ticker T00 should appear, last ticker T07 should NOT appear in top 5
    expect(ctx).toContain("T00");
    expect(ctx).not.toContain("T07");
  });
});

describe("buildChatContext — data freshness section", () => {
  let handle: SeedEvalFundHandle | null = null;
  afterEach(async () => {
    if (handle) { await handle.cleanup(); handle = null; }
  });

  it("includes portfolio and tracker timestamps with relTime formatting", async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [],
    });
    const ctx = await buildChatContext(handle.fundName);
    expect(ctx).toContain("### Data freshness");
    expect(ctx).toMatch(/portfolio: updated \d+[smhd] ago/);
    expect(ctx).toMatch(/tracker: updated \d+[smhd] ago/);
  });

  it("includes watchlist freshness when the watchlist has entries", async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [
        { ticker: "NVDA", status: "candidate", peak_score: 0.9, screens: ["momentum-12-1"], first_surfaced_days_ago: 7 },
      ],
    });
    const ctx = await buildChatContext(handle.fundName);
    expect(ctx).toMatch(/watchlist: evaluated \d+[smhd] ago/);
  });

  it("omits freshness lines whose underlying files are missing", async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [],
    });
    // handoff file does NOT exist by default after seeding — freshness section
    // should not mention it (no "undefined ago")
    const ctx = await buildChatContext(handle.fundName);
    expect(ctx).not.toMatch(/handoff: written undefined/);
    expect(ctx).not.toMatch(/handoff: written NaN/);
  });
});
```

- [ ] **Step 1.2: Run the tests — expect FAIL**

```bash
pnpm vitest run tests/chat-context.test.ts
```

Expected: the `relTime` import fails (not exported yet), and the context tests fail because the new sections don't exist.

- [ ] **Step 1.3: Add imports + `relTime` helper + exports to `src/services/chat.service.ts`**

Near the top of `src/services/chat.service.ts`, alongside the existing imports, ensure these are imported. If any already exist, leave as-is:

```ts
import { stat } from "node:fs/promises";
import { openWatchlistDb, queryWatchlist } from "./watchlist.service.js";
import { fundPaths } from "../paths.js";
```

Add the `relTime` helper as a new exported function. Place it near the other module-level helpers (near the top of the file, after imports):

```ts
/** Format a timestamp as a relative "N<unit> ago" string.
 *
 * Accepts either ISO string or epoch milliseconds. Clamps future timestamps
 * to "0s ago" so clock skew does not produce negative deltas.
 */
export function relTime(isoOrEpoch: string | number): string {
  const ts = typeof isoOrEpoch === "string" ? new Date(isoOrEpoch).getTime() : isoOrEpoch;
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}
```

- [ ] **Step 1.4: Run only the `relTime` tests — expect PASS**

```bash
pnpm vitest run tests/chat-context.test.ts -t relTime
```

Expected: all 6 `relTime` tests PASS.

- [ ] **Step 1.5: Extend `buildChatContext` with the Watchlist section**

Locate `buildChatContext(fundName: string | null)` in `src/services/chat.service.ts` (currently around line 286–360). Find the block that renders `### Objective Progress` and closes with `sections.push("");`. Immediately after that block, insert the watchlist block. Also declare `let watchlistMostRecent: number | null = null;` in an enclosing scope so the freshness block (Step 1.6) can read it.

```ts
// after the existing Objective Progress block...

let watchlistMostRecent: number | null = null;
try {
  const db = openWatchlistDb();
  try {
    const entries = queryWatchlist(db, {
      fund: fundName,
      status: ["candidate", "watching"],
      limit: 100,
    });

    if (entries.length === 0) {
      sections.push("### Watchlist");
      sections.push("empty — run `screen_run` to populate");
      sections.push("");
    } else {
      const sorted = [...entries].sort((a, b) => {
        const scoreDiff = (b.peak_score ?? 0) - (a.peak_score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        const timeDiff = b.last_evaluated_at - a.last_evaluated_at;
        if (timeDiff !== 0) return timeDiff;
        return a.ticker.localeCompare(b.ticker);
      });
      const top = sorted.slice(0, 5);
      watchlistMostRecent = Math.max(...entries.map((e) => e.last_evaluated_at));

      const header = entries.length > 5
        ? `### Watchlist — top 5 of ${entries.length} (by peak_score)`
        : `### Watchlist (by peak_score)`;
      sections.push(header);
      for (const e of top) {
        const days = Math.floor((Date.now() - e.first_surfaced_at) / 86400000);
        const score = e.peak_score !== null ? e.peak_score.toFixed(2) : "—";
        const screens = e.current_screens.join(",");
        sections.push(
          `  - ${e.ticker.padEnd(5)} [${e.status}]  score=${score}  ${days}d on list  [${screens}]`,
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
  sections.push("### Watchlist: unavailable");
  sections.push(`(${(err as Error).message})`);
  sections.push("");
}
```

- [ ] **Step 1.6: Extend `buildChatContext` with the Data freshness section**

Immediately after the Watchlist block, insert the freshness block. This block reuses `watchlistMostRecent` declared in Step 1.5.

```ts
const freshness: string[] = [];
try {
  const port = await readPortfolio(fundName);
  freshness.push(`portfolio: updated ${relTime(port.last_updated)}`);
} catch { /* skip */ }
try {
  const tracker = await readTracker(fundName);
  freshness.push(`tracker: updated ${relTime(tracker.last_updated)}`);
} catch { /* skip */ }
if (watchlistMostRecent !== null) {
  freshness.push(`watchlist: evaluated ${relTime(watchlistMostRecent)}`);
}
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

- [ ] **Step 1.7: Run the full `chat-context.test.ts` suite — expect PASS**

```bash
pnpm vitest run tests/chat-context.test.ts
```

Expected: all 10 tests PASS (6 `relTime` + 3 watchlist + 3 freshness = 12; some tests internally assert multiple facts).

- [ ] **Step 1.8: Run the full test suite to check no regressions**

```bash
pnpm test
```

Expected: 655+ tests pass (previous 643 + ~12 new). No pre-existing test fails.

- [ ] **Step 1.9: Typecheck and build**

```bash
pnpm typecheck
pnpm build
```

Expected: both clean.

- [ ] **Step 1.10: Commit**

```bash
git add src/services/chat.service.ts tests/chat-context.test.ts
git -c commit.gpgsign=false commit -m "feat(chat-context): watchlist top-5 + data freshness + relTime helper"
```

---

## Task 2: Add `data-access.md` to `FUND_RULES`

**Why:** The rule tells the agent to prefer project MCPs over `Read`/`Bash`/`Glob` for fund state, and to look at the context's watchlist section before guessing at tickers. Complements the context injection from Task 1.

**Files:**
- Modify: `src/skills.ts`
- Modify: `tests/skills.test.ts` (extend existing suite if it already exists; otherwise create minimal assertions inline in this task)

- [ ] **Step 2.1: Verify the existing `skills.test.ts` structure**

```bash
ls tests/skills.test.ts && head -30 tests/skills.test.ts
```

If the file exists, note the assertion style. If it does not exist, the test is added to `tests/rules-shape.test.ts` as a small new file (Step 2.2 variant).

- [ ] **Step 2.2: Write the failing test**

Append to `tests/skills.test.ts` (or create `tests/rules-shape.test.ts` with the same content if the first file does not exist):

```ts
import { describe, it, expect } from "vitest";
// Import the unexported FUND_RULES via a test helper — add `export` in Step 2.3
// if not already exported; otherwise import the helper that writes rule files.
import { FUND_RULES } from "../src/skills.js";

describe("FUND_RULES includes data-access.md", () => {
  it("has a data-access.md entry", () => {
    const entry = FUND_RULES.find((r) => r.fileName === "data-access.md");
    expect(entry).toBeDefined();
    expect(entry!.content).toContain("# Data Access & Tool Preference");
  });

  it("data-access.md mentions the three project MCPs", () => {
    const entry = FUND_RULES.find((r) => r.fileName === "data-access.md")!;
    expect(entry.content).toContain("mcp__broker-local__");
    expect(entry.content).toContain("mcp__screener__");
    expect(entry.content).toContain("mcp__market-data__");
  });

  it("data-access.md explicitly discourages Read/Bash/Glob on state paths", () => {
    const entry = FUND_RULES.find((r) => r.fileName === "data-access.md")!;
    expect(entry.content).toMatch(/Read/);
    expect(entry.content).toMatch(/Bash/);
    expect(entry.content).toMatch(/state\//);
  });

  it("data-access.md includes bilingual opportunity triggers", () => {
    const entry = FUND_RULES.find((r) => r.fileName === "data-access.md")!;
    expect(entry.content).toMatch(/oportunidades/i);
    expect(entry.content).toMatch(/what's interesting|what is interesting|opportunities/i);
  });
});
```

- [ ] **Step 2.3: Run the test — expect FAIL**

```bash
pnpm vitest run tests/skills.test.ts
```

Expected: FAIL — either `FUND_RULES` is not exported, or the `data-access.md` entry does not exist yet.

If the test fails because `FUND_RULES` is not exported, open `src/skills.ts` and change the declaration from `const FUND_RULES = [...]` to `export const FUND_RULES = [...]`. This is a minimal change: the array already contains the 10 existing rules with the exact same shape, and nothing else in the codebase treats `FUND_RULES` as internal (verify with `grep -rn "FUND_RULES" src/ tests/`).

- [ ] **Step 2.4: Append the `data-access.md` entry to `FUND_RULES` in `src/skills.ts`**

Locate the `FUND_RULES` array (starts around line 1004). Append the new entry as the **last** element before the closing `]`:

```ts
  {
    fileName: "data-access.md",
    content: `# Data Access & Tool Preference

Your session context already includes fund config, current portfolio, objective
tracker, recent trades, and the top watchlist candidates. Read the context
first — if the answer is visible there, respond from context.

## When the user asks about opportunities

User prompts like "¿hay oportunidades?", "qué comprar", "what's interesting",
"any new entries detected" map to the watchlist, not to free exploration.

- The \`### Watchlist\` section of the context is the source of truth for active
  candidates. Prefer its content for the first response.
- If the user needs more than the top 5 shown, call
  \`mcp__screener__watchlist_query\` filtered by this fund.
- If the user explicitly asks to run a new screen, call
  \`mcp__screener__screen_run\`.

Why: the watchlist is systematically updated by the screener. Inventing tickers
from memory bypasses universe, risk, and fund-tag guardrails — every claimed
"opportunity" should trace back to a watchlist row or a screen you ran this
session.

## For fund state, use MCPs instead of file reads

The fund keeps its state in \`~/.fundx/funds/<name>/state/*.json\` and a SQLite
watchlist DB. Do **not** \`Read\`, \`cat\`, or \`Bash\`-inspect these paths when you
need their contents — the MCPs expose them with fresher values and schema
validation.

| Need | Use | Not |
|------|-----|-----|
| Cash, balances, positions | \`mcp__broker-local__get_account\`, \`get_positions\` | \`Read state/portfolio.json\` |
| Watchlist candidates / trajectories | \`mcp__screener__watchlist_query\`, \`watchlist_trajectory\` | \`Read state/watchlist.sqlite\` |
| Live quotes, snapshots, sector moves | \`mcp__market-data__*\` | \`Bash curl ...\`, hardcoded prices |
| Run a screen | \`mcp__screener__screen_run\` / \`screen_discover\` | building a screen by hand |

## When Read / Bash / Glob are appropriate

- Your own analysis archives in \`analysis/\`
- Scripts under \`scripts/\`
- Source or config files outside \`state/\` and outside the fund dir
- The \`session-handoff.md\` when the context's data-freshness block suggests
  you need the narrative around the latest state

For anything under \`state/\` or the watchlist DB, reach for the MCP.

## Data freshness

The \`### Data freshness\` section tells you how stale the context is. If a value
is more than an hour old and the user is asking about *right now*, that's a
signal to call the MCP for fresh numbers.
`,
  },
```

Be careful with the backtick escapes (`` \` ``) — they are needed because the template literal itself uses backticks. The Markdown content uses literal backticks for inline code.

- [ ] **Step 2.5: Run the test — expect PASS**

```bash
pnpm vitest run tests/skills.test.ts
```

Expected: the 4 new tests PASS. Existing tests in this file (if any) still pass.

- [ ] **Step 2.6: Run the full test suite**

```bash
pnpm test
```

Expected: no regressions.

- [ ] **Step 2.7: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 2.8: Commit**

```bash
git add src/skills.ts tests/skills.test.ts
git -c commit.gpgsign=false commit -m "feat(skills): data-access.md rule — prefer MCPs over generic tools"
```

---

## Task 3: Reshape the 2 opportunity eval case YAMLs

**Why:** With the watchlist visible in the chat context, forcing `must_invoke: [mcp__screener__watchlist_query]` becomes a false constraint. The new assertions measure outcome (`must_not_invoke [Read, Glob, Bash]` + `max_turns: 5`) which encodes "the agent did not go to free exploration".

**Files:**
- Modify: `tests/eval/cases/mvp-opportunity-spanish.yaml`
- Modify: `tests/eval/cases/mvp-opportunity-english.yaml`

- [ ] **Step 3.1: Replace `tests/eval/cases/mvp-opportunity-spanish.yaml` with the reshaped version**

Overwrite the entire file with:

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

- [ ] **Step 3.2: Replace `tests/eval/cases/mvp-opportunity-english.yaml` with the reshaped version**

Overwrite the entire file with:

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

- [ ] **Step 3.3: Verify the YAMLs still load cleanly**

```bash
pnpm build
node --input-type=module -e "import('./dist/services/eval/index.js').then(async ({ loadEvalCases }) => { const c = await loadEvalCases({ casesDir: 'tests/eval/cases', fixturesDir: 'tests/eval/fixtures' }); console.log('Loaded', c.length, 'cases'); const ops = c.filter(x => x.id.startsWith('mvp-opportunity-')); for (const o of ops) console.log(o.id, '- must_not_invoke:', o.expect.must_not_invoke, 'max_turns:', o.expect.max_turns); });"
```

Expected output:
```
Loaded 18 cases
mvp-opportunity-english - must_not_invoke: [ 'Read', 'Glob', 'Bash' ] max_turns: 5
mvp-opportunity-explicit-screener - must_not_invoke: undefined max_turns: 10
mvp-opportunity-spanish - must_not_invoke: [ 'Read', 'Glob', 'Bash' ] max_turns: 5
```

The explicit-screener case keeps its original shape; only the two target cases were reshaped.

- [ ] **Step 3.4: Commit**

```bash
git add tests/eval/cases/mvp-opportunity-spanish.yaml tests/eval/cases/mvp-opportunity-english.yaml
git -c commit.gpgsign=false commit -m "test(eval): reshape opportunity cases to measure outcome not mechanism"
```

---

## Task 4: Local smoke test — validate success criteria

**Why:** This is the moment of truth. With Tasks 1–3 merged, the agent should now (a) see the watchlist in context, (b) hear the rule telling it to use MCPs, and (c) be measured against the reshaped assertions. Expected outcome: at least `mvp-opportunity-english` flips from FAIL 0/3 to PASS ≥2/3, and `mvp-opportunity-spanish` stays PASS ≥2/3 under the new assertions.

**Prerequisites:** Either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` exported. The existing session uses `CLAUDE_CODE_OAUTH_TOKEN`.

**Files:**
- Create: `reports/2026-04-24-post-fix.json` (committed by Step 4.5)

- [ ] **Step 4.1: Build, confirm auth token present, confirm no leftover eval funds**

```bash
pnpm build
echo "auth token: ${CLAUDE_CODE_OAUTH_TOKEN:+set}${ANTHROPIC_API_KEY:+set}"
ls ~/.fundx/funds/ | grep -E "^fundx-eval-" || echo "clean"
```

Expected: `auth token: set` and `clean`. If leftover eval funds exist, remove them: `for d in ~/.fundx/funds/fundx-eval-*; do rm -rf "$d"; done`.

- [ ] **Step 4.2: Smoke-run the single most diagnostic case (`mvp-opportunity-english`) with K=1 for speed**

```bash
pnpm dev -- eval --case mvp-opportunity-english --runs 1 --json /tmp/eval-post-fix-single.json
jq '.cases[0] | {id, passed, tool_history: [.runs[0].tool_history[].name]}' /tmp/eval-post-fix-single.json
```

Expected: the case passed or failed with the new assertion shape (`must_not_invoke [Read, Glob, Bash]`, `max_turns: 5`). If the agent no longer invokes `Read`/`Glob`/`Bash`, this is a good smoke signal.

Interpret the output:
- If `passed: true` and `tool_history` contains no `Read`/`Glob`/`Bash`: fix is working. Proceed.
- If `passed: false` and `tool_history` contains `Read`: rule was not loaded (see Step 4.3 note). Check `~/.fundx/funds/fundx-eval-*/.claude/rules/data-access.md` on the NEXT run — the seeder re-reads `FUND_RULES` each time; a missing file means `ensureFundRules()` did not pick up the new entry. Investigate `src/services/eval/seed.ts` and the `FUND_RULES` shape match.
- If `passed: false` and `tool_history` lacks `Read`/`Glob`/`Bash` but `max_turns` was exceeded: the new assertion still fires; the agent is simply taking too many turns for another reason (unrelated to our fix). Still proceed — the 3-run suite gives a more stable picture.

- [ ] **Step 4.3: Verify the eval seeder picked up the new rule**

```bash
ls ~/.fundx/funds/fundx-eval-*/.claude/rules/ 2>/dev/null | head -5 || echo "no leftover funds (expected after cleanup)"
```

This lists the rules directory of any leftover eval fund — should include `data-access.md`. If cleanup already ran, this may be empty. Alternative: run a case with `--runs 1 --bail`, inspect the fund dir during the run (use `TaskOutput` if needed), then let cleanup complete.

A cleaner verification: grep the built artifact to confirm the rule content is embedded:

```bash
grep -c "Data Access & Tool Preference" dist/index.js
```

Expected: a positive integer (the rule content appears in the bundled output).

- [ ] **Step 4.4: Run the full MVP suite with K=3**

```bash
pnpm dev -- eval --filter mvp- --json reports/2026-04-24-post-fix.json
```

Expected wall clock: 3–7 minutes. Expected cost: $2–4.

Inspect:

```bash
jq '.summary' reports/2026-04-24-post-fix.json
jq '.cases[] | {id, passed, passing_runs, total_runs}' reports/2026-04-24-post-fix.json
jq '.total_cost_usd, .total_duration_ms' reports/2026-04-24-post-fix.json
```

Compare against the baseline (`reports/2026-04-24-baseline.json`):

```bash
echo "Pre-fix:"
jq '.cases[] | {id, passing_runs}' reports/2026-04-24-baseline.json
echo "Post-fix:"
jq '.cases[] | {id, passing_runs}' reports/2026-04-24-post-fix.json
```

- [ ] **Step 4.5: Verify success criteria**

From the spec, the acceptance bar is: **at least 4 of 5 MVP cases PASS, including the flip of `mvp-opportunity-english`**. Full win is 5/5.

Check each case using the JSON:

- `mvp-opportunity-spanish`: was 3/3 PASS → must be ≥ 2/3 with new assertions
- `mvp-opportunity-english`: was 0/3 FAIL → **must flip to ≥ 2/3**
- `mvp-opportunity-explicit-screener`: was 2/3 PASS → must stay ≥ 2/3
- `mvp-portfolio-review-spanish`: was 0/3 FAIL → target ≥ 2/3 (not strictly required)
- `mvp-market-regime-spanish`: was 1/3 FAIL → target ≥ 2/3 (not strictly required)

If `opportunity-english` does NOT flip: this is a BLOCKER. The fix failed its core purpose. Inspect the tool history of each failing run in the JSON. Common causes to investigate, with bite-sized fixes for each:

1. **Rule not being loaded by the seeder.** Confirm `~/.fundx/funds/fundx-eval-<id>/.claude/rules/data-access.md` exists during a run (mid-run inspection; use `--bail` and a short timeout). If missing, the fix is in `ensureFundRules()` — it should already handle the new entry, so the likely cause is that the `dist/` build is stale; re-run `pnpm build` and retry.

2. **Rule loaded but the agent still goes to `Read`.** Indicates Claude 4.6 is discounting the rule's directive. Fix options: (a) add a short line to the rule's top reinforcing "the context below contains the data you need"; (b) surface the rule in the `systemPrompt` preamble of `runChatTurn`. Option (a) is lighter; try it first as a follow-up commit.

3. **Context injection is firing but the agent does not recognize the watchlist section.** Inspect a raw transcript — if the agent's reasoning says "I should check the watchlist" and then calls `Read` instead of reading the context, the context format may need an explicit hint: change `### Watchlist (by peak_score)` to `### Watchlist (by peak_score) — use this data to answer opportunity questions`.

Any of these follow-up fixes is a new commit on top; the plan does not block Task 5 on achieving 5/5 unless `opportunity-english` fails to flip.

- [ ] **Step 4.6: Commit the post-fix baseline**

Record the observed outcomes in a commit message using a heredoc. Fill in the placeholders from the JSON before committing.

```bash
git add reports/2026-04-24-post-fix.json
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
test(eval): post-fix MVP run — validates sub-project (2)

Pre-fix  → Post-fix  per case (pass rate out of 3):
- mvp-opportunity-spanish:          3/3 → <X>/3 (new assertions)
- mvp-opportunity-english:          0/3 → <X>/3 (new assertions)
- mvp-opportunity-explicit-screener: 2/3 → <X>/3
- mvp-portfolio-review-spanish:     0/3 → <X>/3
- mvp-market-regime-spanish:        1/3 → <X>/3

Full MVP suite: $<cost> / <wall_clock>s
Baseline (pre-fix): reports/2026-04-24-baseline.json
EOF
)"
```

- [ ] **Step 4.7: Cleanup leftover eval funds**

```bash
ls ~/.fundx/funds/ | grep -E "^fundx-eval-" && for d in ~/.fundx/funds/fundx-eval-*; do rm -rf "$d"; done || echo "clean"
```

---

## Task 5: Final verification + user migration note

**Why:** Close the spec with (a) confirmation the full test suite is green, (b) a short CLAUDE.md note telling users of existing funds to run `fundx fund upgrade --all` once so their `.claude/rules/` dirs receive the new `data-access.md` file.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 5.1: Add migration note to `CLAUDE.md`**

Open `CLAUDE.md`. Find the "Prompt eval harness" subsection added by sub-project (1) (inside "Testing Conventions"). Immediately after that subsection, append a new subsection:

```markdown
### Migration when FUND_RULES change

When a new entry is added to `FUND_RULES` in `src/skills.ts` (or an existing
one is modified), existing funds on disk do not receive the change until you
run:

```bash
fundx fund upgrade --all
```

This re-renders each fund's `.claude/rules/` directory from the current
`FUND_RULES` source. New ephemeral eval funds seeded via `fundx eval` pick up
the change automatically on the next run.
```

- [ ] **Step 5.2: Verify the tree is clean and everything passes**

```bash
git status
pnpm test
pnpm typecheck
pnpm build
```

Expected: no unstaged changes other than the CLAUDE.md one, all tests pass, typecheck and build clean.

- [ ] **Step 5.3: Final commit**

```bash
git add CLAUDE.md
git -c commit.gpgsign=false commit -m "docs: migration note — run fundx fund upgrade --all after FUND_RULES changes"
```

- [ ] **Step 5.4: Summary check**

Verify the log shows the expected commits (5 new commits on top of `92bd719`):

```bash
git log --oneline 92bd719..HEAD
```

Expected:
```
<sha5> docs: migration note — run fundx fund upgrade --all after FUND_RULES changes
<sha4> test(eval): post-fix MVP run — validates sub-project (2)
<sha3> test(eval): reshape opportunity cases to measure outcome not mechanism
<sha2> feat(skills): data-access.md rule — prefer MCPs over generic tools
<sha1> feat(chat-context): watchlist top-5 + data freshness + relTime helper
```

---

## Self-review log (fill in during execution)

- [ ] No deviations
- [ ] Deviations (list below)

_(empty — fill in as the plan executes)_

---

**End of plan.** When this plan completes, sub-project (3) — prompt ecosystem audit — has a clean environment to work against: the MVP eval runs green (or ≥4/5) as a non-regression gate.
