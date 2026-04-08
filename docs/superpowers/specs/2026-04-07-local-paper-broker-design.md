# Local Paper Broker

**Date:** 2026-04-07
**Status:** Approved

## Summary

Replace the Alpaca broker integration with a local paper broker that operates
entirely on `portfolio.json`. The user replicates positions manually in their
real broker, so an external broker API for paper trading adds complexity with no
value. Market data continues to come from FMP.

## What Changes

### Files to delete

| File | Reason |
|------|--------|
| `src/mcp/broker-alpaca.ts` | Replaced by `broker-local.ts` |
| `src/alpaca-helpers.ts` | All Alpaca API helpers — no longer needed |
| `src/sync.ts` | Portfolio sync from Alpaca — local state is the truth |
| `src/credentials.ts` | Per-fund broker credentials — no external broker |
| `src/broker-adapter.ts` | Multi-broker adapter interface — only one broker now |
| `src/services/live-trading.service.ts` | Live trading mode — paper only |
| `src/commands/fund/credentials.tsx` | Credential management command |
| `src/commands/live/enable.tsx` | Live trading enable command |
| `src/commands/live/disable.tsx` | Live trading disable command |

### Files to create

#### `src/paper-trading.ts` — Core execution logic

Pure functions shared between the MCP server and the daemon stop-loss monitor.
No side effects — callers persist the result.

```typescript
interface TradeResult {
  portfolio: Portfolio;
  trade: {
    symbol: string;
    side: "buy" | "sell";
    qty: number;
    price: number;
    total_value: number;
    reason: string;
  };
}

function executeBuy(
  portfolio: Portfolio,
  symbol: string,
  qty: number,
  price: number,
  stopLoss?: number,
  entryReason?: string,
): TradeResult;

function executeSell(
  portfolio: Portfolio,
  symbol: string,
  qty: number,
  price: number,
  reason?: string,
): TradeResult;
```

`executeBuy`:
1. Validates cash >= qty * price
2. If position exists for symbol, adds to it (weighted avg cost recalculation)
3. If new position, creates entry with all required schema fields
4. Deducts cash, recalculates total_value and weight_pct for all positions
5. Returns updated portfolio and trade record

`executeSell`:
1. Validates position exists with sufficient shares
2. Reduces or removes position
3. Adds proceeds to cash, recalculates total_value and weight_pct
4. Returns updated portfolio and trade record

Both functions enforce the canonical portfolio.json field names (`shares`,
`avg_cost`, `weight_pct`, `entry_reason`) — never Alpaca field names.

#### `src/mcp/broker-local.ts` — MCP server for Claude sessions

Stdio-based MCP server. Launched as a subprocess with environment variables:

```
FUND_DIR=/path/to/.fundx/funds/<name>
FMP_API_KEY=<key>
```

Tools:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_account` | none | Read portfolio.json, return cash, total_value, position count |
| `get_positions` | none | Return all positions from portfolio.json |
| `get_position` | `symbol` | Return one position or null |
| `place_order` | `symbol, qty, side, stop_loss?, entry_reason?` | Fetch price from FMP, execute via paper-trading.ts, write portfolio + journal |
| `get_quote` | `symbol` | Current price via FMP |
| `get_bars` | `symbol, timeframe, start?, end?, limit?` | OHLCV bars via FMP |

Design decisions:
- Only market orders. Fill is immediate at current FMP price.
- No limit, stop, or trailing orders. Stop-losses are position metadata
  monitored by the daemon, not pending orders.
- No `cancel_order` or `get_orders` — no pending orders exist.
- `place_order` writes the trade to `trade_journal.sqlite` directly,
  guaranteeing the journal entry uses correct field names.
- `stop_loss` and `entry_reason` are written into the position on buy,
  eliminating the need for Claude to edit portfolio.json manually.

### Files to modify

#### `src/stoploss.ts`

Remove all Alpaca dependencies. New flow:
1. Read portfolio.json via `readPortfolio()`
2. Fetch prices via `market.service.ts` (FMP) instead of `fetchLatestPrices()`
3. For triggered stops, call `executeSell()` from `paper-trading.ts`
4. Write updated portfolio via `writePortfolio()`
5. Log trade to journal via `insertTrade()`

Remove `placeMarketSell` and `getAlpacaCredentials` imports entirely.

#### `src/agent.ts` — `buildMcpServers()`

Replace `broker-alpaca` MCP server config with `broker-local`:
- Command: `node dist/mcp/broker-local.js` (prod) or `tsx src/mcp/broker-local.ts` (dev)
- Env: `FUND_DIR` (fund root path) and `FMP_API_KEY` (from global config)
- No broker credentials needed

#### `src/types.ts`

Simplify broker config schema:
- Remove `mode: z.enum(["paper", "live"])` — always paper
- Remove `provider`, `api_key`, `secret_key`, `sync_enabled`
- Keep `broker` block as `{ mode: z.literal("paper").default("paper") }`
- Remove `BrokerAdapter`, `BrokerAccount`, `BrokerPosition`, `BrokerOrder`,
  `PlaceOrderParams` types if they exist here

Simplify global config schema:
- Remove `broker.api_key`, `broker.secret_key`, `broker.provider`
- Keep only `market_data` section

#### `src/template.ts`

Update per-fund CLAUDE.md generation:
- Replace references to "broker MCP" with `broker-local`
- Remove mentions of "live trading"
- Clarify that orders are paper (immediate fill at market price)
- Update session protocol step 5 to say "Place trades via broker-local MCP"

#### `src/services/status.service.ts`

Remove Alpaca connectivity checks. The broker status check becomes: "paper
mode active" (always true). Market data status check stays (FMP ping).

#### `src/services/session.service.ts`

Update any references to `broker-alpaca` tool name in prompts to
`broker-local`.

#### `src/services/fund.service.ts`

- `upgradeFund()` — remove `hasFundCredentials` check (already partially done)
- `createFund()` — remove credential setup steps
- Remove `credentials.ts` import

#### `src/skills.ts`

Update `state-consistency.md` rule: the portfolio.json schema section already
has the correct field names. Remove any references to broker sync or Alpaca
field names since those concepts no longer exist.

#### `src/paths.ts`

Remove credential file path constants if present.

### What does NOT change

- `src/mcp/market-data.ts` — FMP market data, unchanged
- `src/mcp/telegram-notify.ts` — notifications, unchanged
- `src/journal.ts` — trade journal CRUD, unchanged
- `src/embeddings.ts` — FTS5 indexing, unchanged
- `src/subagent.ts` — sub-agent definitions, unchanged
- `src/state.ts` — state CRUD (including the new `normalizePositions`), unchanged
- Daemon scheduling logic — unchanged (only stop-loss internals change)
- All UI components — unchanged
- All commands except deleted ones — unchanged

## Config Changes

### Global config (`~/.fundx/config.yaml`)

Before:
```yaml
broker:
  provider: alpaca
  api_key: xxx
  secret_key: xxx
  mode: paper
market_data:
  provider: fmp
  fmp_api_key: xxx
```

After:
```yaml
market_data:
  provider: fmp
  fmp_api_key: xxx
```

### Fund config (`fund_config.yaml`)

Before:
```yaml
broker:
  provider: alpaca
  mode: paper
  sync_enabled: false
```

After:
```yaml
broker:
  mode: paper
```

## Migration

Existing fund configs will have stale broker fields. The Zod schema should use
`.passthrough()` or strip unknown keys so existing configs still parse. The
`fundx fund upgrade --all` command regenerates CLAUDE.md and rules but does not
rewrite `fund_config.yaml` — stale fields are harmless and ignored.
