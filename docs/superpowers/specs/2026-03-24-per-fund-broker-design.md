# Per-Fund Broker Credentials Design

## Problem

All FundX funds share a single Alpaca broker account (credentials stored in global config). Portfolio sync writes the full account balance to every fund's `portfolio.json`, causing incorrect P&L display (e.g., Growth shows +$81K on $10K initial capital). Virtual capital tracking is fragile. Each fund needs its own broker account.

## Design Decisions

- **Storage:** Per-fund `credentials.yaml` file (separate from fund_config, not committed to git)
- **Resolution:** Fund credentials > global credentials > error
- **CLI:** `fundx fund credentials <name>` command + wizard step during fund creation
- **Migration:** Fund upgrade resets portfolio and disables sync for funds without dedicated credentials
- **Sync guard:** `sync_enabled` field in fund config prevents shared-account sync corruption

---

## Section 1: Per-Fund Credentials Storage

### File: `~/.fundx/funds/<name>/credentials.yaml`

```yaml
api_key: "PKXXXXXXXXXXXXXXXX"
secret_key: "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

Two fields only. No `provider` or `mode` (those stay in `fund_config.yaml`). Optional — if absent, falls back to global credentials.

### Credential Resolution (priority order)

```
1. ~/.fundx/funds/<name>/credentials.yaml (if exists)
2. ~/.fundx/config.yaml broker.api_key / broker.secret_key (fallback)
3. Error: "No broker credentials configured for fund '<name>'"
```

### Security

- File created with permissions `0600` (owner read/write only)
- Added to `.gitignore` pattern (`credentials.yaml`)
- `fund_config.yaml` remains secret-free (convention maintained)
- CLAUDE.md instruction "never store secrets in per-fund configs" still holds — credentials are in a separate file

### New file: `src/credentials.ts`

Exports:
- `loadFundCredentials(fundName): Promise<{ apiKey: string; secretKey: string } | null>` — reads and parses credentials.yaml, returns null if not found
- `saveFundCredentials(fundName, apiKey, secretKey): Promise<void>` — writes credentials.yaml with `0600` permissions
- `hasFundCredentials(fundName): Promise<boolean>` — checks if credentials.yaml exists
- `clearFundCredentials(fundName): Promise<void>` — deletes credentials.yaml

### Modified files

- `src/paths.ts` — add `credentials` to `fundPaths()` return
- `src/types.ts` — `fundCredentialsSchema` (api_key: string, secret_key: string)

---

## Section 2: Credential Resolution Refactor

All code that reads broker credentials is updated to resolve per-fund first.

### `src/alpaca-helpers.ts` — `getAlpacaCredentials(fundName)`

Current: reads `globalConfig.broker.api_key` always.

New:
```
1. loadFundCredentials(fundName) → if exists, use these
2. else loadGlobalConfig().broker → fallback to global
3. else throw "No credentials configured for fund '<name>'"
4. Determine URL from fundConfig.broker.mode (paper/live)
5. Return { apiKey, secretKey, tradingUrl }
```

### `src/agent.ts` — `buildMcpServers(fundName)`

Current: constructs env vars from `globalConfig.broker.*`.

New: call `getAlpacaCredentials(fundName)` (which already resolves priority) and use the result for ALPACA_API_KEY / ALPACA_SECRET_KEY env vars.

### `src/broker-adapter.ts` — `createBrokerAdapter(fundName)`

Same change: use `getAlpacaCredentials(fundName)` instead of reading global config directly.

### Downstream impact

`sync.ts` and `stoploss.ts` already call `getAlpacaCredentials(fundName)`. Updating that function propagates the per-fund resolution automatically — no changes needed in these files.

### Modified files

- `src/alpaca-helpers.ts` — credential resolution with per-fund priority
- `src/agent.ts` — use resolved credentials for MCP env vars
- `src/broker-adapter.ts` — use resolved credentials

---

## Section 3: CLI Commands + Fund Creation Wizard

### New command: `fundx fund credentials <name>`

```bash
fundx fund credentials prueba              # shows if fund has dedicated credentials (no secrets displayed)
fundx fund credentials prueba --set        # interactive: asks api_key, secret_key, validates against Alpaca API, saves
fundx fund credentials prueba --clear      # deletes credentials.yaml, reverts to global fallback
```

Validation on `--set`: makes a `GET /v2/account` request to Alpaca with the provided credentials. If it fails, shows error and does not save. On success, also re-enables `sync_enabled: true` in fund config and runs an initial portfolio sync.

### Fund creation wizard update

At the end of `fundx fund create`, add a step after broker provider/mode selection:

```
Broker credentials:
  (g) Use global credentials (default)
  (f) Configure fund-specific Alpaca account
```

If `(f)`: prompts for api_key and secret_key, validates, saves to `credentials.yaml`.

### New files

- `src/commands/fund/credentials.tsx` — credentials command

### Modified files

- `src/commands/fund/create.tsx` — add credentials step to wizard

---

## Section 4: Migration on Fund Upgrade

When `fundx fund upgrade` runs, for each fund:

### Step 1: Check credentials

If fund has no `credentials.yaml`, show warning:
```
Fund 'growth' has no dedicated credentials.
Using global broker account (shared with other funds).
Run 'fundx fund credentials growth --set' to configure.
```

### Step 2: Reset portfolio

If the fund has no dedicated credentials, reset `portfolio.json` to initial capital:
```json
{ "cash": 10000, "total_value": 10000, "positions": [], "last_updated": "..." }
```
Output: `Portfolio reset to initial capital ($10,000) — no dedicated broker account.`

### Step 3: Disable sync

Add `sync_enabled: boolean` to the broker section of `fund_config.yaml`:
```yaml
broker:
  provider: alpaca
  mode: paper
  sync_enabled: false  # disabled until fund has dedicated credentials
```

Default is `true`. Set to `false` during upgrade for funds without credentials. When user runs `fundx fund credentials <name> --set`, automatically set back to `true` and run initial sync.

### Sync guard in daemon

`syncPortfolio(fundName)` checks `fundConfig.broker.sync_enabled` before syncing. If `false`, skip silently.

### Modified files

- `src/types.ts` — add `sync_enabled: z.boolean().default(true)` to fund broker schema
- `src/services/fund.service.ts` — `upgradeFund()` checks credentials, resets portfolio, sets sync_enabled
- `src/sync.ts` — check `sync_enabled` before syncing

---

## Files Summary

### New files

| File | Purpose |
|------|---------|
| `src/credentials.ts` | Load/save/check/clear per-fund credentials.yaml |
| `src/commands/fund/credentials.tsx` | CLI command for managing fund credentials |

### Modified files

| File | Changes |
|------|---------|
| `src/types.ts` | `fundCredentialsSchema`, `sync_enabled` in fund broker schema |
| `src/paths.ts` | Add `credentials` to `fundPaths()` |
| `src/alpaca-helpers.ts` | Credential resolution with per-fund priority |
| `src/agent.ts` | Use resolved credentials for MCP env vars |
| `src/broker-adapter.ts` | Use resolved credentials |
| `src/sync.ts` | Check `sync_enabled` before syncing |
| `src/services/fund.service.ts` | Upgrade checks credentials, resets portfolio, sets sync_enabled |
| `src/commands/fund/create.tsx` | Add credentials step to creation wizard |

### Unchanged

- `src/mcp/broker-alpaca.ts` — reads env vars, no change (env vars are set correctly by agent.ts)
- `src/stoploss.ts` — calls `getAlpacaCredentials()`, benefits automatically
- `src/config.ts` — global config unchanged
- `src/services/daemon.service.ts` — sync cron already calls `syncPortfolio()` which will check sync_enabled
