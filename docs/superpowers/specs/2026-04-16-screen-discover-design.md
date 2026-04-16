# screen_discover — Design Spec

**Date:** 2026-04-16  
**Status:** Approved  
**Scope:** Add `screen_discover` MCP tool to the screener server

---

## Problem

The existing `screen_run` tool only evaluates tickers within a fund's pre-configured universe (e.g. SP500 preset). Claude cannot discover ETFs, sector funds, or any asset outside that universe without modifying `fund_config.yaml`. This defeats the purpose of a screener — discovery should be open, not constrained by a static list.

---

## Solution

Add a new `screen_discover` tool to `src/mcp/screener.ts`. Claude passes FMP screener filters directly (composing them based on its current thesis), the tool scores all matching candidates with the momentum-12-1 algorithm, and returns ranked results in memory. No watchlist writes occur. Claude evaluates results and decides whether to persist any ticker via `watchlist_tag`.

---

## Architecture

### Files changed

| File | Change |
|------|--------|
| `src/mcp/screener.ts` | Add `handleScreenDiscover` (exported) + register `screen_discover` tool in `main()` |
| `src/skills.ts` | Update "Opportunity Screening" skill: add section on using `screen_discover` for out-of-universe exploration |

### Files NOT changed

- `src/services/screening.service.ts` — reuse `scoreMomentum121` as-is
- `src/services/universe.service.ts` — not involved
- `src/services/watchlist.service.ts` — not involved (no writes)
- `src/types.ts` — no new types needed

---

## Tool Schema

### Input

```typescript
screen_discover({
  filters: FmpScreenerFilters,  // Existing schema — is_etf, sector, market_cap_min/max,
                                 // volume_min, exchange, country, beta, etc.
                                 // Claude composes freely. limit defaults to 500, max 10_000.
  screen?: "momentum-12-1"      // Optional, defaults to "momentum-12-1"
})
```

Claude controls scope via `filters.limit`. No internal cap beyond the FMP schema's max of 10,000.

### Output (`DiscoverResult`)

```typescript
{
  candidates_fetched: number,    // Count returned by FMP screener
  candidates_scored: number,     // Count with sufficient price history (>=273 bars)
  candidates_passed: number,     // Count passing MIN_PRICE ($5) and MIN_ADV ($10M USD)
  duration_ms: number,
  results: Array<{
    ticker: string,
    score: number,               // return_12_1 (momentum score)
    return_12_1: number,
    adv_usd_30d: number,
    last_price: number,
    missing_days: number,
    // FMP metadata — included at no extra API cost (field names from ScreenerResult)
    companyName?: string,
    sector?: string,
    market_cap?: number,    // marketCap from FMP
    exchange?: string,
    is_etf?: boolean,       // isEtf from FMP
  }>   // sorted by score descending, all candidates that pass filters
}
```

---

## Data Flow

```
Claude calls screen_discover({ filters: { is_etf: true, sector: ["Basic Materials"], limit: 200 } })
  │
  ├─ getScreenerResultsRaw(filters, apiKey)
  │    → ScreenerResult[] (symbol, name, sector, marketCap, price, volume, isEtf, exchange)
  │    → throws on FMP error — Claude receives descriptive error message
  │
  ├─ For each ticker:
  │    ├─ isFresh(pcdb, ticker)? → readBars(pcdb)           ← cache hit (shared with screen_run)
  │    └─ else → getHistoricalDaily(ticker, 273, apiKey)
  │                → writeBars(pcdb, ticker, bars)           ← populates shared cache
  │                (fetch failure → skip ticker silently, same as screen_run behavior)
  │
  ├─ scoreMomentum121(bars) per ticker
  │    ├─ null if bars < 273          → not counted in candidates_scored
  │    ├─ last_price < $5             → filtered out (candidates_passed not incremented)
  │    └─ adv_usd_30d < $10M         → filtered out
  │
  └─ Sort descending by score → return DiscoverResult
```

---

## Key Differences from `screen_run`

| Aspect | `screen_run` | `screen_discover` |
|--------|-------------|------------------|
| Universe source | Fund's configured universe (preset or filters) | Claude-provided FMP filters |
| Watchlist writes | Yes — `insertScreenRun`, `insertScore`, transitions | None |
| Lock acquisition | Yes (30-min stale lock) | No |
| Fund compatibility tagging | Yes | No |
| Result persistence | Persistent in SQLite | Ephemeral (returned to Claude) |
| Purpose | Ongoing fund monitoring | Ad-hoc exploration / thesis validation |

---

## Skill Update (`src/skills.ts` — "Opportunity Screening")

Add section at the end of the skill:

```markdown
## Out-of-Universe Discovery

When the fund has a thesis on a sector or asset type outside the configured universe,
use screen_discover with appropriate filters instead of screen_run.

Example: exploring gold ETF momentum when the fund is SP500-preset:
  screen_discover({ filters: { is_etf: true, sector: ["Basic Materials"], limit: 200 } })

Results are ephemeral — Claude evaluates in memory. If a ticker warrants ongoing tracking,
persist it explicitly:
  watchlist_tag({ ticker: "GDXJ", status: "candidate", reason: "gold reentry signal — ..." })
```

---

## Error Handling

- **FMP returns empty list:** `getScreenerResultsRaw` throws on empty body — `handleScreenDiscover`
  catches this specific case and returns `DiscoverResult` with all counts = 0 and empty `results`
- **FMP HTTP error (4xx/5xx):** propagate as thrown error — Claude receives descriptive message
- **Individual ticker bar fetch fails:** skip ticker silently, same as `runScreen`
- **All tickers lack sufficient history:** return with `candidates_scored = 0`, empty `results`

---

## What This Does NOT Change

- `screen_run` behavior is unchanged
- Fund universe configuration is unchanged
- Watchlist state machine is unchanged
- The OOU (out-of-universe) trade justification flow in `broker-local` is unchanged — if Claude wants to actually trade a discovered ticker that is OOU, it still needs to provide a material justification via the existing broker-local rules
- No new Zod types needed
