# Universe System Follow-up Sprints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining cleanup and small-feature items from the per-fund universe code reviews across three logical sprints: maintenance cleanup, observability + safety, and convenience features.

**Architecture:** No architectural changes. Sprint 1 is mechanical refactoring + hygiene. Sprint 2 adds a dry-run path to an existing tool, a gated real-API test, and a dashboard surface. Sprint 3 adds a bulk CLI variant and a proactive refresh cron.

**Tech Stack:** TypeScript, Vitest, Ink/Pastel, node-cron, SQLite, FMP (for the gated E2E test).

**Prior context:**
- Feature spec: `docs/superpowers/specs/2026-04-15-per-fund-universe-design.md`
- Feature plan: `docs/superpowers/plans/2026-04-15-per-fund-universe.md`
- Current state on `main`: 570 tests passing, typecheck clean, build clean. 4 user funds migrated.

**Sprint boundaries are soft commits** — each task is independently mergeable. No task blocks tasks in a later sprint.

---

# SPRINT 1 — Maintenance cleanup

## Task 1: Split broker-local.ts — extract universe handlers

**Why:** `src/mcp/broker-local.ts` is ~838 lines with ~270 lines of universe handlers (`handleCheckUniverse`, `handleListUniverse`, `handleBuyGate`, `handleUpdateUniverse`, types, helpers). Mirrors the existing `broker-local-notify.ts` split pattern. Beneficiary: legibility + testability.

**Files:**
- Create: `src/mcp/broker-local-universe.ts`
- Modify: `src/mcp/broker-local.ts` (remove universe handlers, import from new file)
- Modify: `tests/broker-local-universe.test.ts`, `tests/broker-local-gating.test.ts`, `tests/broker-local-update-universe.test.ts` — update import paths

- [ ] **Step 1.1: Create `src/mcp/broker-local-universe.ts` with the 4 handlers**

Extract lines 159-430 of `src/mcp/broker-local.ts` (the universe handler block starting with `export interface CheckUniverseInput`) into the new file. Exact exports to move:

- Types: `CheckUniverseInput`, `CheckUniverseDeps`, `CheckUniverseOutput`, `ListUniverseInput`, `ListUniverseDeps`, `ListUniverseOutput`, `BuyGateInput`, `BuyGateDeps`, `BuyGateResult`, `UpdateUniverseInput`, `UpdateUniverseDeps`, `UpdateUniverseOutput`
- Functions: `handleCheckUniverse`, `handleListUniverse`, `handleBuyGate`, `handleUpdateUniverse`, `summarizeUniverse` (helper)
- Constant: `MIN_OOU_REASON_LENGTH`

Required imports in the new file:
```ts
import { isInUniverse } from "../services/universe.service.js";
import { universeSchema, fundConfigSchema } from "../types.js";
import type { Universe, UniversePreset, UniverseResolution, FundConfig, FmpScreenerFilters } from "../types.js";
```

No `zod` import needed (the handlers don't use `z.*` — the zod schemas are at the `server.tool(...)` registration layer in `broker-local.ts`).

- [ ] **Step 1.2: Replace the extracted block in `broker-local.ts` with imports**

At the location where the types/handlers used to live, replace with:

```ts
import {
  handleCheckUniverse,
  handleListUniverse,
  handleBuyGate,
  handleUpdateUniverse,
} from "./broker-local-universe.js";
```

And remove the now-unused imports that only the extracted handlers used (e.g., `isInUniverse` is used by `handleBuyGate` via a dep — `broker-local.ts` directly uses `checkSectorExclusion` and `resolveUniverse`; verify which imports become dead after the extraction and remove them).

- [ ] **Step 1.3: Update test import paths**

Current test files import from `../src/mcp/broker-local.js`. Change to `../src/mcp/broker-local-universe.js`:

```ts
// tests/broker-local-universe.test.ts
import { handleCheckUniverse, handleListUniverse } from "../src/mcp/broker-local-universe.js";

// tests/broker-local-gating.test.ts
import { handleBuyGate } from "../src/mcp/broker-local-universe.js";

// tests/broker-local-update-universe.test.ts
import { handleUpdateUniverse } from "../src/mcp/broker-local-universe.js";
```

Do NOT move `tests/broker-local-notify.test.ts` — that's a separate file.

- [ ] **Step 1.4: Update tsup.config.ts to include the new MCP file**

`tsup.config.ts` has an entry block listing MCP entries:
```ts
entry: [
  "src/mcp/broker-local.ts",
  "src/mcp/telegram-notify.ts",
  "src/mcp/sws.ts",
  "src/mcp/screener.ts",
],
```

`broker-local-universe.ts` is NOT a standalone stdio MCP entry — it's imported by `broker-local.ts`. It will be bundled as a dep automatically. Do NOT add it to the entry list.

- [ ] **Step 1.5: Verify**

```bash
pnpm test -- --run
pnpm typecheck
pnpm lint
pnpm build
```

Expected: 570 tests still pass (same count — no test changes in substance). Typecheck + build clean.

- [ ] **Step 1.6: Commit**

```bash
git add src/mcp/broker-local.ts src/mcp/broker-local-universe.ts tests/broker-local-universe.test.ts tests/broker-local-gating.test.ts tests/broker-local-update-universe.test.ts
git commit -m "refactor(broker): extract universe handlers to broker-local-universe.ts"
```

---

## Task 2: Make `resolutions` required in `RunScreenOptions`

**Why:** All three callers (`src/mcp/screener.ts`, `src/services/daemon.service.ts`, `src/commands/screen/run.tsx`) already pass `resolutions`. Making it required prevents a future caller from silently skipping fund-compatibility tagging. Trivial change.

**Files:**
- Modify: `src/services/screening.service.ts` — remove `?` from `resolutions` field
- Modify: `tests/screener-mcp.test.ts` — ensure all test paths pass resolutions (most already do)

- [ ] **Step 2.1: Update `RunScreenOptions`**

`src/services/screening.service.ts` — find the interface:

```ts
export interface RunScreenOptions {
  watchlistDb: Database.Database;
  priceCacheDb: Database.Database;
  universe: string[];
  universeLabel: string;
  fetchBars: (ticker: string) => Promise<DailyBar[]>;
  fundConfigs: FundConfig[];
  resolutions?: Map<string, UniverseResolution>;  // ← was optional
  now: number;
  screenName?: ScreenName;
  getSector?: (ticker: string) => Promise<string | null>;
}
```

Remove the `?`:

```ts
  resolutions: Map<string, UniverseResolution>;
```

In `runScreen` body, the call-site already handles empty maps:

```ts
if (opts.resolutions && opts.resolutions.size > 0 && passedSet.size > 0) {
```

Simplify to drop the null-check:

```ts
if (opts.resolutions.size > 0 && passedSet.size > 0) {
```

- [ ] **Step 2.2: Verify caller signatures still compile**

```bash
pnpm typecheck
```

Expected: PASS. All three callers already construct a Map. If typecheck fails in a test file, that test needs a Map added:

`tests/screener-mcp.test.ts` — find any call to `runScreen(...)` or `handleScreenRun(...)` missing `resolutions`. Either add:
```ts
resolutions: new Map(),
```

or, for tests that exercise the tagging path, a realistic Map with the fund's resolution.

- [ ] **Step 2.3: Run tests**

```bash
pnpm test -- --run
```

Expected: 570 PASS. If any fail due to missing `resolutions`, fix them to pass `new Map()` (empty map is valid — no tagging happens).

- [ ] **Step 2.4: Commit**

```bash
git add src/services/screening.service.ts tests/
git commit -m "refactor(screening): make resolutions required in RunScreenOptions"
```

---

## Task 3: MCP fund-config cache uses mtime invalidation

**Why:** Today `cachedFundConfig` in `src/mcp/broker-local.ts` is set once per MCP subprocess and only reset by `update_universe` (from within the same process). If the user edits `fund_config.yaml` externally while a session is active, the MCP server serves stale config until restart. Cheap fix: stat the file and invalidate when mtime advances.

**Files:**
- Modify: `src/mcp/broker-local.ts` — extend `loadFundConfigForMcp` with mtime check
- Test: `tests/broker-local-config-cache.test.ts` (new)

- [ ] **Step 3.1: Write failing test**

Create `tests/broker-local-config-cache.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { loadFundConfigForMcp, _resetFundConfigCacheForTests } from "../src/mcp/broker-local.js";

let tmp: string;

const fullConfig = {
  fund: { name: "t", display_name: "T", description: "", created: "2026-01-01", status: "active" },
  capital: { initial: 100_000, currency: "USD" },
  objective: { type: "growth", target_multiple: 2 },
  risk: { profile: "moderate", max_drawdown_pct: 15, max_position_pct: 25, max_leverage: 1, stop_loss_pct: 8, max_daily_loss_pct: 5, correlation_limit: 0.8, custom_rules: [] },
  universe: { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] },
  schedule: { timezone: "UTC", trading_days: ["MON","TUE","WED","THU","FRI"], sessions: {}, special_sessions: [] },
  broker: { mode: "paper" },
  claude: { model: null, personality: "", decision_framework: "" },
  telegram: {},
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fundx-cfg-cache-"));
  process.env.FUND_DIR = tmp;
  _resetFundConfigCacheForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.FUND_DIR;
});

describe("loadFundConfigForMcp — mtime invalidation", () => {
  it("caches reads within a single mtime window", async () => {
    writeFileSync(join(tmp, "fund_config.yaml"), yaml.dump(fullConfig));
    const a = await loadFundConfigForMcp();
    const b = await loadFundConfigForMcp();
    // Object identity — same cached instance
    expect(a).toBe(b);
  });

  it("re-reads after file mtime advances", async () => {
    const p = join(tmp, "fund_config.yaml");
    writeFileSync(p, yaml.dump(fullConfig));
    const a = await loadFundConfigForMcp();
    // Bump mtime forward by 5 seconds
    const newTime = new Date(Date.now() + 5000);
    utimesSync(p, newTime, newTime);
    // Rewrite with a different fund name to confirm the re-read happens
    writeFileSync(p, yaml.dump({ ...fullConfig, fund: { ...fullConfig.fund, display_name: "T2" } }));
    utimesSync(p, newTime, newTime);
    const b = await loadFundConfigForMcp();
    expect(b.fund.display_name).toBe("T2");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
pnpm test tests/broker-local-config-cache.test.ts -- --run
```

Expected: FAIL — `_resetFundConfigCacheForTests` is not exported; second test fails because the current cache is set-once.

- [ ] **Step 3.3: Update `loadFundConfigForMcp` + export test helper in `broker-local.ts`**

Find the existing cache block (around line 127 of `src/mcp/broker-local.ts`) and replace:

```ts
// ── Fund config (cached) ─────────────────────────────────────
// Cache scope: per-MCP-subprocess. The broker-local MCP is spawned fresh
// at each session start, so this cache is never stale across sessions.
// Invalidates on:
//   - update_universe write (sets cachedFundConfig = null)
//   - fund_config.yaml mtime advance (external edits)
interface CachedFundConfig {
  value: FundConfig;
  mtimeMs: number;
}
let cachedFundConfig: CachedFundConfig | null = null;

async function loadFundConfigForMcp(): Promise<FundConfig> {
  const yamlPath = join(FUND_DIR, "fund_config.yaml");
  const { stat } = await import("node:fs/promises");
  const stats = await stat(yamlPath);
  if (cachedFundConfig && cachedFundConfig.mtimeMs === stats.mtimeMs) {
    return cachedFundConfig.value;
  }
  const raw = await readFile(yamlPath, "utf-8");
  const parsed = yaml.load(raw);
  const validated = fundConfigSchema.parse(parsed);
  cachedFundConfig = { value: validated, mtimeMs: stats.mtimeMs };
  return validated;
}

/** For tests only. */
export function _resetFundConfigCacheForTests(): void {
  cachedFundConfig = null;
}

// Export for tests
export { loadFundConfigForMcp };
```

If `loadFundConfigForMcp` is already not exported, add the export. The `update_universe` handler flow (which sets `cachedFundConfig = null` in the `writeConfigYaml` dep) needs updating — change the assignment to match the new shape:

Find the `writeConfigYaml` dep inside the `update_universe` tool registration (~line 750):
```ts
cachedFundConfig = null;  // invalidate module cache
```
Leave this line as-is. Setting the whole cache object to `null` works for the `if (cachedFundConfig && ...)` check.

- [ ] **Step 3.4: Run test to verify it passes**

```bash
pnpm test tests/broker-local-config-cache.test.ts -- --run
```

Expected: 2 tests PASS.

- [ ] **Step 3.5: Run full suite**

```bash
pnpm test -- --run
pnpm typecheck
```

Expected: 572 passing (570 + 2 new), typecheck clean.

- [ ] **Step 3.6: Commit**

```bash
git add src/mcp/broker-local.ts tests/broker-local-config-cache.test.ts
git commit -m "fix(broker): invalidate fund_config cache when file mtime advances"
```

---

## Task 4: README update — document universe system

**Why:** The project `README.md` doesn't mention the per-fund universe system. This is user-facing documentation that anyone on GitHub or new contributors will hit first.

**Files:**
- Modify: `README.md`

- [ ] **Step 4.1: Read current README structure**

```bash
wc -l README.md
```

Identify the section where universe content should land. Likely under "Architecture" or "Configuration" — scan the file, decide based on the existing sectioning.

- [ ] **Step 4.2: Add a "Per-Fund Universe" section**

Insert after the "Configuration" section (or next to it — exact placement depends on README layout). Content:

````markdown
## Per-Fund Universe

Each fund has a `universe` block in its `fund_config.yaml` that defines which tickers the fund trades. The universe drives screening, gates trade execution, and is exposed to the AI agent as part of its session context.

### Two modes

**Preset (canonical index membership):**
```yaml
universe:
  preset: sp500          # sp500 | nasdaq100 | dow30
  include_tickers: [TSM] # always-in, bypasses universe filters
  exclude_tickers: []    # hard-block these tickers
  exclude_sectors: []    # hard-block these FMP canonical sectors
```

**Filters (custom FMP screener query):**
```yaml
universe:
  filters:
    market_cap_min: 10_000_000_000
    exchange: [NYSE, NASDAQ]
    country: US
    sector: [Technology, Healthcare]
    is_actively_trading: true
    limit: 500
  include_tickers: []
  exclude_tickers: []
  exclude_sectors: []
```

See `src/constants/fmp-enums.ts` for the full list of valid values per field.

### Gating semantics

Buys go through a gate in the `place_order` tool:
- **Excluded ticker or sector** → hard-rejected with `UNIVERSE_EXCLUDED`
- **Out of universe (not in base, not in includes)** → soft-gated. Pass `out_of_universe_reason` (≥20 chars, time-sensitive thesis) to `place_order` to proceed. The trade is logged with `out_of_universe=true`.
- **Sells** are never gated — you can always exit a position regardless of universe.

### Resolution and caching

Universe resolution calls FMP and writes a 24h-TTL cache at `~/.fundx/funds/<name>/state/universe.json`. Invalidated on config change (`config_hash` mismatch) or forced refresh. Fallback chain on FMP outage: cached → stale cache (hash must match) → static S&P 500 fallback list.

### Tools (CLI)

```bash
fundx fund show-universe <name>      # inspect resolved universe
fundx fund refresh-universe <name>   # force re-resolution
fundx fund upgrade --name <name>     # migrate legacy universe schema + regenerate CLAUDE.md/skills
```

### Tools (MCP, for the AI agent)

- `check_universe({ticker})` — can this fund trade this ticker?
- `list_universe({sector?, limit?, verbose?})` — what's in the universe? `verbose: true` exposes current include/exclude lists (needed to modify them safely).
- `update_universe({mode?, include_tickers?, exclude_tickers?, exclude_sectors?})` — mutate the universe. Validates with Zod, writes atomically, invalidates cache, regenerates CLAUDE.md, appends to `state/universe_audit.log`. REPLACE semantics on the list fields.

### Migration from the old schema

Funds created before the universe system used `universe: { allowed, forbidden }`. Running `fundx fund upgrade --name <name>` migrates to the new schema with `.bak` backup preserved.
````

- [ ] **Step 4.3: Verify README renders clean**

Open `README.md` and visually scan the new section. Check it integrates with existing headings (no duplicate `##` clashes, consistent tone).

- [ ] **Step 4.4: Commit**

```bash
git add README.md
git commit -m "docs(readme): document per-fund universe system"
```

---

# SPRINT 2 — Observability + safety

## Task 5: E2E FMP test gated by env var

**Why:** All universe tests mock FMP. A single gated test that hits the real endpoints for `sp500`, `nasdaq100`, and `dow30` catches regressions in FMP's API shape (e.g., field renames, format changes) that mocks miss by construction. Gate by `FUNDX_FMP_E2E_KEY` so CI only runs it when configured.

**Files:**
- Test: `tests/e2e-fmp.test.ts` (new)

- [ ] **Step 5.1: Create gated E2E test**

Create `tests/e2e-fmp.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  getSp500ConstituentsRaw,
  getNasdaq100ConstituentsRaw,
  getDow30ConstituentsRaw,
  getScreenerResultsRaw,
  getCompanyProfile,
  _resetProfileCacheForTests,
} from "../src/services/market.service.js";

const FMP_KEY = process.env.FUNDX_FMP_E2E_KEY;
const describeIfKey = FMP_KEY ? describe : describe.skip;

describeIfKey("FMP E2E (gated by FUNDX_FMP_E2E_KEY)", () => {
  it("sp500 constituent endpoint returns a plausible list", async () => {
    const tickers = await getSp500ConstituentsRaw(FMP_KEY!);
    expect(tickers.length).toBeGreaterThanOrEqual(450);
    expect(tickers.length).toBeLessThanOrEqual(550);
    expect(tickers).toContain("AAPL");
    expect(tickers).toContain("MSFT");
  });

  it("nasdaq100 constituent endpoint returns a plausible list", async () => {
    const tickers = await getNasdaq100ConstituentsRaw(FMP_KEY!);
    expect(tickers.length).toBeGreaterThanOrEqual(80);
    expect(tickers.length).toBeLessThanOrEqual(110);
    expect(tickers).toContain("AAPL");
    expect(tickers).toContain("NVDA");
  });

  it("dow30 constituent endpoint returns 30 tickers", async () => {
    const tickers = await getDow30ConstituentsRaw(FMP_KEY!);
    expect(tickers.length).toBeGreaterThanOrEqual(28);
    expect(tickers.length).toBeLessThanOrEqual(32);
  });

  it("company-screener responds to basic US large-cap filter", async () => {
    const results = await getScreenerResultsRaw(
      {
        market_cap_min: 10_000_000_000,
        exchange: ["NYSE", "NASDAQ"],
        country: "US",
        is_actively_trading: true,
        limit: 50,
      },
      FMP_KEY!,
    );
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.symbol).toMatch(/^[A-Z][A-Z0-9.-]*$/);
      if (r.marketCap !== undefined) expect(r.marketCap).toBeGreaterThanOrEqual(10_000_000_000);
    }
  });

  it("profile endpoint returns sector for AAPL", async () => {
    _resetProfileCacheForTests();
    const profile = await getCompanyProfile("AAPL", FMP_KEY!);
    expect(profile).not.toBeNull();
    expect(profile!.sector).toBe("Technology");
  });
});
```

- [ ] **Step 5.2: Verify the test skips without the env var**

```bash
pnpm test tests/e2e-fmp.test.ts -- --run
```

Expected: all 5 tests marked "skipped" (the `describe.skip` branch).

- [ ] **Step 5.3: Verify the test runs with the env var (manual, skip if no key)**

If you have a real FMP key, run:
```bash
FUNDX_FMP_E2E_KEY=<your-key> pnpm test tests/e2e-fmp.test.ts -- --run
```

If no key is available locally, skip this step and note in the commit message that the gated path was not smoke-tested.

- [ ] **Step 5.4: Verify full suite (should be same 570 + 5 skipped)**

```bash
pnpm test -- --run
```

Expected: 570 passing, 1 (news.integration) + 5 (e2e-fmp) skipped = 6 skipped total.

- [ ] **Step 5.5: Commit**

```bash
git add tests/e2e-fmp.test.ts
git commit -m "test: gated E2E test against real FMP endpoints (FUNDX_FMP_E2E_KEY)"
```

---

## Task 6: `update_universe --dry-run` param

**Why:** The agent may want to preview a universe change (diff, new count, warnings) before committing. Today `update_universe` always persists. Add a `dry_run` flag — when true, run validation + resolvability check but skip persist, invalidate, and regen. Return the same output shape so the agent can inspect.

**Files:**
- Modify: `src/mcp/broker-local-universe.ts` (post-Task-1 location) — extend `UpdateUniverseInput` and `handleUpdateUniverse`
- Modify: `src/mcp/broker-local.ts` — extend tool registration schema
- Test: `tests/broker-local-update-universe.test.ts` — add dry-run tests

- [ ] **Step 6.1: Extend input shape and handler**

In `src/mcp/broker-local-universe.ts` (the new location after Task 1; if Task 1 hasn't run yet, edit `src/mcp/broker-local.ts` instead):

```ts
export interface UpdateUniverseInput {
  mode?: { preset?: UniversePreset; filters?: FmpScreenerFilters };
  include_tickers?: string[];
  exclude_tickers?: string[];
  exclude_sectors?: string[];
  dry_run?: boolean;  // NEW
}

export interface UpdateUniverseOutput {
  ok: true;
  dry_run: boolean;  // NEW — echoes input for clarity
  before: { source: string; include_count: number; exclude_tickers_count: number; exclude_sectors_count: number };
  after: { source: string; include_count: number; exclude_tickers_count: number; exclude_sectors_count: number };
  resolved: { count: number; resolved_from: "fmp" | "stale_cache" | "static_fallback" };
  warnings: string[];
  note: string;
}
```

Update `handleUpdateUniverse`:

```ts
export async function handleUpdateUniverse(
  input: UpdateUniverseInput,
  deps: UpdateUniverseDeps,
): Promise<UpdateUniverseOutput> {
  if (input.mode?.preset && input.mode?.filters) {
    throw new Error("mode.preset and mode.filters are mutually exclusive — pass exactly one.");
  }
  if (input.mode && !input.mode.preset && !input.mode.filters) {
    throw new Error("mode must include either preset or filters (got empty object).");
  }

  const current = await deps.loadCurrentConfig();
  const before = summarizeUniverse(current.universe);

  // Build patched universe
  let next: Universe = { ...current.universe };
  if (input.mode?.preset) {
    next = {
      preset: input.mode.preset,
      include_tickers: next.include_tickers,
      exclude_tickers: next.exclude_tickers,
      exclude_sectors: next.exclude_sectors,
    };
  } else if (input.mode?.filters) {
    next = {
      filters: input.mode.filters,
      include_tickers: next.include_tickers,
      exclude_tickers: next.exclude_tickers,
      exclude_sectors: next.exclude_sectors,
    };
  }
  if (input.include_tickers !== undefined) next.include_tickers = input.include_tickers;
  if (input.exclude_tickers !== undefined) next.exclude_tickers = input.exclude_tickers;
  if (input.exclude_sectors !== undefined) next.exclude_sectors = input.exclude_sectors as Universe["exclude_sectors"];

  const validated = universeSchema.parse(next);
  const newConfig = fundConfigSchema.parse({ ...current, universe: validated });

  const isDryRun = input.dry_run === true;

  // Always resolve against the proposed config (needed to compute count/warnings)
  // For dry-run, we pass force:true to avoid leaving a dirty cache
  const resolution = await deps.resolveNewUniverse(newConfig);

  const warnings: string[] = [];
  if (resolution.count === 0) {
    warnings.push("Resolved universe is empty (0 tickers). The fund cannot trade anything until the universe is broadened.");
  }
  if (resolution.resolved_from === "static_fallback") {
    warnings.push("FMP resolution fell through to static fallback. Likely your FMP API key cannot hit the requested preset/filter endpoint.");
  }

  if (!isDryRun) {
    await deps.writeConfigYaml(newConfig);
    await deps.invalidateUniverseCache();
    await deps.regenerateClaudeMd(newConfig);
    await deps.auditLog({
      before,
      after: summarizeUniverse(newConfig.universe),
      timestamp: new Date().toISOString(),
    });
  }

  const after = summarizeUniverse(newConfig.universe);
  const note = isDryRun
    ? "DRY RUN: no changes persisted. Re-run without dry_run to commit."
    : "Universe updated. Next tool call resolves against the new config (cache invalidated). CLAUDE.md regenerated. If this fund has user-authored YAML comments or custom key ordering in fund_config.yaml, they are lost on write.";

  return { ok: true, dry_run: isDryRun, before, after, resolved: { count: resolution.count, resolved_from: resolution.resolved_from }, warnings, note };
}
```

**Important:** for dry-run, `resolveNewUniverse` is still called. If the current resolver implementation writes to the cache file, that's OK — the cache file will be overwritten next time `update_universe` runs (non-dry) or a scheduled resolve happens. If we wanted strict "no side effects at all", we'd need a separate `resolveUniverseInMemory` path. Skipped for now — the cache file being "primed" with a preview resolution is a benign side effect.

Actually, on reflection: the resolver ALWAYS writes cache on successful FMP resolution. For dry-run, this would write the preview resolution to disk, which then looks committed to next readers. Fix by making the dry-run resolve pass a flag that inhibits caching — but the resolver doesn't expose that flag today.

Workaround: during dry-run, pass a different fund-name-like identifier to the resolver so it writes to a throwaway cache path. Dirty.

Cleaner: add a `skipCacheWrite?: boolean` option to `resolveUniverse`. But that changes the public API.

Best: for dry-run, call `resolveUniverse` with `force: true` and then immediately `invalidateUniverseCache` to restore prior state. This is transactional-looking but the old cache is lost. Still dirty.

**Final decision:** for dry-run, pass `force: true` and accept that the cache now holds the preview resolution. If the agent calls `check_universe` right after a dry-run, it sees the preview. Document this in the `note` field:

```ts
const note = isDryRun
  ? "DRY RUN: no changes to fund_config.yaml or CLAUDE.md. The resolver cache now holds the preview resolution (any check_universe / list_universe call uses it until next update_universe or refresh)."
  : "...";
```

This is honest about the side effect. Agent can refresh via `fund refresh-universe` if they want to undo.

- [ ] **Step 6.2: Update the MCP tool registration**

In `src/mcp/broker-local.ts`, extend the zod input schema:

```ts
server.tool(
  "update_universe",
  "Mutate this fund's universe. Validates with Zod, writes fund_config.yaml atomically, invalidates resolver cache, and regenerates CLAUDE.md. Use this instead of editing fund_config.yaml directly. Pass dry_run: true to preview the diff + resolved count + warnings WITHOUT committing.",
  {
    mode: z.object({
      preset: z.enum(["sp500", "nasdaq100", "dow30"]).optional(),
      filters: fmpScreenerFiltersSchema.optional(),
    }).optional(),
    include_tickers: z.array(z.string()).optional(),
    exclude_tickers: z.array(z.string()).optional(),
    exclude_sectors: z.array(z.string()).optional(),
    dry_run: z.boolean().optional().describe("Preview the change without persisting. Returns the same output shape with dry_run=true. Note: the resolver cache may be updated with the preview resolution — run `refresh-universe` to restore if needed."),
  },
  async (args) => { /* existing wiring */ },
);
```

- [ ] **Step 6.3: Add tests**

Append to `tests/broker-local-update-universe.test.ts`:

```ts
describe("handleUpdateUniverse — dry_run", () => {
  it("does NOT call writeConfigYaml / invalidateUniverseCache / regenerateClaudeMd / auditLog on dry_run", async () => {
    const cfg = makeConfig();
    const { deps, writes, invalidations, regens, audits } = baseDeps(cfg);
    const r = await handleUpdateUniverse(
      { mode: { preset: "nasdaq100" }, dry_run: true },
      deps,
    );
    expect(r.ok).toBe(true);
    expect(r.dry_run).toBe(true);
    expect(writes.length).toBe(0);
    expect(invalidations.length).toBe(0);
    expect(regens.length).toBe(0);
    expect(audits.length).toBe(0);
  });

  it("still validates schema on dry_run", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    await expect(
      handleUpdateUniverse({ exclude_sectors: ["NotASector"], dry_run: true }, deps),
    ).rejects.toThrow();
  });

  it("still resolves on dry_run and returns count + warnings", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    deps.resolveNewUniverse = async () => ({
      resolved_at: 1, config_hash: "h", resolved_from: "fmp",
      source: { kind: "preset", preset: "nasdaq100" },
      base_tickers: ["AAPL"], final_tickers: ["AAPL"], include_applied: [],
      exclude_tickers_applied: [], exclude_sectors_applied: [],
      exclude_tickers_config: [], exclude_sectors_config: [],
      count: 1,
    });
    const r = await handleUpdateUniverse(
      { mode: { preset: "nasdaq100" }, dry_run: true },
      deps,
    );
    expect(r.resolved.count).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("dry_run note differs from normal note", async () => {
    const cfg = makeConfig();
    const { deps } = baseDeps(cfg);
    const a = await handleUpdateUniverse({ mode: { preset: "nasdaq100" }, dry_run: true }, deps);
    const b = await handleUpdateUniverse({ mode: { preset: "nasdaq100" } }, deps);
    expect(a.note).toContain("DRY RUN");
    expect(b.note).not.toContain("DRY RUN");
  });
});
```

- [ ] **Step 6.4: Update skill to mention dry_run**

In `src/skills.ts`, find the "Modifying the universe" section in the `risk-assessment` skill. After the existing examples, add:

```markdown

### Preview before committing (dry_run)

When the user asks for a drastic change (switching preset, excluding many sectors), preview first:
```
update_universe({ mode: { preset: "nasdaq100" }, dry_run: true })
→ returns { dry_run: true, before, after, resolved: { count, resolved_from }, warnings }
```

If `warnings` is empty and `resolved.count` looks right, re-run WITHOUT `dry_run` to commit. Otherwise report the preview to the user and let them decide.
```

Add an assertion in `tests/skills.test.ts`:
```ts
it("risk-assessment skill mentions dry_run preview workflow", () => {
  const skill = BUILTIN_SKILLS.find((s) => s.dirName === "risk-assessment");
  expect(skill!.content).toContain("dry_run");
});
```

- [ ] **Step 6.5: Verify**

```bash
pnpm test -- --run
pnpm typecheck
pnpm lint
```

Expected: 578 passing (570 + 4 dry-run + 1 skill + 3 from prior minor coverage if any). Typecheck clean.

- [ ] **Step 6.6: Commit**

```bash
git add src/mcp/broker-local.ts src/mcp/broker-local-universe.ts src/skills.ts tests/broker-local-update-universe.test.ts tests/skills.test.ts
git commit -m "feat(universe): update_universe dry_run flag previews changes without persisting"
```

After commit, remind to run `fundx fund upgrade --all` to propagate the updated risk-assessment skill.

---

## Task 7: Universe badge in dashboard `FundCard`

**Why:** The main dashboard (`fundx` with no args) shows fund P&L, holdings, next session — but not which universe the fund is tracking. A compact badge like `SP500 · 487 · 3h` per fund gives at-a-glance visibility into universe state + freshness.

**Files:**
- Modify: `src/services/status.service.ts` — extend `FundExtras` with universe summary
- Modify: `src/components/FundCard.tsx` — render the badge
- Test: `tests/status.test.ts` or equivalent — cover the new field

- [ ] **Step 7.1: Extend `FundExtras` with universe fields**

In `src/services/status.service.ts`, find `FundExtras` (around line 121):

```ts
export interface FundExtras {
  sparklineValues: number[];
  topHoldings: Array<{ symbol: string; weightPct: number }>;
  objectiveType: string;
  objectiveLabel: string;
  nextSession: string | null;
  lastSessionAgo: string | null;
  tradesInLastSession: number;
  universe: UniverseBadge | null;  // NEW
}

export interface UniverseBadge {
  source: string;          // "SP500" | "NASDAQ100" | "DOW30" | "FILTERS"
  count: number;
  ageHours: number;
  staleness: "fresh" | "stale" | "fallback";
}
```

Find where `fundExtras` is populated (around line 250). Add a helper:

```ts
import { readCachedUniverse } from "./universe.service.js";

async function buildUniverseBadge(fundName: string): Promise<UniverseBadge | null> {
  const res = await readCachedUniverse(fundName);
  if (!res) return null;
  const source = res.source.kind === "preset"
    ? res.source.preset.toUpperCase()
    : "FILTERS";
  const ageHours = Math.floor((Date.now() - res.resolved_at) / 3_600_000);
  const staleness: UniverseBadge["staleness"] =
    res.resolved_from === "fmp" ? "fresh"
    : res.resolved_from === "stale_cache" ? "stale"
    : "fallback";
  return { source, count: res.count, ageHours, staleness };
}
```

Inside the loop that populates `fundExtras`:

```ts
fundExtras.set(name, {
  sparklineValues,
  topHoldings,
  objectiveType,
  objectiveLabel,
  nextSession,
  lastSessionAgo,
  tradesInLastSession,
  universe: await buildUniverseBadge(name),  // NEW
});
```

- [ ] **Step 7.2: Render in `FundCard.tsx`**

`src/components/FundCard.tsx` — add the badge to Line 1 (the header with status + name + objective). Make it compact, colored by freshness:

```tsx
{extras.universe && (
  <Text dimColor>
    <Text color={
      extras.universe.staleness === "fresh" ? "green"
      : extras.universe.staleness === "stale" ? "yellow"
      : "red"
    }>●</Text>
    {" "}{extras.universe.source} · {extras.universe.count} · {extras.universe.ageHours}h
  </Text>
)}
```

Place it on a new line below the objective (Line 1.5), or replace Line 3 (holdings) with a two-column row: holdings + universe badge. Recommended: put it on a dedicated line below the objective so it's visible without crowding:

```tsx
{/* Line 1.5: universe badge */}
{extras.universe && (
  <Text dimColor>
    <Text color={extras.universe.staleness === "fresh" ? "green" : extras.universe.staleness === "stale" ? "yellow" : "red"}>●</Text>
    {" "}
    Universe: {extras.universe.source} · {extras.universe.count} tickers · {extras.universe.ageHours}h ago
  </Text>
)}
```

- [ ] **Step 7.3: Write test**

Find an existing test for the dashboard data aggregation. If there isn't one for `FundExtras.universe`, add to `tests/status.test.ts` or create it:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import the specific helper — adjust if it's internal
import { buildUniverseBadge } from "../src/services/status.service.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fundx-badge-"));
  process.env.FUNDX_HOME = tmp;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.FUNDX_HOME;
});

describe("buildUniverseBadge", () => {
  it("returns null when no cache exists", async () => {
    mkdirSync(join(tmp, "funds", "testfund", "state"), { recursive: true });
    expect(await buildUniverseBadge("testfund")).toBeNull();
  });

  it("builds a preset badge from a fresh cache", async () => {
    const stateDir = join(tmp, "funds", "testfund", "state");
    mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    const resolution = {
      resolved_at: now - 2 * 3_600_000,
      config_hash: "h",
      resolved_from: "fmp",
      source: { kind: "preset", preset: "sp500" },
      base_tickers: [],
      final_tickers: [],
      include_applied: [],
      exclude_tickers_applied: [],
      exclude_sectors_applied: [],
      exclude_tickers_config: [],
      exclude_sectors_config: [],
      count: 503,
    };
    writeFileSync(join(stateDir, "universe.json"), JSON.stringify(resolution));
    const badge = await buildUniverseBadge("testfund");
    expect(badge).toEqual({
      source: "SP500",
      count: 503,
      ageHours: 2,
      staleness: "fresh",
    });
  });

  it("marks stale cache badge as yellow", async () => {
    const stateDir = join(tmp, "funds", "testfund", "state");
    mkdirSync(stateDir, { recursive: true });
    const now = Date.now();
    const resolution = {
      resolved_at: now, config_hash: "h", resolved_from: "stale_cache",
      source: { kind: "preset", preset: "nasdaq100" },
      base_tickers: [], final_tickers: [], include_applied: [],
      exclude_tickers_applied: [], exclude_sectors_applied: [],
      exclude_tickers_config: [], exclude_sectors_config: [],
      count: 100,
    };
    writeFileSync(join(stateDir, "universe.json"), JSON.stringify(resolution));
    const badge = await buildUniverseBadge("testfund");
    expect(badge?.staleness).toBe("stale");
    expect(badge?.source).toBe("NASDAQ100");
  });
});
```

Export `buildUniverseBadge` from `status.service.ts` for testability (even if it's small).

- [ ] **Step 7.4: Verify**

```bash
pnpm test -- --run
pnpm typecheck
pnpm build
```

Expected: 581 passing (578 + 3 new badge tests).

- [ ] **Step 7.5: Smoke-test the dashboard**

```bash
pnpm dev
```

Confirm the main dashboard shows "Universe: SP500 · 503 tickers · Xh ago" under each fund card. Quit with Ctrl+C.

- [ ] **Step 7.6: Commit**

```bash
git add src/services/status.service.ts src/components/FundCard.tsx tests/
git commit -m "feat(dashboard): universe badge on fund cards (source · count · age · freshness)"
```

---

# SPRINT 3 — Convenience

## Task 8: `fundx fund refresh-universe --all`

**Why:** After an FMP outage or a batch config change, refreshing every fund's cache one-by-one is tedious. `--all` flag iterates all active funds.

**Files:**
- Modify: `src/commands/fund/refresh-universe.tsx` — add `--all` option

- [ ] **Step 8.1: Extend options schema**

`src/commands/fund/refresh-universe.tsx` — change `args` to make the positional optional, and add an `options.all` boolean:

```tsx
import React from "react";
import zod from "zod";
import { argument, option } from "pastel";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { useAsyncAction } from "../../hooks/useAsyncAction.js";
import { loadFundConfig, loadAllFundConfigs } from "../../services/fund.service.js";
import { loadGlobalConfig } from "../../config.js";
import { resolveUniverse } from "../../services/universe.service.js";
import type { UniverseResolution } from "../../types.js";

export const description = "Force re-resolution of a fund's universe (bypass cache)";

export const args = zod.tuple([
  zod.string().optional().describe(argument({ name: "name", description: "Fund name (omit with --all)" })),
]);

export const options = zod.object({
  all: zod.boolean().default(false).describe(option({ description: "Refresh all active funds", alias: "a" })),
});

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

interface RefreshResult {
  fundName: string;
  resolution: UniverseResolution;
}

export default function RefreshUniverse({ args: [name], options: opts }: Props) {
  const { data, isLoading, error } = useAsyncAction(async () => {
    const gcfg = await loadGlobalConfig();
    const apiKey = gcfg.market_data?.fmp_api_key ?? "";
    if (opts.all) {
      const configs = await loadAllFundConfigs();
      const active = configs.filter((c) => c.fund.status === "active");
      if (active.length === 0) throw new Error("No active funds found.");
      const results: RefreshResult[] = [];
      for (const cfg of active) {
        const resolution = await resolveUniverse(cfg.fund.name, cfg.universe, apiKey, { force: true });
        results.push({ fundName: cfg.fund.name, resolution });
      }
      return results;
    }
    if (!name) {
      throw new Error("Provide a fund name or use --all (-a).");
    }
    const cfg = await loadFundConfig(name);
    const resolution = await resolveUniverse(name, cfg.universe, apiKey, { force: true });
    return [{ fundName: name, resolution }];
  }, [name, opts.all]);

  if (isLoading) return <Spinner label="Refreshing universe..." />;
  if (error) return <Text color="red">Error: {error.message}</Text>;
  if (!data) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      {data.map((r) => (
        <Text key={r.fundName} color="green">
          ✓ {r.fundName}: {r.resolution.count} tickers ({r.resolution.resolved_from})
        </Text>
      ))}
      {data.length > 1 && (
        <Text dimColor>{data.length} funds refreshed.</Text>
      )}
    </Box>
  );
}
```

- [ ] **Step 8.2: Smoke test**

Build and run:

```bash
pnpm build
npx tsx src/index.tsx fund refresh-universe --help
npx tsx src/index.tsx fund refresh-universe --all
```

Expected: help shows `--all` option. `--all` iterates each fund and prints one ✓ line per fund.

Also verify the positional path still works:
```bash
npx tsx src/index.tsx fund refresh-universe Growth
```

Expected: single ✓ line.

- [ ] **Step 8.3: Run tests**

```bash
pnpm test -- --run
pnpm typecheck
```

Expected: 581 pass (no test changes — smoke-tested manually).

- [ ] **Step 8.4: Commit**

```bash
git add src/commands/fund/refresh-universe.tsx
git commit -m "feat(cli): fund refresh-universe --all for bulk refresh"
```

---

## Task 9: Daemon proactive universe cache refresh

**Why:** Today the universe cache self-heals via TTL (24h). If a fund's pre-market session fires just after cache expiry, it pays the FMP latency to re-resolve. Preload at 04:00 AM (well before pre-market) so every session starts with warm cache.

**Files:**
- Modify: `src/services/daemon.service.ts` — add a 04:00 cron

- [ ] **Step 9.1: Add cron block**

In `src/services/daemon.service.ts`, find the existing cron blocks (look for `cron.schedule`). Add a new one near the daily screening block (around line 932):

```ts
// Universe cache refresh — 04:00 UTC daily (well before pre-market sessions)
cron.schedule("0 4 * * *", async () => {
  try {
    const config = await loadGlobalConfig();
    const apiKey = config.market_data?.fmp_api_key ?? "";
    if (!apiKey) {
      await log("[universe] no FMP API key configured — skipping daily refresh");
      return;
    }
    const { resolveUniverse } = await import("./universe.service.js");
    const fundConfigs = await loadAllFundConfigs();
    const activeConfigs = fundConfigs.filter((c) => c.fund.status === "active");
    if (activeConfigs.length === 0) {
      await log("[universe] no active funds — skipping daily refresh");
      return;
    }
    let refreshed = 0;
    let failed = 0;
    for (const cfg of activeConfigs) {
      try {
        const resolution = await resolveUniverse(cfg.fund.name, cfg.universe, apiKey, { force: true });
        await log(
          `[universe] ${cfg.fund.name} refreshed: count=${resolution.count} ` +
            `source=${resolution.source.kind === "preset" ? resolution.source.preset : "filters"} ` +
            `from=${resolution.resolved_from}`,
        );
        refreshed++;
      } catch (err) {
        await log(`[universe] ${cfg.fund.name} refresh failed: ${err instanceof Error ? err.message : err}`);
        failed++;
      }
    }
    await log(`[universe] daily refresh complete: ${refreshed} ok, ${failed} failed`);
  } catch (err) {
    trackError("_universe", "daily-refresh", err);
  }
});
```

Important: use dynamic `import("./universe.service.js")` if the static import would cause a circular (daemon → universe service → market service is likely fine, so a static import at the top of the file is preferable — verify no cycle and use static).

- [ ] **Step 9.2: Manual smoke test**

The daemon runs as a long-lived process. A full end-to-end test would require waiting for 04:00 UTC or mocking cron. Skip unit test; instead verify the cron registration doesn't throw at daemon start:

```bash
pnpm build
FUNDX_HOME=$(mktemp -d) node dist/index.js start 2>&1 | head -20
# Wait 2 seconds
sleep 2
FUNDX_HOME=$FUNDX_HOME node dist/index.js stop 2>&1 | head -5
```

Expected: daemon starts without throwing; stop cleanly.

If you can't spawn a real daemon in this environment, read the new cron block carefully and confirm it matches the style of the other crons (922, 934, etc.) — imports present, error handling symmetric.

- [ ] **Step 9.3: Run test suite**

```bash
pnpm test -- --run
pnpm typecheck
```

Expected: 581 pass.

- [ ] **Step 9.4: Commit**

```bash
git add src/services/daemon.service.ts
git commit -m "feat(daemon): proactive universe cache refresh at 04:00 UTC daily"
```

---

# Final verification

- [ ] **Run full suite**

```bash
pnpm test -- --run
pnpm typecheck
pnpm lint
pnpm build
```

Expected: all green. ~581 tests passing.

- [ ] **Manual dashboard check**

```bash
pnpm dev
```

Confirm each fund card shows the universe badge with color-coded freshness. Quit with Ctrl+C.

- [ ] **Propagate updated skill to existing funds** (only needed after Task 6)

```bash
npx tsx src/index.tsx fund upgrade --all
```

Verifies the `dry_run` section lands in each fund's `risk-assessment/SKILL.md`.

---

# Notes for the executing engineer

- **Task 1 (broker-local split) and Task 6 (dry-run) interact.** If Task 1 ran first (expected), Task 6 edits `broker-local-universe.ts`. If Task 6 runs first, edit `broker-local.ts` — then Task 1 moves it alongside the other handlers.
- **Task 3 (mtime cache) touches `loadFundConfigForMcp`**, which is called from many tool handlers. Verify after Task 3 that `check_universe`, `list_universe`, `place_order`, and `update_universe` all still work in an end-to-end smoke (write a config, hit each tool, mutate the config externally, hit again, observe new value picked up).
- **Task 7 (dashboard badge) requires reading the cache file.** If a fund has never been resolved, `readCachedUniverse` returns null and the badge is omitted. Verify this produces no render glitches (empty space, broken layout).
- **Task 9 (daemon cron) at 04:00 UTC** — if your local timezone is far from UTC, the refresh window may land during live trading for some exchanges. This is intentional: we're syncing before US pre-market (04:00 UTC = 00:00 EDT / 23:00 PDT). Adjust only if the user has a strong reason.
- **YAGNI:** Do not add a `refresh-universe --dry-run` variant. Do not add per-fund audit log rotation. Do not add cache warming for past-dated screens.
