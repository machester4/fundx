# Phase 2 Screening System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a workspace-wide watchlist backed by a single screen (12-1 momentum) running end-to-end: daemon cron, CLI, chat MCP, and autonomous-session integration.

**Architecture:** Pure-service core (`screening.service.ts` + `watchlist.service.ts`) writes/reads `~/.fundx/state/watchlist.sqlite`. Three callers (daemon cron, screener MCP server, Pastel CLI commands) invoke the service. A new per-fund skill (`opportunity-screening`) and an updated `session-init` rule wire the watchlist into autonomous sessions.

**Tech Stack:** TypeScript (strict) · Node 20+ · better-sqlite3 · Zod · node-cron · MCP SDK (stdio) · Pastel/Ink · Vitest · FMP `/historical-price-full` + `/sp500_constituent`.

**Reference spec:** `docs/superpowers/specs/2026-04-13-phase2-screening-system-design.md`
**Reference research:** `research/screening-strategies.md` §3 (momentum).

**Spec divergence (noted during exploration):** FundX's `fund_config.yaml` `universe` field is a discriminated union (`etf` | `sector` | `strategy` | `protocol`), not a flat ticker list. V1 fund-compatibility tagging therefore only matches when the fund universe contains a `type: etf` entry with concrete tickers. Funds declared by `sector`/`strategy`/`protocol` receive no V1 tags; their users can manually tag via `fundx screen tag`. This is acceptable for V1 and documented in the skill and CLI help.

**Implementation note:** `better-sqlite3` offers a multi-statement DDL method for schema setup. In this plan we split the DDL into an array of single statements and iterate `db.prepare(stmt).run()` — functionally equivalent, tidy, and explicit. Either style is acceptable to the reviewer.

---

## File inventory

**Create:**
- `src/services/price-cache.service.ts`
- `src/services/screening.service.ts`
- `src/services/watchlist.service.ts`
- `src/mcp/screener.ts`
- `src/commands/screen/run.tsx`
- `src/commands/screen/watchlist.tsx`
- `src/commands/screen/trajectory.tsx`
- `src/commands/screen/tag.tsx`
- `src/constants/sp500.ts` (hardcoded fallback list)
- `tests/price-cache.test.ts`
- `tests/watchlist-transitions.test.ts`
- `tests/screening.test.ts`
- `tests/screener-mcp.test.ts`

**Modify:**
- `src/types.ts` — add new schemas
- `src/paths.ts` — new workspace-level path constants + MCP_SERVERS entry
- `src/services/market.service.ts` — `getHistoricalDaily`, `getSp500Constituents`
- `src/services/fund.service.ts` — `loadAllFundConfigs` helper
- `src/services/daemon.service.ts` — new cron job
- `src/agent.ts` — register `screener` MCP in `buildMcpServers`
- `src/skills.ts` — add `opportunity-screening` to `BUILTIN_SKILLS`; update `session-init.md` in `FUND_RULES` with step 7

---

## Task 1 — Zod schemas and path constants

**Files:**
- Modify: `src/types.ts` (append new schemas at end)
- Modify: `src/paths.ts` (add workspace-level paths)

- [ ] **Step 1: Add screening schemas to `src/types.ts`** (append after existing exports):

```typescript
// ─────────── Screening / watchlist ───────────

export const screenNameSchema = z.enum(["momentum-12-1"]);
export type ScreenName = z.infer<typeof screenNameSchema>;

export const watchlistStatusSchema = z.enum([
  "candidate",
  "watching",
  "fading",
  "stale",
  "rejected",
]);
export type WatchlistStatus = z.infer<typeof watchlistStatusSchema>;

export const dailyBarSchema = z.object({
  date: z.string(),               // 'YYYY-MM-DD'
  close: z.number(),              // dividend-adjusted close
  volume: z.number(),
});
export type DailyBar = z.infer<typeof dailyBarSchema>;

export const scoreMetadataSchema = z.object({
  return_12_1: z.number(),
  adv_usd_30d: z.number(),
  last_price: z.number(),
  missing_days: z.number(),
});
export type ScoreMetadata = z.infer<typeof scoreMetadataSchema>;

export const screenRunSchema = z.object({
  id: z.number().int().positive(),
  screen_name: screenNameSchema,
  universe: z.string(),
  ran_at: z.number().int().positive(),
  tickers_scored: z.number().int().nonnegative(),
  tickers_passed: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  parameters_json: z.string(),
});
export type ScreenRun = z.infer<typeof screenRunSchema>;

export const scoreRowSchema = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  ticker: z.string(),
  screen_name: screenNameSchema,
  score: z.number(),
  passed: z.boolean(),
  metadata: scoreMetadataSchema,
  scored_at: z.number().int().positive(),
});
export type ScoreRow = z.infer<typeof scoreRowSchema>;

export const watchlistEntrySchema = z.object({
  ticker: z.string(),
  status: watchlistStatusSchema,
  first_surfaced_at: z.number().int().positive(),
  last_evaluated_at: z.number().int().positive(),
  current_screens: z.array(screenNameSchema),
  peak_score: z.number().nullable(),
  peak_score_at: z.number().int().nullable(),
  notes: z.string().nullable(),
});
export type WatchlistEntry = z.infer<typeof watchlistEntrySchema>;

export const statusTransitionSchema = z.object({
  id: z.number().int().positive(),
  ticker: z.string(),
  from_status: watchlistStatusSchema.nullable(),
  to_status: watchlistStatusSchema,
  reason: z.string(),
  transitioned_at: z.number().int().positive(),
});
export type StatusTransition = z.infer<typeof statusTransitionSchema>;

export const watchlistFundTagSchema = z.object({
  ticker: z.string(),
  fund_name: z.string(),
  compatible: z.boolean(),
  tagged_at: z.number().int().positive(),
});
export type WatchlistFundTag = z.infer<typeof watchlistFundTagSchema>;
```

- [ ] **Step 2: Add path constants to `src/paths.ts`**. Locate the section exporting workspace-level paths (look for `WORKSPACE` and `MCP_SERVERS`) and append:

```typescript
export const WATCHLIST_DB = join(WORKSPACE, "state", "watchlist.sqlite");
export const PRICE_CACHE_DB = join(WORKSPACE, "state", "price_cache.sqlite");
```

Also extend `MCP_SERVERS` (or equivalent constant that lists MCP server dist paths) with:

```typescript
screener: join(MCP_DIR, "screener.js"),
```

(`MCP_DIR` may be named differently — reuse whatever resolves to `dist/mcp/`.)

Ensure the workspace `state` directory is created at init time — check `src/services/init.service.ts` for an existing `mkdir` of `~/.fundx/state`. If absent, add one alongside the existing workspace-init mkdirs.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS with no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/paths.ts src/services/init.service.ts
git commit -m "feat(screening): zod schemas and paths for watchlist"
```

---

## Task 2 — Price cache service

**Files:**
- Create: `src/services/price-cache.service.ts`
- Create: `tests/price-cache.test.ts`

A read-through cache for FMP daily history, backed by its own sqlite DB with 24h TTL per ticker.

- [ ] **Step 1: Write the failing test** `tests/price-cache.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  openPriceCache,
  writeBars,
  readBars,
  isFresh,
} from "../src/services/price-cache.service.js";
import type { DailyBar } from "../src/types.js";

function makeBars(days: number): DailyBar[] {
  const out: DailyBar[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(2026, 0, i + 1).toISOString().slice(0, 10);
    out.push({ date: d, close: 100 + i, volume: 1_000_000 });
  }
  return out;
}

describe("price-cache.service", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openPriceCache(":memory:");
  });

  it("writes and reads bars for a ticker", () => {
    const bars = makeBars(5);
    writeBars(db, "AAPL", bars, Date.now());
    expect(readBars(db, "AAPL")).toEqual(bars);
  });

  it("reports fresh within 24h", () => {
    writeBars(db, "MSFT", makeBars(3), Date.now());
    expect(isFresh(db, "MSFT", Date.now())).toBe(true);
  });

  it("reports stale after 24h+1ms", () => {
    const wrote = Date.now() - (24 * 3600 * 1000 + 1);
    writeBars(db, "GOOG", makeBars(3), wrote);
    expect(isFresh(db, "GOOG", Date.now())).toBe(false);
  });

  it("returns empty array for unknown ticker", () => {
    expect(readBars(db, "UNKNOWN")).toEqual([]);
  });

  it("overwrites on re-write", () => {
    writeBars(db, "AAPL", makeBars(3), Date.now());
    writeBars(db, "AAPL", makeBars(5), Date.now());
    expect(readBars(db, "AAPL")).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test price-cache`
Expected: FAIL — module not found / exports missing.

- [ ] **Step 3: Implement `src/services/price-cache.service.ts`**:

```typescript
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DailyBar } from "../types.js";
import { PRICE_CACHE_DB } from "../paths.js";

const TTL_MS = 24 * 60 * 60 * 1000;

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS price_cache (
     ticker TEXT NOT NULL,
     date   TEXT NOT NULL,
     close  REAL NOT NULL,
     volume REAL NOT NULL,
     PRIMARY KEY (ticker, date)
   )`,
  `CREATE TABLE IF NOT EXISTS price_cache_meta (
     ticker      TEXT PRIMARY KEY,
     written_at  INTEGER NOT NULL
   )`,
];

export function openPriceCache(path: string = PRICE_CACHE_DB): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  for (const stmt of DDL) db.prepare(stmt).run();
  return db;
}

export function writeBars(
  db: Database.Database,
  ticker: string,
  bars: DailyBar[],
  now: number,
): void {
  const del = db.prepare("DELETE FROM price_cache WHERE ticker = ?");
  const ins = db.prepare(
    "INSERT INTO price_cache (ticker, date, close, volume) VALUES (?, ?, ?, ?)",
  );
  const meta = db.prepare(
    "INSERT INTO price_cache_meta (ticker, written_at) VALUES (?, ?) " +
      "ON CONFLICT(ticker) DO UPDATE SET written_at = excluded.written_at",
  );
  const tx = db.transaction((t: string, b: DailyBar[], ts: number) => {
    del.run(t);
    for (const bar of b) ins.run(t, bar.date, bar.close, bar.volume);
    meta.run(t, ts);
  });
  tx(ticker, bars, now);
}

export function readBars(db: Database.Database, ticker: string): DailyBar[] {
  const rows = db
    .prepare(
      "SELECT date, close, volume FROM price_cache WHERE ticker = ? ORDER BY date ASC",
    )
    .all(ticker) as DailyBar[];
  return rows;
}

export function isFresh(
  db: Database.Database,
  ticker: string,
  now: number,
): boolean {
  const row = db
    .prepare("SELECT written_at FROM price_cache_meta WHERE ticker = ?")
    .get(ticker) as { written_at: number } | undefined;
  if (!row) return false;
  return now - row.written_at <= TTL_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test price-cache`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/price-cache.service.ts tests/price-cache.test.ts
git commit -m "feat(screening): price cache service with 24h TTL"
```

---

## Task 3 — Market service extensions

**Files:**
- Modify: `src/services/market.service.ts`
- Create: `src/constants/sp500.ts`

- [ ] **Step 1: Create fallback `src/constants/sp500.ts`** with ~500 tickers. Source from a recent canonical list (e.g. Wikipedia "List of S&P 500 companies"). If the implementer can't access a live source, seed with a minimum of ~50 large-cap tickers and add a comment `// TODO: populate full S&P 500 list before production use`.

```typescript
// S&P 500 constituents fallback. Refresh semi-annually.
// Used when FMP /sp500_constituent is unavailable or not in user's plan.
export const SP500_FALLBACK: readonly string[] = [
  "AAPL", "MSFT", "AMZN", "NVDA", "GOOGL", "GOOG", "META", "TSLA",
  "BRK.B", "LLY", "AVGO", "JPM", "V", "XOM", "UNH", "MA",
  // ... full ~500 ticker list ...
];
```

- [ ] **Step 2: Add `getHistoricalDaily` and `getSp500Constituents` to `src/services/market.service.ts`** (append at bottom of file):

```typescript
import type { DailyBar } from "../types.js";

export async function getHistoricalDaily(
  ticker: string,
  days: number,
  apiKey: string,
): Promise<DailyBar[]> {
  const url =
    `${FMP_BASE}/historical-price-full/${encodeURIComponent(ticker)}` +
    `?timeseries=${days}&apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(
      `FMP /historical-price-full failed for ${ticker}: ${resp.status}`,
    );
  }
  const body = (await resp.json()) as {
    historical?: Array<{ date: string; adjClose?: number; close: number; volume: number }>;
  };
  const historical = body.historical ?? [];
  // FMP returns newest first; reverse for chronological order.
  return historical
    .slice()
    .reverse()
    .map((r) => ({
      date: r.date,
      close: r.adjClose ?? r.close,
      volume: r.volume,
    }));
}

export async function getSp500Constituents(apiKey: string): Promise<string[]> {
  const url = `${FMP_BASE}/sp500_constituent?apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    const { SP500_FALLBACK } = await import("../constants/sp500.js");
    return [...SP500_FALLBACK];
  }
  const body = (await resp.json()) as Array<{ symbol: string }>;
  if (!Array.isArray(body) || body.length === 0) {
    const { SP500_FALLBACK } = await import("../constants/sp500.js");
    return [...SP500_FALLBACK];
  }
  return body.map((r) => r.symbol);
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/market.service.ts src/constants/sp500.ts
git commit -m "feat(screening): market service getHistoricalDaily + sp500 constituents"
```

---

## Task 4 — Watchlist DB schema + basic CRUD

**Files:**
- Create: `src/services/watchlist.service.ts` (initial: schema + read queries only)
- Create: `tests/watchlist-transitions.test.ts` (CRUD tests only for now)

- [ ] **Step 1: Write failing CRUD test** `tests/watchlist-transitions.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  openWatchlistDb,
  insertScreenRun,
  insertScore,
  getWatchlistEntry,
  queryWatchlist,
} from "../src/services/watchlist.service.js";

describe("watchlist.service — CRUD", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openWatchlistDb(":memory:");
  });

  it("opens with expected tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "screen_runs",
        "scores",
        "watchlist",
        "watchlist_fund_tags",
        "status_transitions",
      ]),
    );
  });

  it("inserts screen run and scores", () => {
    const runId = insertScreenRun(db, {
      screen_name: "momentum-12-1",
      universe: "sp500",
      ran_at: 1_700_000_000_000,
      tickers_scored: 100,
      tickers_passed: 10,
      duration_ms: 1234,
      parameters_json: "{}",
    });
    expect(runId).toBeGreaterThan(0);

    insertScore(db, {
      run_id: runId,
      ticker: "AAPL",
      screen_name: "momentum-12-1",
      score: 0.42,
      passed: true,
      metadata: {
        return_12_1: 0.42,
        adv_usd_30d: 20_000_000,
        last_price: 180,
        missing_days: 0,
      },
      scored_at: 1_700_000_000_000,
    });

    expect(getWatchlistEntry(db, "AAPL")).toBeNull();
  });

  it("returns empty list from queryWatchlist on empty db", () => {
    expect(queryWatchlist(db, {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test watchlist-transitions`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `src/services/watchlist.service.ts`** (initial — CRUD only):

```typescript
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  type ScreenRun,
  type ScoreRow,
  type ScoreMetadata,
  type WatchlistEntry,
  type WatchlistStatus,
  type ScreenName,
  watchlistStatusSchema,
  screenNameSchema,
} from "../types.js";
import { WATCHLIST_DB } from "../paths.js";

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS screen_runs (
     id               INTEGER PRIMARY KEY,
     screen_name      TEXT    NOT NULL,
     universe         TEXT    NOT NULL,
     ran_at           INTEGER NOT NULL,
     tickers_scored   INTEGER NOT NULL,
     tickers_passed   INTEGER NOT NULL,
     duration_ms      INTEGER NOT NULL,
     parameters_json  TEXT    NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS scores (
     id             INTEGER PRIMARY KEY,
     run_id         INTEGER NOT NULL REFERENCES screen_runs(id),
     ticker         TEXT    NOT NULL,
     screen_name    TEXT    NOT NULL,
     score          REAL    NOT NULL,
     passed         INTEGER NOT NULL,
     metadata_json  TEXT    NOT NULL,
     scored_at      INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_scores_ticker_time ON scores(ticker, scored_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scores_screen_time ON scores(screen_name, scored_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_scores_run ON scores(run_id)`,
  `CREATE TABLE IF NOT EXISTS watchlist (
     ticker                TEXT    PRIMARY KEY,
     status                TEXT    NOT NULL,
     first_surfaced_at     INTEGER NOT NULL,
     last_evaluated_at     INTEGER NOT NULL,
     current_screens_json  TEXT    NOT NULL,
     peak_score            REAL,
     peak_score_at         INTEGER,
     notes                 TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS watchlist_fund_tags (
     ticker      TEXT    NOT NULL,
     fund_name   TEXT    NOT NULL,
     compatible  INTEGER NOT NULL,
     tagged_at   INTEGER NOT NULL,
     PRIMARY KEY (ticker, fund_name)
   )`,
  `CREATE TABLE IF NOT EXISTS status_transitions (
     id                INTEGER PRIMARY KEY,
     ticker            TEXT    NOT NULL,
     from_status       TEXT,
     to_status         TEXT    NOT NULL,
     reason            TEXT    NOT NULL,
     transitioned_at   INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_transitions_ticker ON status_transitions(ticker, transitioned_at DESC)`,
];

export function openWatchlistDb(path: string = WATCHLIST_DB): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  for (const stmt of DDL) db.prepare(stmt).run();
  return db;
}

export function insertScreenRun(
  db: Database.Database,
  run: Omit<ScreenRun, "id">,
): number {
  const stmt = db.prepare(
    "INSERT INTO screen_runs (screen_name, universe, ran_at, tickers_scored, tickers_passed, duration_ms, parameters_json) " +
      "VALUES (@screen_name, @universe, @ran_at, @tickers_scored, @tickers_passed, @duration_ms, @parameters_json)",
  );
  const res = stmt.run(run);
  return Number(res.lastInsertRowid);
}

export function insertScore(
  db: Database.Database,
  score: Omit<ScoreRow, "id"> & { metadata: ScoreMetadata },
): number {
  const stmt = db.prepare(
    "INSERT INTO scores (run_id, ticker, screen_name, score, passed, metadata_json, scored_at) " +
      "VALUES (@run_id, @ticker, @screen_name, @score, @passed, @metadata_json, @scored_at)",
  );
  const res = stmt.run({
    run_id: score.run_id,
    ticker: score.ticker,
    screen_name: score.screen_name,
    score: score.score,
    passed: score.passed ? 1 : 0,
    metadata_json: JSON.stringify(score.metadata),
    scored_at: score.scored_at,
  });
  return Number(res.lastInsertRowid);
}

export function getWatchlistEntry(
  db: Database.Database,
  ticker: string,
): WatchlistEntry | null {
  const row = db
    .prepare("SELECT * FROM watchlist WHERE ticker = ?")
    .get(ticker) as
    | {
        ticker: string;
        status: string;
        first_surfaced_at: number;
        last_evaluated_at: number;
        current_screens_json: string;
        peak_score: number | null;
        peak_score_at: number | null;
        notes: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    ticker: row.ticker,
    status: watchlistStatusSchema.parse(row.status),
    first_surfaced_at: row.first_surfaced_at,
    last_evaluated_at: row.last_evaluated_at,
    current_screens: JSON.parse(row.current_screens_json).map((s: string) =>
      screenNameSchema.parse(s),
    ),
    peak_score: row.peak_score,
    peak_score_at: row.peak_score_at,
    notes: row.notes,
  };
}

export interface WatchlistQuery {
  status?: WatchlistStatus[];
  screen?: ScreenName;
  fund?: string;
  ticker?: string;
  limit?: number;
}

export function queryWatchlist(
  db: Database.Database,
  q: WatchlistQuery,
): WatchlistEntry[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (q.status && q.status.length > 0) {
    where.push(`w.status IN (${q.status.map((_, i) => `@status_${i}`).join(",")})`);
    q.status.forEach((s, i) => (params[`status_${i}`] = s));
  }
  if (q.screen) {
    where.push("w.current_screens_json LIKE @screen_pat");
    params.screen_pat = `%${q.screen}%`;
  }
  if (q.ticker) {
    where.push("w.ticker = @ticker");
    params.ticker = q.ticker;
  }
  if (q.fund) {
    where.push(
      "w.ticker IN (SELECT ticker FROM watchlist_fund_tags WHERE fund_name = @fund AND compatible = 1)",
    );
    params.fund = q.fund;
  }
  const sql =
    "SELECT * FROM watchlist w" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY w.last_evaluated_at DESC" +
    (q.limit ? ` LIMIT ${Math.min(q.limit, 1000)}` : "");
  const rows = db.prepare(sql).all(params) as Array<{
    ticker: string;
    status: string;
    first_surfaced_at: number;
    last_evaluated_at: number;
    current_screens_json: string;
    peak_score: number | null;
    peak_score_at: number | null;
    notes: string | null;
  }>;
  return rows.map((row) => ({
    ticker: row.ticker,
    status: watchlistStatusSchema.parse(row.status),
    first_surfaced_at: row.first_surfaced_at,
    last_evaluated_at: row.last_evaluated_at,
    current_screens: JSON.parse(row.current_screens_json).map((s: string) =>
      screenNameSchema.parse(s),
    ),
    peak_score: row.peak_score,
    peak_score_at: row.peak_score_at,
    notes: row.notes,
  }));
}
```

- [ ] **Step 4: Run test**

Run: `pnpm test watchlist-transitions`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/watchlist.service.ts tests/watchlist-transitions.test.ts
git commit -m "feat(screening): watchlist db schema + basic crud"
```

---

## Task 5 — State transition logic

**Files:**
- Modify: `src/services/watchlist.service.ts` (append transition logic)
- Modify: `tests/watchlist-transitions.test.ts` (append transition tests)

- [ ] **Step 1: Add failing transition tests** to `tests/watchlist-transitions.test.ts`:

```typescript
import {
  applyTransitionsForRun,
  getTrajectory,
  tagManually,
} from "../src/services/watchlist.service.js";

describe("watchlist.service — transitions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openWatchlistDb(":memory:");
  });

  function run(ranAt: number, scores: Array<{ t: string; s: number; pass: boolean }>) {
    const runId = insertScreenRun(db, {
      screen_name: "momentum-12-1",
      universe: "sp500",
      ran_at: ranAt,
      tickers_scored: scores.length,
      tickers_passed: scores.filter((x) => x.pass).length,
      duration_ms: 0,
      parameters_json: "{}",
    });
    for (const { t, s, pass } of scores) {
      insertScore(db, {
        run_id: runId,
        ticker: t,
        screen_name: "momentum-12-1",
        score: s,
        passed: pass,
        metadata: {
          return_12_1: s,
          adv_usd_30d: 20_000_000,
          last_price: 100,
          missing_days: 0,
        },
        scored_at: ranAt,
      });
    }
    applyTransitionsForRun(db, runId, ranAt);
    return runId;
  }

  const day = 24 * 3600 * 1000;
  const t0 = 1_700_000_000_000;

  it("ø → candidate on first pass", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("candidate");
  });

  it("candidate → watching on 2 consecutive passes", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 0.31, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("watching");
  });

  it("watching → fading when score drops ≥20% from peak (within 60d)", () => {
    run(t0, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + 2 * day, [{ t: "AAPL", s: 0.7, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("fading");
  });

  it("fading → rejected after 3 consecutive failing runs", () => {
    run(t0, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + 2 * day, [{ t: "AAPL", s: 0.7, pass: true }]);
    run(t0 + 3 * day, [{ t: "AAPL", s: 0.4, pass: false }]);
    run(t0 + 4 * day, [{ t: "AAPL", s: 0.3, pass: false }]);
    run(t0 + 5 * day, [{ t: "AAPL", s: 0.2, pass: false }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("rejected");
  });

  it("fading → watching on re-entry (passes again within 10% of peak)", () => {
    run(t0, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 1.0, pass: true }]);
    run(t0 + 2 * day, [{ t: "AAPL", s: 0.7, pass: true }]);
    run(t0 + 3 * day, [{ t: "AAPL", s: 0.95, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("watching");
  });

  it("* → stale after 90 days without score", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    run(t0 + 91 * day, [{ t: "MSFT", s: 0.5, pass: true }]);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("stale");
  });

  it("manual tag records transition and updates status", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    tagManually(db, "AAPL", "rejected", "manual:test:not fit", t0 + day);
    expect(getWatchlistEntry(db, "AAPL")?.status).toBe("rejected");
    const traj = getTrajectory(db, "AAPL");
    expect(traj.transitions.at(-1)?.reason).toBe("manual:test:not fit");
  });

  it("getTrajectory returns scores and transitions in ascending time order", () => {
    run(t0, [{ t: "AAPL", s: 0.3, pass: true }]);
    run(t0 + day, [{ t: "AAPL", s: 0.4, pass: true }]);
    const traj = getTrajectory(db, "AAPL");
    expect(traj.scores).toHaveLength(2);
    expect(traj.scores[0].scored_at).toBeLessThan(traj.scores[1].scored_at);
    expect(traj.transitions.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm test watchlist-transitions`
Expected: FAIL — `applyTransitionsForRun` etc. not exported.

- [ ] **Step 3: Append transition logic** to `src/services/watchlist.service.ts`:

```typescript
import {
  type StatusTransition,
  statusTransitionSchema,
} from "../types.js";

const PEAK_WINDOW_MS = 60 * 24 * 3600 * 1000;
const STALE_MS = 90 * 24 * 3600 * 1000;
const REJECT_MAX_DAYS_WITHOUT_PASS = 30;
const REJECT_CONSECUTIVE_FAILS = 3;
const FADING_DROP_THRESHOLD = 0.20;
const REENTRY_WITHIN_OF_PEAK = 0.10;

interface ScoreRecord {
  ticker: string;
  score: number;
  passed: boolean;
  scored_at: number;
  screen_name: ScreenName;
}

export function applyTransitionsForRun(
  db: Database.Database,
  runId: number,
  now: number,
): void {
  const scores = db
    .prepare(
      "SELECT ticker, score, passed, scored_at, screen_name FROM scores WHERE run_id = ?",
    )
    .all(runId) as Array<{
    ticker: string;
    score: number;
    passed: number;
    scored_at: number;
    screen_name: string;
  }>;

  const tx = db.transaction(() => {
    const touched = new Set<string>();
    for (const s of scores) {
      touched.add(s.ticker);
      const rec: ScoreRecord = {
        ticker: s.ticker,
        score: s.score,
        passed: s.passed === 1,
        scored_at: s.scored_at,
        screen_name: screenNameSchema.parse(s.screen_name),
      };
      upsertFromScore(db, rec, now);
    }
    const stale = db
      .prepare(
        "SELECT ticker FROM watchlist WHERE status != 'stale' AND status != 'rejected' AND last_evaluated_at < ?",
      )
      .all(now - STALE_MS) as Array<{ ticker: string }>;
    for (const r of stale) {
      if (touched.has(r.ticker)) continue;
      transitionTo(db, r.ticker, "stale", "auto:no_update_90d", now);
    }
  });
  tx();
}

function upsertFromScore(
  db: Database.Database,
  rec: ScoreRecord,
  now: number,
): void {
  const existing = getWatchlistEntry(db, rec.ticker);

  if (!existing) {
    if (!rec.passed) return;
    db.prepare(
      "INSERT INTO watchlist (ticker, status, first_surfaced_at, last_evaluated_at, current_screens_json, peak_score, peak_score_at, notes) " +
        "VALUES (?, 'candidate', ?, ?, ?, ?, ?, NULL)",
    ).run(
      rec.ticker,
      rec.scored_at,
      rec.scored_at,
      JSON.stringify([rec.screen_name]),
      rec.score,
      rec.scored_at,
    );
    insertStatusTransition(db, {
      ticker: rec.ticker,
      from_status: null,
      to_status: "candidate",
      reason: `passed_screen_${rec.screen_name}`,
      transitioned_at: rec.scored_at,
    });
    return;
  }

  const peakActive =
    existing.peak_score != null &&
    existing.peak_score_at != null &&
    rec.scored_at - existing.peak_score_at <= PEAK_WINDOW_MS;
  let newPeak = existing.peak_score;
  let newPeakAt = existing.peak_score_at;
  if (!peakActive || rec.score > (existing.peak_score ?? -Infinity)) {
    newPeak = rec.score;
    newPeakAt = rec.scored_at;
  }

  const currentScreens = new Set(existing.current_screens);
  if (rec.passed) currentScreens.add(rec.screen_name);
  else currentScreens.delete(rec.screen_name);

  db.prepare(
    "UPDATE watchlist SET last_evaluated_at = ?, current_screens_json = ?, peak_score = ?, peak_score_at = ? WHERE ticker = ?",
  ).run(
    rec.scored_at,
    JSON.stringify([...currentScreens]),
    newPeak,
    newPeakAt,
    rec.ticker,
  );

  const next = nextStatus(existing.status, rec, newPeak, newPeakAt, db);
  if (next.status !== existing.status) {
    transitionTo(db, rec.ticker, next.status, next.reason, rec.scored_at);
  }
}

function nextStatus(
  current: WatchlistStatus,
  rec: ScoreRecord,
  peak: number | null,
  peakAt: number | null,
  db: Database.Database,
): { status: WatchlistStatus; reason: string } {
  if (current === "candidate" && rec.passed) {
    const count = countConsecutivePasses(db, rec.ticker, rec.screen_name);
    if (count >= 2) return { status: "watching", reason: "two_consecutive_passes" };
  }
  if (current === "watching" && peak != null && peakAt != null) {
    const withinWindow = rec.scored_at - peakAt <= PEAK_WINDOW_MS;
    if (withinWindow && (peak - rec.score) / peak >= FADING_DROP_THRESHOLD) {
      return { status: "fading", reason: "score_drop_20pct_from_peak" };
    }
  }
  if (current === "fading") {
    if (
      rec.passed &&
      peak != null &&
      (peak - rec.score) / peak <= REENTRY_WITHIN_OF_PEAK
    ) {
      return { status: "watching", reason: "reentry_within_10pct_of_peak" };
    }
    const fails = countConsecutiveFails(db, rec.ticker, rec.screen_name);
    if (fails >= REJECT_CONSECUTIVE_FAILS) {
      return {
        status: "rejected",
        reason: `${REJECT_CONSECUTIVE_FAILS}_consecutive_fails`,
      };
    }
    const lastPass = lastPassAt(db, rec.ticker, rec.screen_name);
    if (
      lastPass != null &&
      rec.scored_at - lastPass >= REJECT_MAX_DAYS_WITHOUT_PASS * 24 * 3600 * 1000
    ) {
      return { status: "rejected", reason: "30_days_without_pass" };
    }
  }
  return { status: current, reason: "" };
}

function countConsecutivePasses(
  db: Database.Database,
  ticker: string,
  screen: ScreenName,
): number {
  const rows = db
    .prepare(
      "SELECT passed FROM scores WHERE ticker = ? AND screen_name = ? ORDER BY scored_at DESC",
    )
    .all(ticker, screen) as Array<{ passed: number }>;
  let n = 0;
  for (const r of rows) {
    if (r.passed === 1) n++;
    else break;
  }
  return n;
}

function countConsecutiveFails(
  db: Database.Database,
  ticker: string,
  screen: ScreenName,
): number {
  const rows = db
    .prepare(
      "SELECT passed FROM scores WHERE ticker = ? AND screen_name = ? ORDER BY scored_at DESC",
    )
    .all(ticker, screen) as Array<{ passed: number }>;
  let n = 0;
  for (const r of rows) {
    if (r.passed === 0) n++;
    else break;
  }
  return n;
}

function lastPassAt(
  db: Database.Database,
  ticker: string,
  screen: ScreenName,
): number | null {
  const row = db
    .prepare(
      "SELECT scored_at FROM scores WHERE ticker = ? AND screen_name = ? AND passed = 1 ORDER BY scored_at DESC LIMIT 1",
    )
    .get(ticker, screen) as { scored_at: number } | undefined;
  return row?.scored_at ?? null;
}

function transitionTo(
  db: Database.Database,
  ticker: string,
  to: WatchlistStatus,
  reason: string,
  at: number,
): void {
  const existing = getWatchlistEntry(db, ticker);
  const from = existing?.status ?? null;
  db.prepare(
    "UPDATE watchlist SET status = ?, last_evaluated_at = ? WHERE ticker = ?",
  ).run(to, at, ticker);
  insertStatusTransition(db, {
    ticker,
    from_status: from,
    to_status: to,
    reason,
    transitioned_at: at,
  });
}

export function insertStatusTransition(
  db: Database.Database,
  t: Omit<StatusTransition, "id">,
): number {
  const res = db
    .prepare(
      "INSERT INTO status_transitions (ticker, from_status, to_status, reason, transitioned_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(t.ticker, t.from_status, t.to_status, t.reason, t.transitioned_at);
  return Number(res.lastInsertRowid);
}

export function tagManually(
  db: Database.Database,
  ticker: string,
  status: WatchlistStatus,
  reason: string,
  at: number,
): void {
  const existing = getWatchlistEntry(db, ticker);
  if (!existing) {
    db.prepare(
      "INSERT INTO watchlist (ticker, status, first_surfaced_at, last_evaluated_at, current_screens_json, peak_score, peak_score_at, notes) " +
        "VALUES (?, ?, ?, ?, '[]', NULL, NULL, NULL)",
    ).run(ticker, status, at, at);
    insertStatusTransition(db, {
      ticker,
      from_status: null,
      to_status: status,
      reason,
      transitioned_at: at,
    });
    return;
  }
  transitionTo(db, ticker, status, reason, at);
}

export interface Trajectory {
  ticker: string;
  entry: WatchlistEntry | null;
  scores: Array<{
    scored_at: number;
    score: number;
    passed: boolean;
    screen_name: ScreenName;
  }>;
  transitions: StatusTransition[];
}

export function getTrajectory(
  db: Database.Database,
  ticker: string,
): Trajectory {
  const scoreRows = db
    .prepare(
      "SELECT scored_at, score, passed, screen_name FROM scores WHERE ticker = ? ORDER BY scored_at ASC",
    )
    .all(ticker) as Array<{
    scored_at: number;
    score: number;
    passed: number;
    screen_name: string;
  }>;
  const transitionRows = db
    .prepare(
      "SELECT * FROM status_transitions WHERE ticker = ? ORDER BY transitioned_at ASC",
    )
    .all(ticker) as Array<{
    id: number;
    ticker: string;
    from_status: string | null;
    to_status: string;
    reason: string;
    transitioned_at: number;
  }>;
  return {
    ticker,
    entry: getWatchlistEntry(db, ticker),
    scores: scoreRows.map((r) => ({
      scored_at: r.scored_at,
      score: r.score,
      passed: r.passed === 1,
      screen_name: screenNameSchema.parse(r.screen_name),
    })),
    transitions: transitionRows.map((r) =>
      statusTransitionSchema.parse({
        id: r.id,
        ticker: r.ticker,
        from_status: r.from_status,
        to_status: r.to_status,
        reason: r.reason,
        transitioned_at: r.transitioned_at,
      }),
    ),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test watchlist-transitions`
Expected: PASS — all transition tests plus the CRUD tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/watchlist.service.ts tests/watchlist-transitions.test.ts
git commit -m "feat(screening): watchlist state machine and trajectory"
```

---

## Task 6 — Momentum 12-1 scorer (pure function)

**Files:**
- Create: `src/services/screening.service.ts`
- Create: `tests/screening.test.ts`

- [ ] **Step 1: Write the failing test** `tests/screening.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { scoreMomentum121 } from "../src/services/screening.service.js";
import type { DailyBar } from "../src/types.js";

function bars(closes: number[]): DailyBar[] {
  return closes.map((c, i) => {
    const d = new Date(2025, 0, i + 1).toISOString().slice(0, 10);
    return { date: d, close: c, volume: 1_000_000 };
  });
}

describe("scoreMomentum121", () => {
  it("returns null when fewer than 273 bars", () => {
    expect(scoreMomentum121(bars(Array(100).fill(100)))).toBeNull();
  });

  it("skips the most recent 21 trading days (1 month) in the numerator", () => {
    const closes = [...Array(252).fill(100), ...Array(21).fill(50)];
    const s = scoreMomentum121(bars(closes));
    expect(s).not.toBeNull();
    expect(s!.return_12_1).toBeCloseTo(0, 6);
  });

  it("computes positive return when t-21 > t-252", () => {
    const closes = [
      ...Array(252)
        .fill(0)
        .map((_, i) => 100 + i * 0.1),
      ...Array(21).fill(200),
    ];
    const s = scoreMomentum121(bars(closes));
    expect(s!.return_12_1).toBeGreaterThan(0);
  });

  it("returns null with insufficient history", () => {
    expect(scoreMomentum121(bars(Array(200).fill(100)))).toBeNull();
  });

  it("computes 30-day ADV in USD from last 30 bars", () => {
    const closes = Array(273).fill(100);
    const barArr = bars(closes).map((b, i) => ({
      ...b,
      volume: i >= 243 ? 500_000 : 1_000_000,
    }));
    const s = scoreMomentum121(barArr);
    expect(s!.adv_usd_30d).toBeCloseTo(50_000_000, -3);
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm test screening`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/services/screening.service.ts`** with the scorer only:

```typescript
import type { DailyBar, ScoreMetadata } from "../types.js";

const LOOKBACK_TOTAL_DAYS = 273;
const SKIP_RECENT_DAYS = 21;
const BASE_DAYS = 252;
const ADV_WINDOW_DAYS = 30;

export interface MomentumScore {
  score: number;
  return_12_1: number;
  adv_usd_30d: number;
  last_price: number;
  missing_days: number;
}

export function scoreMomentum121(bars: DailyBar[]): MomentumScore | null {
  if (bars.length < LOOKBACK_TOTAL_DAYS) return null;
  const n = bars.length;
  const tMinus21 = bars[n - 1 - SKIP_RECENT_DAYS];
  const tMinus252 = bars[n - 1 - SKIP_RECENT_DAYS - (BASE_DAYS - SKIP_RECENT_DAYS)];
  if (!tMinus21 || !tMinus252 || tMinus252.close === 0) return null;
  const return_12_1 = tMinus21.close / tMinus252.close - 1;

  const last30 = bars.slice(-ADV_WINDOW_DAYS);
  const adv_usd_30d =
    last30.reduce((s, b) => s + b.close * b.volume, 0) / ADV_WINDOW_DAYS;

  return {
    score: return_12_1,
    return_12_1,
    adv_usd_30d,
    last_price: bars[n - 1].close,
    missing_days: Math.max(0, LOOKBACK_TOTAL_DAYS - bars.length),
  };
}

export function metadataFromScore(ms: MomentumScore): ScoreMetadata {
  return {
    return_12_1: ms.return_12_1,
    adv_usd_30d: ms.adv_usd_30d,
    last_price: ms.last_price,
    missing_days: ms.missing_days,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test screening`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/screening.service.ts tests/screening.test.ts
git commit -m "feat(screening): pure momentum 12-1 scorer"
```

---

## Task 7 — Fund compatibility tagging

**Files:**
- Modify: `src/services/watchlist.service.ts` (append `tagFundCompatibilityForTickers`)
- Modify: `tests/watchlist-transitions.test.ts` (append fund-tag tests)

- [ ] **Step 1: Add failing test** to `tests/watchlist-transitions.test.ts`:

```typescript
import { tagFundCompatibilityForTickers } from "../src/services/watchlist.service.js";
import type { FundConfig } from "../src/types.js";

describe("tagFundCompatibilityForTickers", () => {
  let db: Database.Database;
  beforeEach(() => (db = openWatchlistDb(":memory:")));

  function fundWithEtf(name: string, tickers: string[]): FundConfig {
    return {
      fund: {
        name,
        display_name: name,
        description: "",
        created: "2026-01-01",
        status: "active",
      },
      capital: { initial: 10000, currency: "USD" },
      objective: { type: "growth", target_multiple: 2, horizon_months: 12 },
      risk: {
        profile: "moderate",
        max_drawdown_pct: 30,
        max_position_pct: 20,
        max_leverage: 1,
        stop_loss_pct: 10,
        max_daily_loss_pct: 5,
      },
      universe: {
        allowed: [{ type: "etf", tickers }],
        forbidden: [],
      },
      schedule: {
        timezone: "UTC",
        trading_days: ["MON", "TUE", "WED", "THU", "FRI"],
        sessions: {},
      },
      broker: { mode: "paper" },
      notifications: {
        telegram: { enabled: false },
        quiet_hours: { enabled: false, from: "22:00", to: "08:00" },
        claude: { personality: "neutral" },
      },
    } as FundConfig;
  }

  it("tags compatible when ticker in fund etf universe", () => {
    const f = fundWithEtf("my-growth", ["AAPL", "MSFT"]);
    tagFundCompatibilityForTickers(db, [f], ["AAPL", "GOOG"], 1000);
    const aapl = db
      .prepare(
        "SELECT * FROM watchlist_fund_tags WHERE ticker='AAPL' AND fund_name='my-growth'",
      )
      .get() as { compatible: number } | undefined;
    expect(aapl?.compatible).toBe(1);
    const goog = db
      .prepare(
        "SELECT * FROM watchlist_fund_tags WHERE ticker='GOOG' AND fund_name='my-growth'",
      )
      .get() as { compatible: number } | undefined;
    expect(goog?.compatible).toBe(0);
  });

  it("skips tagging for funds whose universe is sector/strategy/protocol (not etf)", () => {
    const f = {
      ...fundWithEtf("sector-fund", []),
      universe: {
        allowed: [{ type: "sector", sectors: ["technology"] }],
        forbidden: [],
      },
    } as unknown as FundConfig;
    tagFundCompatibilityForTickers(db, [f], ["AAPL"], 1000);
    const rows = db.prepare("SELECT * FROM watchlist_fund_tags").all();
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm test watchlist-transitions`
Expected: FAIL.

- [ ] **Step 3: Append** to `src/services/watchlist.service.ts`:

```typescript
import type { FundConfig } from "../types.js";

export function tagFundCompatibilityForTickers(
  db: Database.Database,
  fundConfigs: FundConfig[],
  tickers: string[],
  now: number,
): void {
  const stmt = db.prepare(
    "INSERT INTO watchlist_fund_tags (ticker, fund_name, compatible, tagged_at) " +
      "VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(ticker, fund_name) DO UPDATE SET compatible = excluded.compatible, tagged_at = excluded.tagged_at",
  );
  const tx = db.transaction(() => {
    for (const fund of fundConfigs) {
      const etfEntries = fund.universe.allowed.filter(
        (e) => e.type === "etf",
      ) as Array<{ type: "etf"; tickers: string[] }>;
      if (etfEntries.length === 0) continue;
      const allowed = new Set(etfEntries.flatMap((e) => e.tickers));
      for (const t of tickers) {
        stmt.run(t, fund.fund.name, allowed.has(t) ? 1 : 0, now);
      }
    }
  });
  tx();
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test watchlist-transitions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/watchlist.service.ts tests/watchlist-transitions.test.ts
git commit -m "feat(screening): fund compatibility tagging (etf universe only in v1)"
```

---

## Task 8 — `runScreen` orchestrator

**Files:**
- Modify: `src/services/screening.service.ts`
- Modify: `tests/screening.test.ts`

- [ ] **Step 1: Add an integration test** to `tests/screening.test.ts`:

```typescript
import { runScreen } from "../src/services/screening.service.js";
import {
  openWatchlistDb,
  queryWatchlist,
} from "../src/services/watchlist.service.js";
import {
  openPriceCache,
  writeBars,
} from "../src/services/price-cache.service.js";

function makeFixtureBars(startClose: number, endClose: number): DailyBar[] {
  const arr: DailyBar[] = [];
  for (let i = 0; i < 273; i++) {
    const c = startClose + ((endClose - startClose) * i) / 272;
    arr.push({
      date: new Date(2025, 0, 1 + i).toISOString().slice(0, 10),
      close: c,
      volume: 500_000,
    });
  }
  return arr;
}

describe("runScreen (integration)", () => {
  it("runs momentum-12-1 end-to-end against a 3-ticker universe", async () => {
    const wdb = openWatchlistDb(":memory:");
    const pcdb = openPriceCache(":memory:");
    writeBars(pcdb, "AAA", makeFixtureBars(100, 200), Date.now());
    writeBars(pcdb, "BBB", makeFixtureBars(100, 101), Date.now());
    writeBars(pcdb, "CCC", makeFixtureBars(100, 80), Date.now());

    const summary = await runScreen({
      watchlistDb: wdb,
      priceCacheDb: pcdb,
      universe: ["AAA", "BBB", "CCC"],
      universeLabel: "test",
      fetchBars: async () => {
        throw new Error("should not fetch — cache is primed");
      },
      fundConfigs: [],
      now: Date.now(),
    });

    expect(summary.tickers_scored).toBe(3);
    expect(summary.tickers_passed).toBeGreaterThan(0);

    const wl = queryWatchlist(wdb, { status: ["candidate", "watching"] });
    expect(wl.map((e) => e.ticker)).toContain("AAA");
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm test screening`
Expected: FAIL.

- [ ] **Step 3: Append `runScreen`** to `src/services/screening.service.ts`:

```typescript
import type Database from "better-sqlite3";
import {
  insertScreenRun,
  insertScore,
  applyTransitionsForRun,
  tagFundCompatibilityForTickers,
} from "./watchlist.service.js";
import {
  readBars,
  isFresh,
  writeBars,
} from "./price-cache.service.js";
import type { DailyBar, FundConfig, ScreenName } from "../types.js";

const MIN_PRICE = 5;
const MIN_ADV_USD = 10_000_000;
const TOP_DECILE_FRACTION = 0.10;

export interface RunScreenOptions {
  watchlistDb: Database.Database;
  priceCacheDb: Database.Database;
  universe: string[];
  universeLabel: string;
  fetchBars: (ticker: string) => Promise<DailyBar[]>;
  fundConfigs: FundConfig[];
  now: number;
  screenName?: ScreenName;
}

export interface RunScreenSummary {
  run_id: number;
  screen_name: ScreenName;
  universe: string;
  tickers_scored: number;
  tickers_passed: number;
  duration_ms: number;
  top_ten: Array<{ ticker: string; score: number }>;
}

export async function runScreen(
  opts: RunScreenOptions,
): Promise<RunScreenSummary> {
  const started = Date.now();
  const screenName: ScreenName = opts.screenName ?? "momentum-12-1";
  const parameters = {
    screenName,
    min_price: MIN_PRICE,
    min_adv_usd: MIN_ADV_USD,
    top_decile_fraction: TOP_DECILE_FRACTION,
  };

  type Scored = { ticker: string; score: MomentumScore | null };
  const scored: Scored[] = [];
  for (const ticker of opts.universe) {
    let bars: DailyBar[];
    if (isFresh(opts.priceCacheDb, ticker, opts.now)) {
      bars = readBars(opts.priceCacheDb, ticker);
    } else {
      try {
        bars = await opts.fetchBars(ticker);
        writeBars(opts.priceCacheDb, ticker, bars, opts.now);
      } catch {
        continue;
      }
    }
    scored.push({ ticker, score: scoreMomentum121(bars) });
  }

  const eligible = scored.filter(
    (s): s is { ticker: string; score: MomentumScore } => {
      if (!s.score) return false;
      if (s.score.last_price < MIN_PRICE) return false;
      if (s.score.adv_usd_30d < MIN_ADV_USD) return false;
      return true;
    },
  );
  eligible.sort((a, b) => b.score.score - a.score.score);
  const cutoff = Math.max(1, Math.floor(eligible.length * TOP_DECILE_FRACTION));
  const passedSet = new Set(
    eligible
      .slice(0, cutoff)
      .filter((s) => s.score.score > 0)
      .map((s) => s.ticker),
  );

  const runId = insertScreenRun(opts.watchlistDb, {
    screen_name: screenName,
    universe: opts.universeLabel,
    ran_at: opts.now,
    tickers_scored: scored.length,
    tickers_passed: passedSet.size,
    duration_ms: Date.now() - started,
    parameters_json: JSON.stringify(parameters),
  });

  const insertTx = opts.watchlistDb.transaction(() => {
    for (const s of scored) {
      if (!s.score) continue;
      insertScore(opts.watchlistDb, {
        run_id: runId,
        ticker: s.ticker,
        screen_name: screenName,
        score: s.score.score,
        passed: passedSet.has(s.ticker),
        metadata: metadataFromScore(s.score),
        scored_at: opts.now,
      });
    }
  });
  insertTx();

  applyTransitionsForRun(opts.watchlistDb, runId, opts.now);

  if (opts.fundConfigs.length > 0 && passedSet.size > 0) {
    tagFundCompatibilityForTickers(
      opts.watchlistDb,
      opts.fundConfigs,
      [...passedSet],
      opts.now,
    );
  }

  const topTen = eligible.slice(0, 10).map((s) => ({
    ticker: s.ticker,
    score: s.score.score,
  }));

  return {
    run_id: runId,
    screen_name: screenName,
    universe: opts.universeLabel,
    tickers_scored: scored.length,
    tickers_passed: passedSet.size,
    duration_ms: Date.now() - started,
    top_ten: topTen,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test screening`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/screening.service.ts tests/screening.test.ts
git commit -m "feat(screening): runScreen orchestrator with transitions and fund tagging"
```

---

## Task 9 — MCP server `screener`

**Files:**
- Create: `src/mcp/screener.ts`
- Create: `tests/screener-mcp.test.ts`
- Modify: `src/agent.ts` (register `screener` in `buildMcpServers`)

- [ ] **Step 1: Write handler tests** `tests/screener-mcp.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  handleWatchlistQuery,
  handleWatchlistTrajectory,
  handleWatchlistTag,
} from "../src/mcp/screener.js";
import { openWatchlistDb } from "../src/services/watchlist.service.js";

describe("screener MCP handlers", () => {
  let wdb: ReturnType<typeof openWatchlistDb>;

  beforeEach(() => {
    wdb = openWatchlistDb(":memory:");
  });

  it("watchlist_query returns empty on new db", async () => {
    const res = await handleWatchlistQuery(wdb, { limit: 10 });
    expect(res.entries).toEqual([]);
  });

  it("watchlist_tag then watchlist_query surfaces the tagged ticker", async () => {
    await handleWatchlistTag(wdb, {
      ticker: "AAPL",
      status: "watching",
      reason: "manual test",
    });
    const res = await handleWatchlistQuery(wdb, { status: ["watching"] });
    expect(res.entries.map((e) => e.ticker)).toContain("AAPL");
  });

  it("watchlist_trajectory returns empty scores/transitions for unknown ticker", async () => {
    const res = await handleWatchlistTrajectory(wdb, { ticker: "UNKNOWN" });
    expect(res.scores).toEqual([]);
    expect(res.transitions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — verify failure**

Run: `pnpm test screener-mcp`
Expected: FAIL.

- [ ] **Step 3: Implement `src/mcp/screener.ts`** (stdio MCP, same pattern as `broker-local.ts`):

```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import yaml from "js-yaml";
import {
  openWatchlistDb,
  queryWatchlist,
  getTrajectory,
  tagManually,
} from "../services/watchlist.service.js";
import { openPriceCache } from "../services/price-cache.service.js";
import {
  getHistoricalDaily,
  getSp500Constituents,
} from "../services/market.service.js";
import { runScreen } from "../services/screening.service.js";
import {
  fundConfigSchema,
  screenNameSchema,
  watchlistStatusSchema,
  type FundConfig,
} from "../types.js";
import { FUNDS_DIR } from "../paths.js";
import { loadGlobalConfig } from "../config.js";

const watchlistQueryArgs = z.object({
  fund: z.string().optional(),
  status: z.array(watchlistStatusSchema).optional(),
  screen: screenNameSchema.optional(),
  ticker: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
});

export async function handleScreenRun(
  wdb: Database.Database,
  pcdb: Database.Database,
  args: { screen?: string; universe?: string },
  deps: {
    fetchBars: (ticker: string) => Promise<Awaited<ReturnType<typeof getHistoricalDaily>>>;
    universeTickers: () => Promise<string[]>;
    loadFundConfigs: () => Promise<FundConfig[]>;
    now: () => number;
  },
): Promise<{ summary: Awaited<ReturnType<typeof runScreen>> }> {
  const screen = screenNameSchema.parse(args.screen ?? "momentum-12-1");
  const universeLabel = args.universe ?? "sp500";
  const universe = await deps.universeTickers();
  const fundConfigs = await deps.loadFundConfigs();
  const summary = await runScreen({
    watchlistDb: wdb,
    priceCacheDb: pcdb,
    universe,
    universeLabel,
    fetchBars: deps.fetchBars,
    fundConfigs,
    now: deps.now(),
    screenName: screen,
  });
  return { summary };
}

export async function handleWatchlistQuery(
  wdb: Database.Database,
  args: z.infer<typeof watchlistQueryArgs>,
): Promise<{ entries: ReturnType<typeof queryWatchlist> }> {
  const parsed = watchlistQueryArgs.parse(args);
  const entries = queryWatchlist(wdb, {
    fund: parsed.fund,
    status: parsed.status,
    screen: parsed.screen,
    ticker: parsed.ticker,
    limit: parsed.limit,
  });
  return { entries };
}

export async function handleWatchlistTrajectory(
  wdb: Database.Database,
  args: { ticker: string },
) {
  return getTrajectory(wdb, args.ticker);
}

export async function handleWatchlistTag(
  wdb: Database.Database,
  args: { ticker: string; status: string; reason: string },
) {
  const status = watchlistStatusSchema.parse(args.status);
  tagManually(wdb, args.ticker, status, `manual:mcp:${args.reason}`, Date.now());
  return { ok: true };
}

async function loadAllFundConfigs(): Promise<FundConfig[]> {
  try {
    const dirs = readdirSync(FUNDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const out: FundConfig[] = [];
    for (const name of dirs) {
      try {
        const raw = await readFile(
          `${FUNDS_DIR}/${name}/fund_config.yaml`,
          "utf-8",
        );
        out.push(fundConfigSchema.parse(yaml.load(raw)));
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function main() {
  const wdb = openWatchlistDb();
  const pcdb = openPriceCache();
  const config = await loadGlobalConfig();
  const apiKey = config.market_data?.fmp_api_key ?? "";

  const server = new McpServer(
    { name: "screener", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "screen_run",
    "Run a screen across the workspace universe. Updates watchlist with new scores and transitions.",
    { screen: z.string().optional(), universe: z.string().optional() },
    async (args) => {
      const res = await handleScreenRun(wdb, pcdb, args, {
        fetchBars: (ticker) => getHistoricalDaily(ticker, 273, apiKey),
        universeTickers: () => getSp500Constituents(apiKey),
        loadFundConfigs: loadAllFundConfigs,
        now: () => Date.now(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.summary, null, 2) }],
      };
    },
  );

  server.tool(
    "watchlist_query",
    "Query current watchlist. Filter by fund, status, screen, or ticker.",
    {
      fund: z.string().optional(),
      status: z.array(watchlistStatusSchema).optional(),
      screen: screenNameSchema.optional(),
      ticker: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async (args) => {
      const res = await handleWatchlistQuery(
        wdb,
        args as z.infer<typeof watchlistQueryArgs>,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(res.entries, null, 2) }],
      };
    },
  );

  server.tool(
    "watchlist_trajectory",
    "Return full score history and status transitions for one ticker.",
    { ticker: z.string() },
    async (args) => {
      const res = await handleWatchlistTrajectory(wdb, args);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.tool(
    "watchlist_tag",
    "Manually override a ticker's watchlist status. Reason is recorded.",
    {
      ticker: z.string(),
      status: watchlistStatusSchema,
      reason: z.string(),
    },
    async (args) => {
      const res = await handleWatchlistTag(wdb, args);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[screener] fatal:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Register the server** in `src/agent.ts` (`buildMcpServers`). Follow the existing entry for `broker-local`:

```typescript
// Inside buildMcpServers, alongside existing entries:
screener: {
  type: "stdio",
  command: process.execPath,         // node
  args: [MCP_SERVERS.screener],      // path resolved in src/paths.ts
  env: { ...process.env },
},
```

- [ ] **Step 5: Run MCP handler tests**

Run: `pnpm test screener-mcp`
Expected: PASS.

- [ ] **Step 6: Run typecheck and build**

Run: `pnpm typecheck && pnpm build`
Expected: PASS. Build should produce `dist/mcp/screener.js`.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/screener.ts tests/screener-mcp.test.ts src/agent.ts src/paths.ts
git commit -m "feat(screening): screener MCP server with 4 tools"
```

---

## Task 10 — CLI commands under `fundx screen`

**Files:**
- Create: `src/commands/screen/run.tsx`
- Create: `src/commands/screen/watchlist.tsx`
- Create: `src/commands/screen/trajectory.tsx`
- Create: `src/commands/screen/tag.tsx`
- Modify: `src/services/fund.service.ts` (add `loadAllFundConfigs`)

- [ ] **Step 1: Add `loadAllFundConfigs`** to `src/services/fund.service.ts`:

```typescript
import { readdir } from "node:fs/promises";
import { FUNDS_DIR } from "../paths.js";

export async function loadAllFundConfigs(): Promise<FundConfig[]> {
  try {
    const entries = await readdir(FUNDS_DIR, { withFileTypes: true });
    const out: FundConfig[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        out.push(await loadFundConfig(e.name));
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch {
    return [];
  }
}
```

(Imports likely partially present; harmonise with what's already at the top of the file.)

- [ ] **Step 2: Implement `src/commands/screen/run.tsx`**:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { z } from "zod";
import { openWatchlistDb } from "../../services/watchlist.service.js";
import { openPriceCache } from "../../services/price-cache.service.js";
import {
  getHistoricalDaily,
  getSp500Constituents,
} from "../../services/market.service.js";
import { runScreen } from "../../services/screening.service.js";
import { loadGlobalConfig } from "../../config.js";
import { loadAllFundConfigs } from "../../services/fund.service.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";

export const description = "Run a screen across the configured universe.";
export const options = z.object({
  screen: z.string().default("momentum-12-1").describe("Screen name"),
  universe: z.string().default("sp500").describe("Universe label"),
});
type Props = { options: z.infer<typeof options> };

export default function ScreenRun({ options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const config = await loadGlobalConfig();
    const apiKey = config.market_data?.fmp_api_key ?? "";
    const wdb = openWatchlistDb();
    const pcdb = openPriceCache();
    const universe = await getSp500Constituents(apiKey);
    const fundConfigs = await loadAllFundConfigs();
    return runScreen({
      watchlistDb: wdb,
      priceCacheDb: pcdb,
      universe,
      universeLabel: opts.universe,
      fetchBars: (t) => getHistoricalDaily(t, 273, apiKey),
      fundConfigs,
      now: Date.now(),
      screenName: "momentum-12-1",
    });
  });

  if (isLoading) return <Text>Running screen {opts.screen}…</Text>;
  if (error) return <ErrorMessage message={error.message} />;
  if (!data) return null;

  return (
    <Box flexDirection="column">
      <SuccessMessage
        message={`Screen ${data.screen_name} complete in ${data.duration_ms}ms.`}
      />
      <Text>
        Universe: {data.universe} · Scored: {data.tickers_scored} · Passed:{" "}
        {data.tickers_passed}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Top 10 by score:</Text>
        {data.top_ten.map((t) => (
          <Text key={t.ticker}>
            {t.ticker.padEnd(6)} {(t.score * 100).toFixed(2)}%
          </Text>
        ))}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 3: Implement `src/commands/screen/watchlist.tsx`**:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { z } from "zod";
import {
  openWatchlistDb,
  queryWatchlist,
} from "../../services/watchlist.service.js";
import {
  watchlistStatusSchema,
  screenNameSchema,
} from "../../types.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";

export const description =
  "Show current watchlist (optionally filtered by fund or status).";
export const options = z.object({
  fund: z.string().optional(),
  status: z.array(watchlistStatusSchema).optional(),
  screen: screenNameSchema.optional(),
  limit: z.number().int().positive().max(200).default(50),
});
type Props = { options: z.infer<typeof options> };

export default function Watchlist({ options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const db = openWatchlistDb();
    return queryWatchlist(db, opts);
  });
  if (isLoading) return <Text>Loading watchlist…</Text>;
  if (error) return <ErrorMessage message={error.message} />;
  if (!data || data.length === 0) return <Text>No entries.</Text>;

  return (
    <Box flexDirection="column">
      <Text bold>
        {"TICKER".padEnd(8)} {"STATUS".padEnd(12)} {"SCREENS".padEnd(20)}{" "}
        {"PEAK".padEnd(10)} LAST EVAL
      </Text>
      {data.map((e) => (
        <Text key={e.ticker}>
          {e.ticker.padEnd(8)} {e.status.padEnd(12)}{" "}
          {e.current_screens.join(",").padEnd(20)}{" "}
          {(e.peak_score != null
            ? (e.peak_score * 100).toFixed(1) + "%"
            : "—"
          ).padEnd(10)}{" "}
          {new Date(e.last_evaluated_at).toISOString().slice(0, 10)}
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: Implement `src/commands/screen/trajectory.tsx`**:

```tsx
import React from "react";
import { Box, Text } from "ink";
import { z } from "zod";
import {
  openWatchlistDb,
  getTrajectory,
} from "../../services/watchlist.service.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";

export const description =
  "Show full score history and status transitions for one ticker.";
export const args = z.tuple([z.string().describe("ticker")]);
export const options = z.object({});
type Props = { args: z.infer<typeof args> };

export default function Trajectory({ args }: Props) {
  const [ticker] = args;
  const { data, isLoading, error } = useAsyncAction(async () => {
    const db = openWatchlistDb();
    return getTrajectory(db, ticker.toUpperCase());
  });
  if (isLoading) return <Text>Loading {ticker}…</Text>;
  if (error) return <ErrorMessage message={error.message} />;
  if (!data) return null;
  const entry = data.entry;
  return (
    <Box flexDirection="column">
      <Text bold>
        {data.ticker} {entry ? `(${entry.status})` : "(not on watchlist)"}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Transitions:</Text>
        {data.transitions.length === 0 && <Text>  — none —</Text>}
        {data.transitions.map((t) => (
          <Text key={t.id}>
            {new Date(t.transitioned_at).toISOString().slice(0, 10)}{"  "}
            {(t.from_status ?? "ø") + " → " + t.to_status}{"  "}
            {t.reason}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Scores (most recent 20):</Text>
        {data.scores.slice(-20).map((s, i) => (
          <Text key={i}>
            {new Date(s.scored_at).toISOString().slice(0, 10)}{"  "}
            {(s.score * 100).toFixed(2) + "%"}{"  "}
            {s.passed ? "PASS" : "fail"}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 5: Implement `src/commands/screen/tag.tsx`**:

```tsx
import React from "react";
import { Text } from "ink";
import { z } from "zod";
import {
  openWatchlistDb,
  tagManually,
} from "../../services/watchlist.service.js";
import { watchlistStatusSchema } from "../../types.js";
import { SuccessMessage } from "../../components/SuccessMessage.js";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { ErrorMessage } from "../../components/ErrorMessage.js";

export const description = "Manually set a ticker's watchlist status.";
export const args = z.tuple([
  z.string().describe("ticker"),
  watchlistStatusSchema.describe("new status"),
]);
export const options = z.object({
  reason: z.string().default("user override"),
});
type Props = {
  args: z.infer<typeof args>;
  options: z.infer<typeof options>;
};

export default function Tag({ args, options: opts }: Props) {
  const [ticker, status] = args;
  const { data, isLoading, error } = useAsyncAction(async () => {
    const db = openWatchlistDb();
    tagManually(
      db,
      ticker.toUpperCase(),
      status,
      `manual:cli:${opts.reason}`,
      Date.now(),
    );
    return { ticker, status };
  });
  if (isLoading) return <Text>Tagging {ticker}…</Text>;
  if (error) return <ErrorMessage message={error.message} />;
  if (!data) return null;
  return <SuccessMessage message={`${data.ticker} → ${data.status}`} />;
}
```

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Smoke-test each command's help flag**

Run:
```bash
pnpm dev -- screen run --help
pnpm dev -- screen watchlist --help
pnpm dev -- screen trajectory --help
pnpm dev -- screen tag --help
```
Expected: each prints help derived from its Zod schema, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/commands/screen src/services/fund.service.ts
git commit -m "feat(screening): cli commands run, watchlist, trajectory, tag"
```

---

## Task 11 — Daemon cron integration

**Files:**
- Modify: `src/services/daemon.service.ts`

- [ ] **Step 1: Locate `daemon.service.ts`** and find existing `cron.schedule(...)` calls. Add a new cron near them:

```typescript
import { openWatchlistDb } from "./watchlist.service.js";
import { openPriceCache } from "./price-cache.service.js";
import { runScreen } from "./screening.service.js";
import {
  getHistoricalDaily,
  getSp500Constituents,
} from "./market.service.js";
import { loadAllFundConfigs } from "./fund.service.js";

// 22:00 Mon–Fri local time (post US market close)
cron.schedule("0 22 * * 1-5", async () => {
  try {
    const config = await loadGlobalConfig();
    const apiKey = config.market_data?.fmp_api_key ?? "";
    if (!apiKey) {
      log("[screening] no FMP API key configured — skipping daily run");
      return;
    }
    const wdb = openWatchlistDb();
    const pcdb = openPriceCache();
    const universe = await getSp500Constituents(apiKey);
    const fundConfigs = await loadAllFundConfigs();
    const summary = await runScreen({
      watchlistDb: wdb,
      priceCacheDb: pcdb,
      universe,
      universeLabel: "sp500",
      fetchBars: (t) => getHistoricalDaily(t, 273, apiKey),
      fundConfigs,
      now: Date.now(),
      screenName: "momentum-12-1",
    });
    log(
      `[screening] run ${summary.run_id} ok: scored=${summary.tickers_scored} ` +
        `passed=${summary.tickers_passed} ms=${summary.duration_ms}`,
    );
  } catch (err) {
    log(`[screening] run failed: ${(err as Error).message}`);
  }
});
```

Harmonise with the existing `log` / `trackError` helpers used elsewhere in `daemon.service.ts` — do not introduce new logging helpers.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Start/stop daemon to check no import errors**

```bash
pnpm build
pnpm start -- start --foreground &
sleep 3
pnpm start -- stop
```
Expected: no trace mentioning `screening`, `watchlist.service`, or `price-cache.service` errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/daemon.service.ts
git commit -m "feat(screening): daemon cron at 22:00 weekdays"
```

---

## Task 12 — Session integration + new skill

**Files:**
- Modify: `src/skills.ts`

- [ ] **Step 1: Extend `session-init.md`** inside `FUND_RULES` in `src/skills.ts`. Locate the numbered sequence of orient steps and append:

```markdown
### Step 7 — Review watchlist

Before moving to analysis, consult the workspace watchlist for any candidates
surfaced by screens.

Call the `screener.watchlist_query` tool twice:

1. `{ fund: "<this fund's name>", status: ["candidate", "watching"], limit: 20 }` — fresh and established candidates eligible for this fund.
2. `{ fund: "<this fund's name>", status: ["fading"], limit: 20 }` — names that were previously active but are cooling off.

For each entry whose status changed since the timestamp of the prior
`session-handoff.md`, note the transition in the Session Contract under a
**Watchlist updates** heading (ticker, old → new status, reason). Fresh
candidates and any `fading → watching` re-entries become primary inputs to the
Analyze phase. If the watchlist is empty (common in a freshly initialised
workspace until the first screen run completes), record that and proceed
without it — the screen will populate on its next daily cycle.
```

- [ ] **Step 2: Add `opportunity-screening` to `BUILTIN_SKILLS`**. Append a new `Skill` object:

```typescript
{
  name: "Opportunity Screening",
  dirName: "opportunity-screening",
  description:
    "Use the screener MCP to find and prioritise new trade candidates from the watchlist. Triggered at Orient and on user request.",
  content: `---
name: opportunity-screening
description: Query the watchlist for eligible candidates, inspect their trajectory, and prioritise the top few for further analysis.
---

# Opportunity Screening

## When to Use
- Immediately after the Orient phase of a session, to see which tickers have been surfaced by screens for this fund.
- When the user asks in chat for opportunities, ideas, or "what's interesting right now".
- Mid-session, when considering new positions and the portfolio has open capacity.

## When NOT to Use
- Portfolio is already at its max-positions limit (per fund config).
- Market regime is clearly risk-off and this fund's objective is capital preservation — defer to runway-style defensive holds.
- Fund is in an active drawdown and the session is focused on damage control.
- The user is asking a question unrelated to new ideas — don't pre-empt.

## Technique
1. Query the screener MCP filtered by this fund for \`candidate\` and \`watching\` statuses first; then query \`fading\` separately to spot potential re-entries.
2. For any ticker that looks interesting, call \`screener.watchlist_trajectory({ ticker })\` and inspect:
   - How long it has been on the list (\`first_surfaced_at\`).
   - Whether scores trended up cleanly, plateaued, or whipsawed.
   - Whether it has previously transitioned to \`fading\` and recovered — re-entries after a pause are often stronger signals than first-time candidates.
3. Cross-reference each candidate against the current portfolio: does it introduce new sector exposure, or concentrate existing risk (per the fund's risk config)?
4. Select 3–5 candidates to prioritise. Hand them to the \`trade-evaluator\` sub-agent for thesis construction and risk review.

## Caveats
- **V1 scope:** only the 12-1 momentum screen populates the watchlist. Names without any screen tag should be treated as informational, not a recommendation.
- **Fund tagging:** funds whose \`universe\` is declared by sector/strategy/protocol (not explicit ETF/ticker lists) receive no automatic fund tags. The watchlist will still surface workspace-wide candidates; apply the fund's universe filter mentally.
- **Empty watchlist is normal** on a fresh install until the first daily run completes.

## Output Format
Produce a section titled **Opportunity shortlist** with one block per candidate:

\`\`\`
- **<TICKER>** — <status>, <days on list>
  - Current score: <x.x%> (trajectory: <rising | stable | recovered | fading-slightly>)
  - Why it fits this fund: <1 line mapping to objective>
  - Open question for analysis: <specific risk or catalyst to probe>
\`\`\`
`,
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/skills.ts
git commit -m "feat(screening): session-init step 7 + opportunity-screening skill"
```

---

## Task 13 — Propagate skill/rule updates to existing funds

**Files:** none (uses existing `fundx fund upgrade` command).

- [ ] **Step 1: Build**

Run: `pnpm build`
Expected: PASS.

- [ ] **Step 2: Upgrade all funds**

Run: `pnpm start -- fund upgrade --all`
Expected: every fund's `.claude/skills/opportunity-screening/SKILL.md` and `.claude/rules/session-init.md` are updated. Verify with:

```bash
ls ~/.fundx/funds/*/.claude/skills/opportunity-screening/SKILL.md
grep -l "Step 7" ~/.fundx/funds/*/.claude/rules/session-init.md
```

Both listings should be non-empty.

- [ ] **Step 3: No commit** — step only regenerates user workspace files.

---

## Task 14 — End-to-end verification

**Files:** none (manual acceptance).

- [ ] **Step 1: Trigger a one-off screen run**

```bash
pnpm start -- screen run
```
Expected: Summary line with `tickers_scored` ≈ 500, `tickers_passed` ≈ 50, duration in a few seconds (cache-primed).

- [ ] **Step 2: Inspect watchlist**

```bash
pnpm start -- screen watchlist --limit 20
```
Expected: tabular output. Every row should have `candidate` status on the first run.

- [ ] **Step 3: Pick a passing ticker; view trajectory**

```bash
pnpm start -- screen trajectory <ticker>
```
Expected: one transition (`ø → candidate`), one score row.

- [ ] **Step 4: Re-run on the same day**

```bash
pnpm start -- screen run
```
Expected: fast (price cache serves all tickers). Tickers that pass again transition `candidate → watching`.

- [ ] **Step 5: Manual tag**

```bash
pnpm start -- screen tag AAPL rejected --reason "testing override"
pnpm start -- screen trajectory AAPL
```
Expected: status is `rejected`; last transition reason is `manual:cli:testing override`.

- [ ] **Step 6: Chat integration**

```bash
pnpm start
```
In the REPL with a fund selected, ask: "¿Qué oportunidades hay en el watchlist para este fondo?"
Expected: agent calls `watchlist_query`, returns a ranked shortlist with trajectory for 1–3 priority names.

- [ ] **Step 7: Autonomous session**

```bash
pnpm start -- session run --fund <name>
```
Expected: the session handoff includes a **Watchlist updates** section referencing any transitions since the prior handoff.

- [ ] **Step 8: Record findings**

Create `research/screening-v1-acceptance.md`:

```markdown
# Screening V1 — Acceptance Notes

Date: YYYY-MM-DD

## What I ran
(list commands)

## Observations
(numbers, timings, surprises)

## Open follow-ups
(things to fix or extend in Phase 2.2)
```

Commit:

```bash
git add research/screening-v1-acceptance.md
git commit -m "docs(screening): v1 end-to-end acceptance notes"
```

---

## Self-review checklist

Run this pass before executing the plan; fix any misses inline.

- [ ] Every spec section maps to at least one task above.
- [ ] All 6 state transitions (ø→candidate, candidate→watching, watching→fading, fading→rejected, fading→watching, *→stale) are covered by tests in `tests/watchlist-transitions.test.ts`.
- [ ] No task contains "TBD", "TODO" (other than the single labelled SP500-list placeholder), "fill in later", or placeholder prose.
- [ ] Function signatures used in later tasks match their earlier definitions:
  - `scoreMomentum121(bars: DailyBar[]) → MomentumScore | null`
  - `runScreen(opts: RunScreenOptions) → Promise<RunScreenSummary>`
  - `applyTransitionsForRun(db, runId, now) → void`
  - `tagManually(db, ticker, status, reason, at) → void`
  - `getTrajectory(db, ticker) → Trajectory`
  - `queryWatchlist(db, query) → WatchlistEntry[]`
- [ ] Database field names are consistent across schema DDL, Zod schemas, service functions, MCP handlers, CLI commands (snake_case everywhere: `last_evaluated_at`, `first_surfaced_at`, `scored_at`).
- [ ] Spec divergence (fund `universe` is a discriminated union, not a flat list) is explicit in the plan header and handled in Task 7 + the skill.
