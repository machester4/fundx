# Per-Fund Broker Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each fund its own Alpaca broker account via a separate `credentials.yaml` file, with credential resolution fallback to global config, a CLI command for managing credentials, and migration that resets portfolios for funds without dedicated accounts.

**Architecture:** New `credentials.ts` module handles per-fund credential CRUD. `getAlpacaCredentials()` in `alpaca-helpers.ts` is updated to check fund credentials first, then fall back to global. `buildMcpServers()` in `agent.ts` uses the resolved credentials. A `sync_enabled` flag prevents shared-account sync corruption. Fund upgrade migrates existing funds.

**Tech Stack:** TypeScript, YAML (js-yaml), Zod, Ink/React (wizard), Vitest

**Spec:** `docs/superpowers/specs/2026-03-24-per-fund-broker-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/credentials.ts` | Load/save/check/clear per-fund credentials.yaml |
| `src/commands/fund/credentials.tsx` | CLI command for managing fund credentials |
| `tests/credentials.test.ts` | Unit tests for credentials module |

### Modified files

| File | Changes |
|------|---------|
| `src/types.ts` | `fundCredentialsSchema`, `sync_enabled` in fund broker schema |
| `src/paths.ts` | Add `credentials` to `fundPaths()` |
| `src/alpaca-helpers.ts` | Credential resolution with per-fund priority |
| `src/agent.ts` | Use resolved credentials for MCP env vars |
| `src/sync.ts` | Check `sync_enabled` before syncing |
| `src/services/fund.service.ts` | Upgrade checks credentials, resets portfolio, sets sync_enabled |
| `src/commands/fund/create.tsx` | Add credentials step to wizard (steps 7→8) |
| `.gitignore` | Add `credentials.yaml` |

---

## Task 1: Types, Paths, and Credentials Module

**Files:**
- Modify: `src/types.ts`
- Modify: `src/paths.ts`
- Modify: `.gitignore`
- Create: `src/credentials.ts`
- Create: `tests/credentials.test.ts`

- [ ] **Step 1: Add schemas to `src/types.ts`**

Add `fundCredentialsSchema` after the news schemas:

```typescript
// ── Fund Credentials Schema ──────────────────────────────────

export const fundCredentialsSchema = z.object({
  api_key: z.string(),
  secret_key: z.string(),
});

export type FundCredentials = z.infer<typeof fundCredentialsSchema>;
```

Add `sync_enabled` to the fund broker schema. Find the `broker` field inside `fundConfigSchema` (currently has `provider` and `mode`):

```typescript
  broker: z.object({
    provider: z.enum(["alpaca", "ibkr", "binance", "manual"]).default("manual"),
    mode: z.enum(["paper", "live"]).default("paper"),
    sync_enabled: z.boolean().default(true),
  }),
```

- [ ] **Step 2: Add `credentials` to `fundPaths()` in `src/paths.ts`**

Inside `fundPaths()` return object, after `memory`:

```typescript
credentials: join(root, "credentials.yaml"),
```

- [ ] **Step 3: Add `credentials.yaml` to `.gitignore`**

Append:
```
credentials.yaml
```

- [ ] **Step 4: Write tests for credentials module**

Create `tests/credentials.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/paths.js", () => ({
  fundPaths: (name: string) => ({
    root: `/mock/.fundx/funds/${name}`,
    credentials: `/mock/.fundx/funds/${name}/credentials.yaml`,
  }),
}));

import { readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadFundCredentials, saveFundCredentials, hasFundCredentials, clearFundCredentials } from "../src/credentials.js";

describe("loadFundCredentials", () => {
  it("returns null when credentials.yaml does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = await loadFundCredentials("test-fund");
    expect(result).toBeNull();
  });

  it("returns parsed credentials when file exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("api_key: PK123\nsecret_key: SK456");
    const result = await loadFundCredentials("test-fund");
    expect(result).toEqual({ apiKey: "PK123", secretKey: "SK456" });
  });
});

describe("saveFundCredentials", () => {
  it("writes credentials.yaml with 0600 permissions", async () => {
    await saveFundCredentials("test-fund", "PK123", "SK456");
    expect(writeFile).toHaveBeenCalledWith(
      "/mock/.fundx/funds/test-fund/credentials.yaml",
      expect.stringContaining("api_key"),
      "utf-8",
    );
    expect(chmod).toHaveBeenCalledWith(
      "/mock/.fundx/funds/test-fund/credentials.yaml",
      0o600,
    );
  });
});

describe("hasFundCredentials", () => {
  it("returns false when no file", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(await hasFundCredentials("test-fund")).toBe(false);
  });

  it("returns true when file exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(await hasFundCredentials("test-fund")).toBe(true);
  });
});
```

- [ ] **Step 5: Implement `src/credentials.ts`**

```typescript
import { readFile, writeFile, unlink, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { fundCredentialsSchema } from "./types.js";
import { fundPaths } from "./paths.js";

/** Load per-fund broker credentials. Returns null if no credentials.yaml exists. */
export async function loadFundCredentials(
  fundName: string,
): Promise<{ apiKey: string; secretKey: string } | null> {
  const credPath = fundPaths(fundName).credentials;
  if (!existsSync(credPath)) return null;

  try {
    const raw = await readFile(credPath, "utf-8");
    const parsed = yaml.load(raw);
    const creds = fundCredentialsSchema.parse(parsed);
    return { apiKey: creds.api_key, secretKey: creds.secret_key };
  } catch {
    return null;
  }
}

/** Save per-fund broker credentials with restricted permissions (0600). */
export async function saveFundCredentials(
  fundName: string,
  apiKey: string,
  secretKey: string,
): Promise<void> {
  const credPath = fundPaths(fundName).credentials;
  await mkdir(dirname(credPath), { recursive: true });
  const content = yaml.dump({ api_key: apiKey, secret_key: secretKey });
  await writeFile(credPath, content, "utf-8");
  await chmod(credPath, 0o600);
}

/** Check if a fund has dedicated credentials. */
export async function hasFundCredentials(fundName: string): Promise<boolean> {
  return existsSync(fundPaths(fundName).credentials);
}

/** Remove per-fund credentials (revert to global fallback). */
export async function clearFundCredentials(fundName: string): Promise<void> {
  const credPath = fundPaths(fundName).credentials;
  await unlink(credPath).catch(() => {});
}
```

- [ ] **Step 6: Run tests**

Run: `pnpm test -- tests/credentials.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/paths.ts src/credentials.ts tests/credentials.test.ts .gitignore
git commit -m "feat(broker): add per-fund credentials module, schemas, and path constant"
```

---

## Task 2: Credential Resolution Refactor

**Files:**
- Modify: `src/alpaca-helpers.ts`
- Modify: `src/agent.ts`

- [ ] **Step 1: Update `getAlpacaCredentials` in `src/alpaca-helpers.ts`**

Replace the function (lines 17-35):

```typescript
import { loadFundCredentials } from "./credentials.js";

/** Resolve Alpaca API credentials and base URL for a fund.
 *  Priority: fund credentials.yaml > global config > error */
export async function getAlpacaCredentials(
  fundName: string,
): Promise<AlpacaCredentials> {
  // 1. Try per-fund credentials
  const fundCreds = await loadFundCredentials(fundName);
  if (fundCreds) {
    const fundConfig = await loadFundConfig(fundName);
    const mode = fundConfig.broker.mode ?? "paper";
    const tradingUrl = mode === "live" ? ALPACA_LIVE_URL : ALPACA_PAPER_URL;
    return { apiKey: fundCreds.apiKey, secretKey: fundCreds.secretKey, tradingUrl };
  }

  // 2. Fallback to global config
  const globalConfig = await loadGlobalConfig();
  const apiKey = globalConfig.broker.api_key;
  const secretKey = globalConfig.broker.secret_key;
  if (!apiKey || !secretKey) {
    throw new Error(
      `No broker credentials for fund '${fundName}'. Run 'fundx fund credentials ${fundName} --set' or configure global credentials.`,
    );
  }

  const fundConfig = await loadFundConfig(fundName);
  const mode = fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";
  const tradingUrl = mode === "live" ? ALPACA_LIVE_URL : ALPACA_PAPER_URL;
  return { apiKey, secretKey, tradingUrl };
}
```

- [ ] **Step 2: Update `buildMcpServers` in `src/agent.ts`**

Replace the credential section (around lines 79-85):

```typescript
import { getAlpacaCredentials } from "./alpaca-helpers.js";

// Inside buildMcpServers, replace:
//   const brokerEnv: Record<string, string> = {};
//   if (globalConfig.broker.api_key) brokerEnv.ALPACA_API_KEY = ...
//   if (globalConfig.broker.secret_key) brokerEnv.ALPACA_SECRET_KEY = ...
//   brokerEnv.ALPACA_MODE = ...
// With:

  const brokerEnv: Record<string, string> = {};
  try {
    const creds = await getAlpacaCredentials(fundName);
    brokerEnv.ALPACA_API_KEY = creds.apiKey;
    brokerEnv.ALPACA_SECRET_KEY = creds.secretKey;
    brokerEnv.ALPACA_MODE = creds.tradingUrl.includes("paper") ? "paper" : "live";
  } catch {
    // No broker credentials — broker MCP server will fail gracefully
    brokerEnv.ALPACA_MODE = fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";
  }
```

- [ ] **Step 3: Run typecheck + tests**

Run: `pnpm typecheck && pnpm test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/alpaca-helpers.ts src/agent.ts
git commit -m "feat(broker): per-fund credential resolution with global fallback"
```

---

## Task 3: Sync Guard

**Files:**
- Modify: `src/sync.ts`

- [ ] **Step 1: Add `sync_enabled` check at top of `syncPortfolio`**

At the top of `syncPortfolio()` (after line 28), add:

```typescript
  // Check if sync is enabled for this fund
  const { loadFundConfig } = await import("./services/fund.service.js");
  const fundConfig = await loadFundConfig(fundName);
  if (fundConfig.broker.sync_enabled === false) {
    // Sync disabled — fund has no dedicated broker account
    return readPortfolio(fundName);
  }
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/sync.ts
git commit -m "feat(broker): skip portfolio sync when sync_enabled is false"
```

---

## Task 4: Fund Upgrade Migration

**Files:**
- Modify: `src/services/fund.service.ts`

- [ ] **Step 1: Update `upgradeFund` to check credentials and reset portfolio**

Add import:
```typescript
import { hasFundCredentials } from "../credentials.js";
```

At the end of `upgradeFund()`, after the existing skill/rule/memory operations, add:

```typescript
  // Check if fund has dedicated broker credentials
  const hasCreds = await hasFundCredentials(fundName);
  if (!hasCreds) {
    // Reset portfolio to initial capital — no dedicated broker account
    const config = await loadFundConfig(fundName);
    await initFundState(fundName, config.capital.initial, config.objective.type);

    // Disable sync to prevent shared-account corruption
    if (config.broker.sync_enabled !== false) {
      config.broker.sync_enabled = false;
      await saveFundConfig(config);
    }
  }
```

Note: `initFundState` already exists in `state.ts` and resets portfolio to initial capital.

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: PASS (fund-upgrade tests may need mock updates)

- [ ] **Step 3: Commit**

```bash
git add src/services/fund.service.ts
git commit -m "feat(broker): upgrade migration resets portfolio and disables sync without dedicated credentials"
```

---

## Task 5: Credentials CLI Command

**Files:**
- Create: `src/commands/fund/credentials.tsx`

- [ ] **Step 1: Create the credentials command**

```typescript
import React, { useState, useEffect } from "react";
import zod from "zod";
import { Box, Text } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";
import { option } from "pastel";
import { loadFundCredentials, saveFundCredentials, clearFundCredentials, hasFundCredentials } from "../../credentials.js";
import { loadFundConfig, saveFundConfig } from "../../services/fund.service.js";
import { syncPortfolio } from "../../sync.js";
import { ALPACA_PAPER_URL, ALPACA_LIVE_URL } from "../../alpaca-helpers.js";

export const description = "Manage broker credentials for a fund";

export const args = zod.tuple([
  zod.string().describe("Fund name"),
]);

export const options = zod.object({
  set: zod.boolean().default(false).describe(option({ description: "Set new credentials", alias: "s" })),
  clear: zod.boolean().default(false).describe(option({ description: "Clear credentials (revert to global)", alias: "c" })),
});

type Props = { args: zod.infer<typeof args>; options: zod.infer<typeof options> };

export default function FundCredentials({ args: [fundName], options: opts }: Props) {
  const [phase, setPhase] = useState<"check" | "input-key" | "input-secret" | "validating" | "done">("check");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (phase !== "check") return;
    (async () => {
      if (opts.clear) {
        await clearFundCredentials(fundName);
        const config = await loadFundConfig(fundName);
        config.broker.sync_enabled = false;
        await saveFundConfig(config);
        setMessage(`Credentials cleared for '${fundName}'. Reverted to global fallback. Sync disabled.`);
        setPhase("done");
        return;
      }
      if (opts.set) {
        setPhase("input-key");
        return;
      }
      // Default: show status
      const has = await hasFundCredentials(fundName);
      setMessage(has
        ? `Fund '${fundName}' has dedicated broker credentials.`
        : `Fund '${fundName}' uses global credentials. Run with --set to configure.`);
      setPhase("done");
    })();
  }, []);

  if (phase === "done") {
    return error
      ? <Text color="red">{error}</Text>
      : <Text color="green">{message}</Text>;
  }

  if (phase === "input-key") {
    return (
      <Box flexDirection="column">
        <Text>Alpaca API Key:</Text>
        <TextInput placeholder="PKXXXXXXXX" onSubmit={(v) => { setApiKey(v); setPhase("input-secret"); }} />
      </Box>
    );
  }

  if (phase === "input-secret") {
    return (
      <Box flexDirection="column">
        <Text>Alpaca Secret Key:</Text>
        <TextInput placeholder="XXXXXXXX" onSubmit={(secretKey) => {
          setPhase("validating");
          (async () => {
            try {
              // Validate credentials against Alpaca API
              const config = await loadFundConfig(fundName);
              const mode = config.broker.mode ?? "paper";
              const url = mode === "live" ? ALPACA_LIVE_URL : ALPACA_PAPER_URL;
              const resp = await fetch(`${url}/v2/account`, {
                headers: { "APCA-API-KEY-ID": apiKey, "APCA-API-SECRET-KEY": secretKey },
              });
              if (!resp.ok) throw new Error(`Alpaca returned ${resp.status}`);

              await saveFundCredentials(fundName, apiKey, secretKey);

              // Enable sync and run initial sync
              config.broker.sync_enabled = true;
              await saveFundConfig(config);
              try {
                await syncPortfolio(fundName);
              } catch { /* initial sync best-effort */ }

              setMessage(`Credentials saved for '${fundName}'. Sync enabled.`);
            } catch (err) {
              setError(`Invalid credentials: ${err instanceof Error ? err.message : err}`);
            }
            setPhase("done");
          })();
        }} />
      </Box>
    );
  }

  return <Spinner label="Validating credentials..." />;
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/commands/fund/credentials.tsx
git commit -m "feat(broker): add fundx fund credentials command (set, clear, status)"
```

---

## Task 6: Fund Creation Wizard Update

**Files:**
- Modify: `src/commands/fund/create.tsx`

- [ ] **Step 1: Add credentials step to wizard**

Update the `Step` type to include `"credentials"`:
```typescript
type Step = "name" | "displayName" | "description" | "objective" | "capital" | "risk" | "tickers" | "brokerMode" | "credentials" | "creating" | "done";
```

Update `totalSteps` from `7` to `8` in all `WizardStep` components.

Change the `brokerMode` step's `onChange` to go to `"credentials"` instead of `"creating"`:
```typescript
onChange={(v) => {
  setData((d) => ({ ...d, brokerMode: v as "paper" | "live" }));
  setStep("credentials");
}}
```

Add the credentials step before the `creating` step:
```typescript
  if (step === "credentials") {
    return (
      <WizardStep step={8} totalSteps={8} title="Broker credentials">
        <Select
          options={[
            { label: "Use global credentials (default)", value: "global" },
            { label: "Configure fund-specific Alpaca account", value: "fund" },
          ]}
          onChange={(v) => {
            if (v === "global") {
              // Skip — use global credentials
              triggerCreate(data);
            } else {
              // TODO: for now, show hint to use fundx fund credentials after creation
              setStep("creating");
              triggerCreate(data, true);
            }
          }}
        />
      </WizardStep>
    );
  }
```

Extract the fund creation logic into a `triggerCreate` function:
```typescript
  function triggerCreate(d: typeof data, showCredentialsHint = false) {
    setStep("creating");
    const objective = buildObjective(d.objectiveType);
    (async () => {
      try {
        await createFund({ ...d, objective });
        if (showCredentialsHint) {
          setError(null);
          // Will show hint in done step
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setStep("done");
    })();
  }
```

Update the done step to show credentials hint when applicable.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/commands/fund/create.tsx
git commit -m "feat(broker): add credentials step to fund creation wizard"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 4: Manual smoke test**

```bash
# Check credentials status
pnpm dev -- fund credentials prueba
# → "uses global credentials"

# Upgrade all funds (resets portfolios, disables sync)
for f in Growth pm-survivor prueba runway-metal; do
  pnpm dev -- fund upgrade -n $f
done

# Verify portfolio reset
cat ~/.fundx/funds/Growth/state/portfolio.json
# → cash: 10000, total_value: 10000

# Verify sync disabled
grep sync_enabled ~/.fundx/funds/Growth/fund_config.yaml
# → sync_enabled: false

# Set credentials for a fund
pnpm dev -- fund credentials prueba --set
# → prompts for api_key, secret_key, validates, saves

# Verify credentials file
ls -la ~/.fundx/funds/prueba/credentials.yaml
# → -rw------- (0600 permissions)

# Verify sync re-enabled
grep sync_enabled ~/.fundx/funds/prueba/fund_config.yaml
# → sync_enabled: true
```

- [ ] **Step 5: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix(broker): integration fixes"
```
