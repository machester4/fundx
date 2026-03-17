# Simply Wall St (SWS) Integration — Design Spec

**Date:** 2026-03-17
**Status:** Approved
**Approach:** Dedicated MCP server (Enfoque A)

## Overview

Integrate Simply Wall St's internal GraphQL API into FundX as an optional data source. Provides Claude with stock screening and fundamental analysis (Snowflake scores) during autonomous sessions, and enriches the `fundx portfolio` CLI view with per-position quality scores.

SWS uses JWT-based authentication from web sessions. Since there is no official API, we implement a `puppeteer-core` based login flow that opens Chrome, lets the user log in, and captures the `auth` cookie automatically.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Dedicated MCP server (`sws.ts`) | Follows existing pattern (broker-alpaca, market-data, telegram-notify). Clean separation of auth and concerns. |
| Auth capture | `puppeteer-core` with local Chrome | Lightweight (~2MB), seamless UX, no Chromium download. |
| Token storage | `~/.fundx/config.yaml` under `sws` key | Consistent with broker/telegram credential storage. |
| Dashboard scope | `fundx portfolio` only (not main dashboard) | Incremental — extend later if needed. |
| CLI commands | `fundx sws login/status/logout` | Minimal surface for auth management. |
| Degradation | Fully optional — no token = no SWS features, zero errors | SWS is an enhancement, not a dependency. |

## 1. Authentication System

### 1.1 Login Flow (`fundx sws login`)

1. Discover Chrome executable path (see 1.1.1 below)
2. Launch `puppeteer-core` with `{ executablePath, headless: false }` — dynamically imported (`await import('puppeteer-core')`) to avoid loading it on every CLI invocation
3. Navigate to `https://simplywall.st/login`
4. Monitor cookies — poll every 1 second for the `auth` cookie on the `simplywall.st` domain
5. When detected: extract JWT, decode `exp` claim (base64 decode payload, no crypto needed), validate structure
6. Close browser, save to config, display confirmation with expiration date
7. **Timeout:** 5 minutes max wait. If exceeded, exit with "Login timed out — try again."
8. **Browser closed early:** listen to `browser.on('disconnected')` → exit with "Browser closed before login completed."

#### 1.1.1 Chrome Discovery

Find the Chrome/Chromium executable using common paths per platform:

```typescript
const CHROME_PATHS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/snap/bin/chromium'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};
```

- Try each path in order, use the first that exists
- Allow override via `CHROME_PATH` environment variable (checked first)
- If none found: error with "Chrome not found. Set CHROME_PATH environment variable or install Chrome."

### 1.2 Token Storage

```yaml
# ~/.fundx/config.yaml
sws:
  auth_token: "eyJ0eXAi..."
  token_expires_at: "2026-01-21T14:13:27.000Z"
```

### 1.3 Config Schema (`types.ts`)

```typescript
sws: z.object({
  auth_token: z.string().optional(),
  token_expires_at: z.string().optional(),
}).optional()
```

Added to `globalConfigSchema`. Uses `.optional()` (not `.default({})`) so the `sws` key does not appear in `config.yaml` for users who never use SWS.

### 1.4 Expiration Handling

- **Before every SWS request:** check `token_expires_at`. If expired, throw `SwsTokenExpiredError` with message to run `fundx sws login`.
- **Telegram notification:** daemon checks 1x/day. If token expires in <48h, sends warning via `send_message`. If already expired, sends alert.
- **CLI warning:** in the `AppContext` provider, if SWS token exists and expires in <24h, render an inline warning. This integrates naturally with the Ink/Pastel lifecycle without blocking rendering.

### 1.5 Logout (`fundx sws logout`)

Load global config, `delete config.sws` from the config object, then call `saveGlobalConfig()`. This removes the `sws:` block from the YAML file completely. Display confirmation message.

### 1.6 Status (`fundx sws status`)

Display: token present (yes/no), expiration date, hours remaining, valid/expired status.

## 2. SWS Service (`src/services/sws.service.ts`)

**Relationship with MCP server:** The service and the MCP server are **independent** — same pattern as `market.service.ts` vs `src/mcp/market-data.ts`. The service reads the token from global config (for CLI-side use: login, logout, portfolio enrichment). The MCP server is self-contained and reads the token from `process.env.SWS_AUTH_TOKEN` with its own inline GraphQL client. Both share the same GraphQL queries by convention, not by import.

### 2.1 GraphQL Client (CLI-side)

```typescript
async function swsGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T>
```

- Reads token from global config (via `loadGlobalConfig()`)
- Checks expiry before request
- POST to `https://simplywall.st/graphql` with headers:
  - `authorization: Bearer <token>`
  - `apollographql-client-name: web`
  - `content-type: application/json`
- Validates response with provided Zod schema
- 5-second timeout per request

### 2.2 Public Functions

```typescript
// Auth
swsLogin(): Promise<{ token: string; expiresAt: string }>
swsLogout(): Promise<void>
swsTokenStatus(): Promise<{ valid: boolean; expiresAt: string | null; expiresInHours: number | null }>

// Screeners
swsScreener(screenerId: string | number, options?: {
  country?: string;   // default "us"
  limit?: number;     // default 36
  offset?: number;    // default 0
}): Promise<SwsScreenerResult>

swsListScreeners(): SwsScreenerInfo[]

// Company data
swsCompanyScore(uniqueSymbol: string): Promise<SwsSnowflake>
swsCompanyAnalysis(uniqueSymbol: string): Promise<SwsCompanyAnalysis>
swsSearchCompany(query: string, limit?: number): Promise<SwsSearchResult[]>

// Dashboard enrichment
swsEnrichPortfolio(symbols: string[]): Promise<Map<string, SwsSnowflake>>
```

### 2.3 Screener Registry

Hardcoded map of known SWS screener IDs. Discoverable via `sws_list_screeners` MCP tool.

```typescript
const SWS_SCREENERS: Record<string, { id: number; description: string }> = {
  "undiscovered-gems":   { id: 152, description: "Undiscovered gems with strong fundamentals" },
  "high-growth-tech":    { id: 148, description: "High growth tech stocks" },
  "dividend-champions":  { id: 155, description: "Reliable dividend payers" },
  "undervalued-large":   { id: 142, description: "Undervalued large caps" },
};
```

This is the v1 list. Screener IDs are discovered by inspecting network requests on the SWS "Discover" page (`simplywall.st/discover/investing-ideas/`). Each investing idea page has the `gridViewId` in its URL path. Additional screeners can be added to this map without code changes beyond updating this constant.

### 2.4 In-Memory Cache

The MCP server process (long-lived during a Claude session) maintains a simple TTL cache (5 minutes) for company scores, keyed by `uniqueSymbol`. This avoids redundant API calls when Claude queries the same company multiple times within a session. CLI-side service functions do not cache — they are short-lived one-shot processes.

## 3. MCP Server (`src/mcp/sws.ts`)

Standalone, self-contained MCP server (same pattern as `market-data.ts`). Does **not** import from `sws.service.ts` — has its own inline GraphQL client. Reads token from `process.env.SWS_AUTH_TOKEN`.

**Scope:** Globally conditional — if the SWS token is present in config, this server is available to **all funds** (unlike telegram-notify which is per-fund conditional). This is intentional: SWS data is account-level, not fund-level.

### 3.1 Tools

| Tool | Description | Parameters |
|---|---|---|
| `sws_screener` | Run an investing idea screener to discover stocks matching a theme | `screener` (slug or numeric ID), `country` (default "us"), `limit` (default 36), `offset` (default 0) |
| `sws_company_score` | Get Simply Wall St snowflake scores (value, future, health, past, dividend) for a company | `symbol` (uniqueSymbol format, e.g. "NasdaqGS:AAPL") |
| `sws_company_analysis` | Get detailed fundamental analysis including valuation, growth, dividends, and industry context | `symbol` |
| `sws_search` | Search for companies by name or ticker | `query`, `limit` (default 10) |
| `sws_list_screeners` | List all available screener IDs with descriptions | none |
| `sws_token_status` | Check if the SWS authentication token is valid and when it expires | none |

### 3.2 Wiring in `agent.ts`

Conditional — only added when token is present:

```typescript
if (globalConfig.sws?.auth_token) {
  servers["sws"] = {
    command: MCP_COMMAND,
    args: [MCP_SERVERS.sws],
    env: { SWS_AUTH_TOKEN: globalConfig.sws.auth_token },
  };
}
```

### 3.3 Path registration (`paths.ts`)

```typescript
export const MCP_SERVERS = {
  // ... existing
  sws: join(__dirname, "mcp", IS_DEV ? "sws.ts" : "sws.js"),
};
```

## 4. Dashboard Integration

### 4.1 Portfolio Enrichment

`fundx portfolio <fund>` shows snowflake scores alongside each position:

```
 Symbol  Shares   Price    P&L       V  F  H  P  D
 AAPL      50   $185.40  +12.3%     5  4  6  5  3
 MSFT      30   $420.10   +8.7%     4  5  5  4  3
 GDX      200    $32.50   -2.1%     6  3  4  3  5
```

### 4.2 Implementation

- `portfolio.tsx` calls `swsEnrichPortfolio(symbols)` in parallel with portfolio data loading
- If no SWS token or API failure → columns simply not rendered (graceful degradation)
- **Ticker-to-uniqueSymbol mapping:** `swsEnrichPortfolio` uses `sws_search` internally to resolve each standard ticker (e.g., `AAPL`) to the SWS uniqueSymbol format (e.g., `NasdaqGS:AAPL`). The first search result matching the ticker is used. Results are cached per-session.
- SWS snowflake columns only render when terminal width >= 100 columns (uses existing `useTerminalSize` hook). Below that, they are hidden to avoid overflow.

### 4.3 `SnowflakeScores.tsx` Component

Renders 5 scores with color coding:
- 0-2: red (weak)
- 3-4: yellow (moderate)
- 5-6: green (strong)

## 5. CLI Commands

File-based routing under `src/commands/sws/`:

| File | Command | Behavior |
|---|---|---|
| `login.tsx` | `fundx sws login` | Opens Chrome via puppeteer-core, captures token, saves to config |
| `status.tsx` | `fundx sws status` | Shows token validity, expiration date, hours remaining |
| `logout.tsx` | `fundx sws logout` | Removes token from config |

## 6. Notification Integration

### 6.1 Daemon Token Check

In `daemon.service.ts`, add a daily check at 09:00 (alongside existing scheduled tasks):
- Token expires in <48h → Telegram warning via `send_message`
- Token expired → Telegram alert via `send_message`
- No token configured → skip silently

### 6.2 CLI Startup Warning

In the `AppContext` provider, check SWS token expiry. If token exists and expires in <24h, render:

```
⚠ SWS token expires in 18h — run `fundx sws login` to renew
```

## 7. Files Summary

### New Files

| File | Purpose |
|---|---|
| `src/services/sws.service.ts` | Auth (puppeteer-core), GraphQL client, queries, cache |
| `src/mcp/sws.ts` | MCP server with 6 tools for Claude sessions |
| `src/commands/sws/login.tsx` | `fundx sws login` command |
| `src/commands/sws/status.tsx` | `fundx sws status` command |
| `src/commands/sws/logout.tsx` | `fundx sws logout` command |
| `src/components/SnowflakeScores.tsx` | Colored V/F/H/P/D score display |

### Modified Files

| File | Change |
|---|---|
| `src/types.ts` | Zod schemas: `swsConfigSchema`, `swsSnowflakeSchema`, `swsCompanySchema`, etc. |
| `src/paths.ts` | Add `MCP_SERVERS.sws` |
| `src/agent.ts` | Conditional SWS server in `buildMcpServers()` |
| `src/services/chat.service.ts` | Conditional SWS server in `buildChatMcpServers()` for workspace-mode sessions |
| `src/commands/portfolio.tsx` | Enrich positions with snowflake scores (conditional on terminal width) |
| `src/services/daemon.service.ts` | Daily token expiration check at 09:00 |
| `src/services/index.ts` | Re-export `sws.service.ts` |
| `src/context/AppContext.tsx` | SWS token expiry warning |
| `tsup.config.ts` | Add `src/mcp/sws.ts` to MCP server build entry |
| `package.json` | Add `puppeteer-core` dependency |

### New Dependency

`puppeteer-core` — uses locally installed Chrome, no Chromium download. Dynamically imported (`await import('puppeteer-core')`) only in the login flow to avoid loading it on every CLI invocation.

## 8. Non-Goals (Explicit)

- No SWS data in the main dashboard (`commands/index.tsx`) — future extension
- No standalone CLI screener commands (`fundx sws screener ...`) — Claude accesses via MCP
- No modification to existing market-data MCP server
- No modification to analyst sub-agents — they discover SWS tools organically via MCP
- No SWS portfolio sync (SWS has its own portfolio feature, we don't use it)
