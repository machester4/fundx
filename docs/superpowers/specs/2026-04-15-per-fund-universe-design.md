# Per-Fund Universe System — Design Spec

**Date:** 2026-04-15
**Status:** Approved, ready for implementation planning
**Scope:** Replace hardcoded S&P 500 screening universe with a per-fund universe system that drives screening, gates trades, and informs the agent's decision space.

---

## Problem

Today every fund's screener runs against a single hardcoded S&P 500 list fetched by `getSp500Constituents()`. The `universe` field in `fund_config.yaml` (`{ allowed, forbidden }` with asset entries) is ignored by the screener and not enforced anywhere. Funds with different mandates (e.g., a Nasdaq-tech fund vs. a dividend-income fund) see identical screening output and can buy anything.

We want each fund to have a real universe that: (1) filters the screen to tickers the fund actually cares about, (2) gates trade execution so the fund stays within its mandate, and (3) is exposed to the LLM so it reasons inside the mandate rather than around it.

FMP's `/stable/company-screener` endpoint provides the flexibility needed (filters by market cap, sector, exchange, beta, volume, dividend, etc.), complementing the existing `/sp500_constituent`, `/nasdaq_constituent`, and `/dowjones_constituent` endpoints for canonical index memberships.

---

## Design Decisions

1. **Scope:** Universe drives screening, gates trade execution, and is exposed to the LLM via metadata + MCP tools.
2. **Schema:** Discriminated union of `preset` (canonical index) XOR `filters` (FMP screener passthrough), always-available `include_tickers` / `exclude_tickers` / `exclude_sectors`.
3. **Gating model:** Two-tier — `exclude_*` is a hard block; out-of-universe (not in resolved base, not in includes) is a soft gate requiring `out_of_universe_reason` in the trade call.
4. **Resolution:** Cached per fund at `~/.fundx/funds/<name>/state/universe.json` with 24h TTL and config-hash invalidation. Fallback chain: FMP → stale cache → static `SP500_FALLBACK`.
5. **LLM exposure:** Session prompt carries only metadata (count, preset/filter summary, exclusions, freshness). Two MCP tools (`check_universe`, `list_universe`) let the agent query on demand.

---

## 1. Schema (`src/types.ts`)

```ts
// Canonical index presets (curated memberships, not filter-reproducible)
export const universePresetSchema = z.enum([
  "sp500",
  "nasdaq100",
  "dow30",
]);
export type UniversePreset = z.infer<typeof universePresetSchema>;

// FMP-compatible enums — validated at config parse time
export const fmpExchangeSchema = z.enum([
  // Starter plan subset (safe default)
  "NASDAQ", "NYSE", "AMEX", "CBOE", "OTC", "PNK", "CNQ",
  // Premium plan (validated against fmp_plan if set)
  "NEO", "TSXV", "TSX", "LSE",
]);

export const fmpSectorSchema = z.enum([
  "Basic Materials",
  "Communication Services",
  "Consumer Cyclical",
  "Consumer Defensive",
  "Energy",
  "Financial Services",
  "Healthcare",
  "Industrials",
  "Real Estate",
  "Technology",
  "Utilities",
]);

// Full 1:1 mapping of FMP /stable/company-screener parameters
export const fmpScreenerFiltersSchema = z
  .object({
    market_cap_min: z.number().nonnegative().optional(),
    market_cap_max: z.number().positive().optional(),
    price_min: z.number().nonnegative().optional(),
    price_max: z.number().positive().optional(),
    beta_min: z.number().optional(),
    beta_max: z.number().optional(),
    dividend_min: z.number().nonnegative().optional(),
    dividend_max: z.number().nonnegative().optional(),
    volume_min: z.number().nonnegative().optional(),
    volume_max: z.number().positive().optional(),
    sector: z.array(fmpSectorSchema).optional(),
    industry: z.string().optional(),
    exchange: z.array(fmpExchangeSchema).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    is_etf: z.boolean().optional(),
    is_fund: z.boolean().optional(),
    is_actively_trading: z.boolean().default(true),
    include_all_share_classes: z.boolean().optional(),
    limit: z.number().int().min(1).max(10_000).default(500),
  })
  .refine((f) => !(f.market_cap_min && f.market_cap_max) || f.market_cap_min < f.market_cap_max, {
    message: "market_cap_min must be < market_cap_max",
  })
  .refine((f) => !(f.price_min && f.price_max) || f.price_min < f.price_max, {
    message: "price_min must be < price_max",
  })
  .refine((f) => !(f.beta_min != null && f.beta_max != null) || f.beta_min < f.beta_max, {
    message: "beta_min must be < beta_max",
  })
  .refine((f) => !(f.dividend_min != null && f.dividend_max != null) || f.dividend_min < f.dividend_max, {
    message: "dividend_min must be < dividend_max",
  })
  .refine((f) => !(f.volume_min != null && f.volume_max != null) || f.volume_min < f.volume_max, {
    message: "volume_min must be < volume_max",
  });

// Discriminated union: EXACTLY one of preset or filters
export const universeSchema = z
  .object({
    preset: universePresetSchema.optional(),
    filters: fmpScreenerFiltersSchema.optional(),
    include_tickers: z.array(z.string().toUpperCase()).default([]),
    exclude_tickers: z.array(z.string().toUpperCase()).default([]),
    exclude_sectors: z.array(fmpSectorSchema).default([]),
  })
  .refine(
    (u) => (u.preset != null) !== (u.filters != null),
    { message: "universe must have exactly one of `preset` or `filters`" },
  );
```

**Example config:**

```yaml
universe:
  preset: nasdaq100
  include_tickers: [TSM, ASML]
  exclude_tickers: [TSLA]
  exclude_sectors: [Energy]
```

or

```yaml
universe:
  filters:
    market_cap_min: 10_000_000_000
    exchange: [NYSE, NASDAQ]
    country: US
    sector: [Technology, Healthcare]
    is_actively_trading: true
    limit: 500
  exclude_tickers: [TSLA]
```

---

## 2. Resolution Service (`src/services/universe.service.ts`)

Pure business logic module. Resolves a `Universe` config to a concrete ticker list, with caching and fallback.

### Public API

```ts
export interface UniverseResolution {
  resolved_at: number;            // unix ms
  config_hash: string;            // sha1 of serialized universe block
  resolved_from: "fmp" | "stale_cache" | "static_fallback";
  source: { kind: "preset"; preset: UniversePreset } | { kind: "filters" };
  base_tickers: string[];         // from FMP (pre-include/exclude)
  final_tickers: string[];        // after include/exclude applied
  include_applied: string[];
  exclude_tickers_applied: string[];
  exclude_sectors_applied: string[];
  count: number;
}

export async function resolveUniverse(
  fundName: string,
  universeConfig: Universe,
  apiKey: string,
  opts?: { force?: boolean; now?: number },
): Promise<UniverseResolution>;

export async function readCachedUniverse(
  fundName: string,
): Promise<UniverseResolution | null>;

export function hashUniverseConfig(universe: Universe): string;

export function isInUniverse(
  resolution: UniverseResolution,
  ticker: string,
): {
  in_universe: boolean;
  base_match: boolean;
  include_override: boolean;
  exclude_hard_block: boolean;
  exclude_reason?: "ticker" | "sector";
};
```

### Caching

- **Path:** `~/.fundx/funds/<name>/state/universe.json`
- **TTL:** 24h (configurable via `universe.cache_ttl_hours` in global config, default 24)
- **Invalidation triggers:** TTL expired, `config_hash` mismatch, or `opts.force = true`
- **Atomic writes:** use `writeJsonAtomic` from `state.ts`

### Fallback chain

1. Call FMP. On success → `resolved_from: "fmp"`, write cache, return.
2. On FMP failure → attempt to read existing cache regardless of TTL. If present → `resolved_from: "stale_cache"`, return (do not re-write).
3. On no cache available → use `SP500_FALLBACK` from `src/constants/sp500.ts`, apply include/exclude. `resolved_from: "static_fallback"`. Log warning. Do not write cache (to avoid freezing a fallback into a valid resolution).

### Preset → FMP endpoint mapping

| Preset        | Endpoint                        | Existing? |
|---------------|---------------------------------|-----------|
| `sp500`       | `/sp500_constituent`            | yes (`getSp500Constituents`) |
| `nasdaq100`   | `/nasdaq_constituent`           | new (`getNasdaq100Constituents`) |
| `dow30`       | `/dowjones_constituent`         | new (`getDow30Constituents`) |

Filter mode: `/stable/company-screener` via new `getScreenerResults(filters, apiKey)`. Request builder translates snake_case config to camelCase query params. Response shape: `Array<{ symbol: string; companyName: string; marketCap: number; sector: string; industry: string; exchange: string; ... }>`.

### Exchange plan gating (optional)

Global config `~/.fundx/config.yaml` may declare `market_data.fmp_plan: "starter" | "premium"`. If present, the resolver validates that requested exchanges are available on that plan before calling FMP. If absent, the full combined enum is accepted; FMP errors are caught and re-emitted with guidance ("exchange X requires premium plan").

### Exclusion semantics

- `exclude_tickers`: case-insensitive exact match against resolved symbols
- `exclude_sectors`: matched against the `sector` field in screener/profile responses.
  - **Filter mode:** exclusion is applied during resolution since the screener response already includes `sector`.
  - **Preset mode:** the constituent endpoints return only symbols, no sector. Exclusion is enforced at trade-time via the broker gate (see §4), not at resolution, to avoid N profile lookups per resolution. The session prompt notes this clearly so the agent knows sector exclusions are enforced but not reflected in `list_universe` output for preset mode.
  - A new `getCompanyProfile(ticker, apiKey)` helper is added to `market.service.ts` (calls FMP `/profile/<ticker>`), with a lightweight in-memory LRU cache (size 500, TTL 24h) shared across the process. This same helper serves `check_universe` and the broker gate.
- `include_tickers`: always added to `final_tickers` regardless of base match; never subject to exclusions.

---

## 3. MCP Tools (`src/mcp/broker-local.ts`)

Two new tools exposed on the existing broker-local MCP server (it already has DB access and runs per-fund, so it's the natural host).

### `check_universe`

```ts
input: { ticker: string }
output: {
  in_universe: boolean,
  base_match: boolean,
  include_override: boolean,
  exclude_hard_block: boolean,
  exclude_reason?: "ticker" | "sector",
  requires_justification: boolean,
  resolved_at: number,
  resolved_from: "fmp" | "stale_cache" | "static_fallback",
}
```

Calls `resolveUniverse()` (hits cache) + `isInUniverse()`. For preset mode + `exclude_sectors`, fetches the profile for the ticker and matches sector on the fly.

### `list_universe`

```ts
input: { sector?: string, limit?: number }
output: {
  tickers: string[],
  total: number,
  resolved_at: number,
  resolved_from: string,
}
```

Returns `final_tickers` optionally filtered by sector (requires profile lookups for preset mode — use cached profiles where possible).

Both tools should be fast (<1s) in the common case. Neither triggers resolution if cache is fresh.

---

## 4. Gating — Three Enforcement Points

### 4.1 Screening (`src/services/screening.service.ts`, `src/mcp/screener.ts`, `src/services/daemon.service.ts`)

`runScreen` signature stays the same (accepts `universe: string[]`), but callers change:

- `src/mcp/screener.ts` (`screen_run` tool): call `resolveUniverse(fundName, cfg.universe, apiKey)` and pass `resolution.final_tickers` + `resolution.resolved_from` as label (e.g., `"nasdaq100 (fmp)"`).
- `src/commands/screen/run.tsx`: same change. The `--universe` flag deprecated (reads from fund config now). If provided, error: "universe is now defined per-fund in fund_config.yaml".
- `src/services/daemon.service.ts` (nightly screen run): iterate funds, resolve each fund's universe, run screen per fund.

The existing `universeLabel` column in `screen_runs` table now stores a human-readable descriptor (e.g., `preset:sp500`, `filters:sector=Technology|mcap>10B`) derived from the config.

### 4.2 Trade execution (`src/mcp/broker-local.ts` → `execute_trade`)

Before placing the trade:

```
resolution = resolveUniverse(fund, cfg.universe, apiKey)   // cache hit
status = isInUniverse(resolution, ticker)
if cfg.universe.exclude_tickers includes ticker OR (profile.sector matches cfg.universe.exclude_sectors):
  reject with error UNIVERSE_EXCLUDED { ticker, reason: "ticker" | "sector" }
if not status.in_universe AND !params.out_of_universe_reason:
  reject with error UNIVERSE_SOFT_GATE { ticker, hint: "pass out_of_universe_reason with a clear thesis" }
if not status.in_universe AND params.out_of_universe_reason:
  execute trade, persist trade_journal row with out_of_universe=true and reason=params.out_of_universe_reason
```

`execute_trade` input schema gains `out_of_universe_reason?: string` (optional, min 20 chars when present).

`trade_journal` schema gains `out_of_universe: boolean` (default false) and `out_of_universe_reason: string | null`.

### 4.3 `trade-evaluator` subagent (`src/subagent.ts`)

Agent prompt gains universe metadata + soft-gate flag. When evaluating a proposed trade, the evaluator sees whether it's out-of-universe and, if so, the justification. The evaluator prompt adds:

> If `out_of_universe=true`, hold the thesis to a higher bar. Out-of-universe trades should have material, time-sensitive rationale that the fund's normal universe cannot capture. Weak or vague justifications warrant rejection.

---

## 5. Prompt Integration

### 5.1 Per-fund CLAUDE.md (`src/template.ts`)

New section generated from `universe` block:

```markdown
## Your Universe

You focus on <N> tickers defined as <preset name | filter summary>.
<Excluded tickers line if any>
<Excluded sectors line if any>
<Always-included tickers line if any>

Before proposing a trade, validate the ticker with the `check_universe` tool.
To explore what's available, use `list_universe` (optionally filtered by sector).

Trading a ticker outside your universe is allowed but requires `out_of_universe_reason`
in the `execute_trade` call — a material, time-sensitive thesis. Excluded tickers
and sectors are hard blocks and cannot be overridden.
```

### 5.2 Session prompt (`src/services/session.service.ts`)

Dynamic block in the session context (inserted after portfolio, before market assessment):

```xml
<fund_universe>
  count: 487
  source: preset:nasdaq100
  resolved_from: fmp
  resolved_at: 2026-04-15T08:00:00Z
  exclusions:
    tickers: [TSLA]
    sectors: [Energy]
  always_included: [TSM, ASML]
  freshness_warning: <present only if resolved_from != "fmp">
</fund_universe>
```

Keep this block ~50-80 tokens regardless of universe size.

### 5.3 Skills

No new skill. Extend existing `risk-assessment` skill with a short section on out-of-universe trades referencing `check_universe` and `out_of_universe_reason`. Skills remain in `src/skills.ts`; test added to `tests/skills.test.ts`.

---

## 6. CLI

New commands under `src/commands/fund/`:

- `fundx fund show-universe <name>` — prints resolved universe: source (preset/filters), count, age, first 20 tickers, exclusion summary
- `fundx fund refresh-universe <name>` — forces re-resolution (passes `force: true` to `resolveUniverse`)

Updated:

- `fundx fund create` wizard (`src/services/fund.service.ts` or its Ink component) adds a universe selection step:
  ```
  ? Universe type:
    S&P 500 (preset)
    Nasdaq 100 (preset)
    Dow 30 (preset)
    US Large Cap template ($10B+) — creates editable filters block
    US Mid Cap template ($2B-$10B) — creates editable filters block
    Custom filters (advanced)
  ```
  The "template" options are onboarding convenience — they write an explicit `filters` block to the generated `fund_config.yaml`, not a preset keyword. The user can edit freely afterwards.

Deprecated:

- `fundx screen run --universe <label>` flag no longer accepted; errors with migration note.

---

## 7. Migration

`fund_config.yaml` files written before this change have:
```yaml
universe:
  allowed: [...]    # asset entries with type/tickers/sectors
  forbidden: [...]
```

Migration runs in `fundx fund upgrade --name <fund>` (or `--all`). Detection: presence of `allowed` or `forbidden` keys in `universe` block.

Mapping:

| Old                              | New                    |
|----------------------------------|------------------------|
| `allowed[].tickers` (flattened)  | `include_tickers`      |
| `forbidden[].tickers` (flattened)| `exclude_tickers`      |
| `forbidden[].sectors` (flattened)| `exclude_sectors`      |
| `allowed[].sectors`              | logged as warning; not auto-translated (old schema's semantics were ambiguous — "allowed sectors" could mean "restrict to" or "include") |
| `strategies`, `protocols`        | dropped with warning (never enforced) |

Default for the new required field: `preset: sp500` (most common, matches old behavior). The user is notified in the upgrade output and encouraged to review.

Migration writes the new block atomically and leaves a backup at `fund_config.yaml.bak`.

---

## 8. Testing

### Unit tests (`tests/universe.service.test.ts`)

- Preset resolution: sp500, nasdaq100, dow30 each call correct endpoint (fetch mocked)
- Filters mode: builds correct query string from all 18 FMP parameters
- Cache: fresh hit (no FMP call), TTL expired (refetch), config_hash change (refetch)
- Fallback chain: FMP 500 → stale cache, FMP 500 + no cache → SP500_FALLBACK
- Include/exclude merge: overrides, idempotence, case normalization
- Zod refinements: min<max pairs, exactly-one of preset|filters, enum validation

### Unit tests (`tests/universe-tools.test.ts`)

- `check_universe` returns correct flags for: in-base, include-override, ticker-excluded, sector-excluded (preset mode with profile lookup mocked), not-in-universe-no-override
- `list_universe` returns final_tickers, supports sector filter

### Integration tests

- `tests/broker-local.test.ts`: `execute_trade` rejects `UNIVERSE_EXCLUDED` for exclude_tickers and exclude_sectors; rejects `UNIVERSE_SOFT_GATE` without reason; accepts with reason and persists journal row with `out_of_universe=true`
- `tests/screening.test.ts`: updated — screen uses resolved universe per fund, not global sp500
- `tests/fund-upgrade.test.ts`: old schema migrates to new schema with correct mapping, backup file written

### Fixtures

- FMP screener response fixture (`tests/fixtures/fmp-screener.json`)
- FMP constituent response fixtures for each preset
- Legacy fund_config.yaml with old universe schema

---

## 9. Files Touched (summary)

| File                                         | Change  |
|----------------------------------------------|---------|
| `src/types.ts`                               | replace `universeSchema`, add enums, add screener filter schema |
| `src/constants/fmp-enums.ts`                 | new — curated enums |
| `src/services/universe.service.ts`           | new — resolver + cache |
| `src/services/market.service.ts`             | add `getNasdaq100Constituents`, `getDow30Constituents`, `getScreenerResults`, `getCompanyProfile` |
| `src/mcp/broker-local.ts`                    | add `check_universe`, `list_universe`; wire universe gating into `execute_trade` |
| `src/mcp/screener.ts`                        | read universe from fund config, not hardcoded |
| `src/services/screening.service.ts`          | signature unchanged; callers updated |
| `src/services/daemon.service.ts`             | nightly screen resolves per-fund universe |
| `src/commands/screen/run.tsx`                | `--universe` flag deprecated |
| `src/commands/fund/show-universe.tsx`        | new |
| `src/commands/fund/refresh-universe.tsx`     | new |
| `src/commands/fund/create.tsx`               | wizard adds universe step |
| `src/services/fund.service.ts`               | upgrade migration |
| `src/template.ts`                            | CLAUDE.md gains "Your Universe" section |
| `src/services/session.service.ts`            | session prompt gains `<fund_universe>` block |
| `src/skills.ts`                              | `risk-assessment` skill extended |
| `src/subagent.ts`                            | `trade-evaluator` prompt gains universe + soft-gate context |
| `tests/*`                                    | new and updated (see §8) |

---

## 10. Non-Goals (YAGNI)

- Multi-universe per fund (composite "large-cap tech + mid-cap healthcare"). The `filters` mode + include_tickers covers these cases well enough; composability adds significant complexity for rare value.
- Cross-fund shared universe cache. A single fund's FMP call is cheap; sharing by filter-hash optimizes a problem we don't have yet.
- Non-stock asset types (crypto, bonds, DeFi). Schema is stock-only. `strategies` / `protocols` fields from the old schema are dropped. When crypto/DeFi integration is built, a separate universe concept will be designed.
- Auto-refresh on market hours. The 24h TTL plus manual `refresh-universe` is adequate for v1.
- GUI/TUI universe editor. Users edit `fund_config.yaml` directly.

---

## 11. Open Questions

None at spec time. All design decisions confirmed in brainstorming session.
