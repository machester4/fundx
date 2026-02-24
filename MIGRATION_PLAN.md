# FundX Migration Plan: child_process → Claude Agent SDK

## Overview

Migrate FundX from invoking Claude Code CLI via `child_process.execFileAsync()` to using the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) programmatically. This gives us typed responses, structured outputs, cost tracking, hooks, budget controls, and in-process MCP servers — while keeping the same capabilities (tools, MCP, sub-agents, CLAUDE.md).

## Current State

**5 integration points** all use the same pattern:

```typescript
const result = await execFileAsync(claudePath, [
  "--print", "--project-dir", paths.root,
  "--model", model, "--max-turns", N, prompt
], { timeout, env: { ...process.env, ANTHROPIC_MODEL: model } });
// Then: result.stdout (raw text)
```

| File | Function | Purpose | Max Turns | Timeout |
|------|----------|---------|-----------|---------|
| `session.ts` | `runFundSession()` | Trading sessions | 50 | 15 min |
| `session.ts` | `runFundSessionWithSubAgents()` | Two-phase: sub-agents → decisions | 50 | 15 min |
| `subagent.ts` | `runSingleSubAgent()` | Individual analysis agent | 15 | 10 min |
| `ask.ts` | `runAsk()` | Read-only Q&A | 30 | 5 min |
| `gateway.ts` | `wakeClaudeForQuestion()` | Telegram questions | 10 | 5 min |

**MCP Configuration** (`mcp-config.ts`): Writes `.claude/settings.json` before each session with broker-alpaca, market-data, and optionally telegram-notify.

## Target State

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt,
  options: {
    model, maxTurns, cwd: paths.root,
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"],  // Load per-fund CLAUDE.md
    mcpServers: buildMcpServers(fundName),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxBudgetUsd: 5.0,
  }
})) {
  // Typed messages: assistant, result, system, etc.
  if (message.type === "result") {
    // message.result — final text
    // message.total_cost_usd — cost tracking
    // message.usage — token breakdown
    // message.structured_output — validated JSON (if outputFormat set)
  }
}
```

## What We Gain

| Feature | Before (CLI) | After (SDK) |
|---------|-------------|-------------|
| Result type | Raw stdout string | Typed `SDKResultMessage` |
| Signal extraction | Regex on text | Structured JSON output via Zod |
| Cost tracking | None | `total_cost_usd` per query |
| Budget control | None | `maxBudgetUsd` per session |
| Token usage | None | Per-model breakdown |
| Error handling | Exit code + stderr | Typed error subtypes |
| Trade interception | None | `PreToolUse` hooks |
| Real-time progress | None | Streaming messages |
| MCP servers | File-based (.claude/settings.json) | Programmatic + in-process option |
| Permissions | All-or-nothing | `canUseTool` callback |
| Sub-agents | Separate processes | Built-in `agents` option |
| Session resume | Not possible | `resume` with session ID |

## What We Preserve

- Per-fund `CLAUDE.md` auto-generated constitutions (via `settingSources: ["project"]`)
- All MCP servers (broker-alpaca, market-data, telegram-notify) — same stdio config
- Claude Code's built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, etc.)
- Full Claude Code system prompt (via `systemPrompt: { type: "preset", preset: "claude_code" }`)
- Fund isolation (each query scoped to fund's directory via `cwd`)
- All CLI commands (Commander.js interface unchanged)

## Authentication

For local/experimental use with Max subscription:
```bash
claude setup-token
export CLAUDE_CODE_OAUTH_TOKEN=<token>
```

For production/API use:
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

The SDK respects both. No code changes needed between them — just environment variables.

---

## Phase 0 — Foundation (Session 1)

**Goal:** Install SDK, create the core wrapper module, update types and config. No behavioral changes yet.

### Tasks

#### 0.1 Install Agent SDK
```bash
pnpm add @anthropic-ai/claude-agent-sdk
```

#### 0.2 Create `src/agent.ts` — Central SDK Wrapper

This is the **single module** that replaces all `execFileAsync(claude, [...])` calls. Every other module will import from here instead of using `child_process`.

```typescript
// src/agent.ts — Central Agent SDK wrapper for FundX
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadGlobalConfig } from "./config.js";
import { loadFundConfig } from "./fund.js";
import { fundPaths, MCP_SERVERS } from "./paths.js";

/** Options for running a Claude agent query */
export interface AgentQueryOptions {
  fundName: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  includeTelegram?: boolean;
  onMessage?: (message: SDKMessage) => void;
}

/** Result from a Claude agent query */
export interface AgentQueryResult {
  output: string;
  cost_usd: number;
  duration_ms: number;
  num_turns: number;
  usage: Record<string, { input_tokens: number; output_tokens: number }>;
  status: "success" | "error_max_turns" | "error_max_budget" | "error";
  error?: string;
}

/** Build MCP server configuration for a fund (replaces writeMcpSettings) */
export async function buildMcpServers(fundName: string) {
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(fundName);

  const brokerEnv: Record<string, string> = {};
  if (globalConfig.broker.api_key) brokerEnv.ALPACA_API_KEY = globalConfig.broker.api_key;
  if (globalConfig.broker.secret_key) brokerEnv.ALPACA_SECRET_KEY = globalConfig.broker.secret_key;
  brokerEnv.ALPACA_MODE = fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";

  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    "broker-alpaca": {
      command: "node",
      args: [MCP_SERVERS.brokerAlpaca],
      env: brokerEnv,
    },
    "market-data": {
      command: "node",
      args: [MCP_SERVERS.marketData],
      env: brokerEnv,
    },
  };

  // Conditionally add telegram-notify
  if (
    globalConfig.telegram.bot_token &&
    globalConfig.telegram.chat_id &&
    fundConfig.notifications.telegram.enabled
  ) {
    const telegramEnv: Record<string, string> = {
      TELEGRAM_BOT_TOKEN: globalConfig.telegram.bot_token,
      TELEGRAM_CHAT_ID: globalConfig.telegram.chat_id,
    };
    if (fundConfig.notifications.quiet_hours.enabled) {
      telegramEnv.QUIET_HOURS_START = fundConfig.notifications.quiet_hours.start;
      telegramEnv.QUIET_HOURS_END = fundConfig.notifications.quiet_hours.end;
    }
    servers["telegram-notify"] = {
      command: "node",
      args: [MCP_SERVERS.telegramNotify],
      env: telegramEnv,
    };
  }

  return servers;
}

/** Run a Claude Agent SDK query for a fund */
export async function runAgentQuery(options: AgentQueryOptions): Promise<AgentQueryResult> {
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(options.fundName);
  const paths = fundPaths(options.fundName);

  const model = options.model
    ?? fundConfig.claude.model
    ?? globalConfig.default_model
    ?? "sonnet";

  const mcpServers = await buildMcpServers(options.fundName);
  const startTime = Date.now();

  const abortController = new AbortController();
  let timeoutId: NodeJS.Timeout | undefined;
  if (options.timeoutMs) {
    timeoutId = setTimeout(() => abortController.abort(), options.timeoutMs);
  }

  let output = "";
  let costUsd = 0;
  let numTurns = 0;
  let usage: Record<string, { input_tokens: number; output_tokens: number }> = {};
  let status: AgentQueryResult["status"] = "success";
  let error: string | undefined;

  try {
    for await (const message of query({
      prompt: options.prompt,
      options: {
        model,
        maxTurns: options.maxTurns ?? 50,
        maxBudgetUsd: options.maxBudgetUsd,
        cwd: paths.root,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["project"],
        mcpServers,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController,
      },
    })) {
      // Forward messages to optional callback
      options.onMessage?.(message);

      // Capture result
      if (message.type === "result") {
        output = message.result ?? "";
        costUsd = message.total_cost_usd ?? 0;
        numTurns = message.num_turns ?? 0;
        usage = message.modelUsage ?? {};

        if (message.subtype !== "success") {
          status = message.subtype === "error_max_turns"
            ? "error_max_turns"
            : message.subtype === "error_max_budget_usd"
              ? "error_max_budget"
              : "error";
          error = message.subtype;
        }
      }
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  return {
    output,
    cost_usd: costUsd,
    duration_ms: Date.now() - startTime,
    num_turns: numTurns,
    usage,
    status,
    error,
  };
}
```

#### 0.3 Update `src/types.ts` — Add SDK-related types

Add enhanced session log schema that captures SDK metadata:

```typescript
// New: Enhanced session log with SDK metadata
export const sessionLogSchemaV2 = sessionLogSchema.extend({
  cost_usd: z.number().optional(),
  tokens_in: z.number().optional(),
  tokens_out: z.number().optional(),
  model_used: z.string().optional(),
  num_turns: z.number().optional(),
  status: z.enum(["success", "error_max_turns", "error_max_budget", "error", "timeout"]).optional(),
});
```

Add structured output schemas for sub-agent signals:

```typescript
// New: Structured output for sub-agent analysis
export const agentSignalSchema = z.object({
  signal: z.enum(["bullish", "neutral", "bearish"]),
  confidence: z.enum(["low", "medium", "high"]),
  key_factors: z.array(z.string()).max(5),
  summary: z.string(),
});

export const subAgentStructuredResultSchema = z.object({
  type: subAgentTypeSchema,
  signal: agentSignalSchema,
  analysis_markdown: z.string(),
});
```

#### 0.4 Update `src/config.ts` / Global Config

Remove `claude_path` from global config (no longer needed — SDK bundles Claude Code). Add optional `max_budget_usd` default:

```yaml
# ~/.fundx/config.yaml — new fields
default_model: "sonnet"
max_budget_usd: 10.0       # Default per-session budget (USD)
# claude_path: removed — SDK doesn't need external CLI path
```

Keep backward compatibility: if `claude_path` is present, ignore it.

#### 0.5 Verify Build

```bash
pnpm typecheck
pnpm build
pnpm test
```

### Deliverables
- `@anthropic-ai/claude-agent-sdk` installed
- `src/agent.ts` created with `runAgentQuery()` and `buildMcpServers()`
- Types updated in `src/types.ts`
- Global config schema updated (backward compatible)
- Build passes, tests pass (no behavioral changes)

### Estimated Scope
- **Files created:** 1 (`src/agent.ts`)
- **Files modified:** 2 (`types.ts`, `config.ts`)
- **Files unchanged:** Everything else
- **Risk:** Zero (no existing behavior modified)

---

## Phase 1 — Core Session Migration (Session 2)

**Goal:** Migrate the two primary integration points (`runFundSession` and `runAsk`) from `execFileAsync` to `runAgentQuery`. CLI commands remain identical.

### Tasks

#### 1.1 Migrate `session.ts:runFundSession()`

**Before:**
```typescript
const result = await execFileAsync(claudePath, [
  "--print", "--project-dir", paths.root,
  "--model", model, "--max-turns", "50", prompt
], { timeout, env: { ...process.env, ANTHROPIC_MODEL: model } });
const log = { ..., summary: result.stdout.slice(0, 500) };
```

**After:**
```typescript
import { runAgentQuery } from "./agent.js";

const result = await runAgentQuery({
  fundName,
  prompt,
  model,
  maxTurns: 50,
  timeoutMs: timeout,
  maxBudgetUsd: sessionConfig.max_budget_usd ?? 5.0,
});

const log: SessionLog = {
  fund: fundName,
  session_type: sessionType,
  started_at: startedAt,
  ended_at: new Date().toISOString(),
  trades_executed: 0,
  summary: result.output.slice(0, 500),
  cost_usd: result.cost_usd,
  tokens_in: Object.values(result.usage).reduce((s, u) => s + u.input_tokens, 0),
  tokens_out: Object.values(result.usage).reduce((s, u) => s + u.output_tokens, 0),
  model_used: model,
  num_turns: result.num_turns,
  status: result.status,
};
```

**Key changes:**
- Remove `execFileAsync` import and `writeMcpSettings` call (handled by `runAgentQuery`)
- Add cost/token tracking to session log
- Add budget control
- CLI command (`fundx session run`) unchanged

#### 1.2 Migrate `ask.ts:runAsk()`

**Before:**
```typescript
await writeMcpSettings(targetFunds[0]);
const result = await execFileAsync(claudePath, [
  "--print", "--project-dir", projectDir,
  "--model", model, "--max-turns", "30", prompt
], { timeout: 5 * 60 * 1000 });
console.log(result.stdout);
```

**After:**
```typescript
import { runAgentQuery } from "./agent.js";

const result = await runAgentQuery({
  fundName: targetFunds[0],
  prompt,
  model,
  maxTurns: 30,
  timeoutMs: 5 * 60 * 1000,
  maxBudgetUsd: 2.0,  // Read-only queries are cheaper
});
console.log(result.output);
// Optionally show cost:
console.log(chalk.dim(`\n  Cost: $${result.cost_usd.toFixed(4)} | Turns: ${result.num_turns}`));
```

**Key changes:**
- Remove `execFileAsync`, `writeMcpSettings` imports
- Show cost/turns after response
- CLI command (`fundx ask`) unchanged

#### 1.3 Remove `mcp-config.ts` Dependency for Migrated Files

`session.ts` and `ask.ts` no longer need `writeMcpSettings()` — the SDK wrapper handles it. But keep the function available for non-migrated files (`gateway.ts`, `subagent.ts`) until they're migrated.

#### 1.4 Update Tests

Update existing tests to mock `runAgentQuery` instead of `execFileAsync`.

#### 1.5 Manual Verification

```bash
# Test session run
pnpm dev -- session run <fund> pre_market

# Test ask
pnpm dev -- ask "How is my portfolio doing?" --fund <fund>

# Verify cost tracking in session log
cat ~/.fundx/funds/<fund>/state/session_log.json
```

### Deliverables
- `session.ts` migrated (runFundSession only, not sub-agent version yet)
- `ask.ts` migrated
- Cost/token tracking in session logs
- Tests updated
- CLI behavior identical

### Estimated Scope
- **Files modified:** 3 (`session.ts`, `ask.ts`, test files)
- **Risk:** Low (drop-in replacement, same prompts)

---

## Phase 2 — Sub-Agent Migration (Session 3)

**Goal:** Migrate parallel sub-agent execution from separate CLI processes to parallel `query()` calls. Add structured outputs to replace regex signal extraction.

### Tasks

#### 2.1 Migrate `subagent.ts:runSingleSubAgent()`

**Before:**
```typescript
const result = await execFileAsync(claudePath, [
  "--print", "--project-dir", paths.root,
  "--model", model, "--max-turns", String(agent.max_turns),
  agent.prompt,
], { timeout });
return { ..., output: result.stdout };
```

**After:**
```typescript
import { runAgentQuery } from "./agent.js";

const result = await runAgentQuery({
  fundName,
  prompt: agent.prompt,
  model,
  maxTurns: agent.max_turns,
  timeoutMs: timeout,
  maxBudgetUsd: 2.0,  // Cap per sub-agent
});

return {
  type: agent.type,
  name: agent.name,
  started_at: startedAt,
  ended_at: new Date().toISOString(),
  status: result.status === "success" ? "success"
    : result.error?.includes("abort") ? "timeout" : "error",
  output: result.output,
  error: result.error,
  cost_usd: result.cost_usd,
};
```

#### 2.2 Add Structured Outputs for Signal Extraction

**Before (regex parsing in `mergeSubAgentResults`):**
```typescript
const signalMatch = r.output.match(
  /(?:MACRO_SIGNAL|TECHNICAL_SIGNAL|SENTIMENT_SIGNAL|RISK_LEVEL):\s*(\w+)/gi
);
```

**After (structured JSON output from SDK):**
```typescript
import { z } from "zod";

const signalOutputSchema = z.object({
  signal: z.enum(["bullish", "neutral", "bearish"]),
  confidence: z.enum(["low", "medium", "high"]),
  key_factors: z.array(z.string()).max(5),
  summary: z.string(),
  analysis_markdown: z.string(),
});

// In runAgentQuery, add outputFormat option:
export async function runAgentQueryStructured<T extends z.ZodTypeAny>(
  options: AgentQueryOptions & { outputSchema: T }
): Promise<AgentQueryResult & { structured: z.infer<T> | null }> {
  // Uses SDK's outputFormat: { type: "json_schema", schema: z.toJSONSchema(options.outputSchema) }
  // Returns validated structured_output from result message
}
```

This eliminates brittle regex parsing and gives us typed signal data.

#### 2.3 Update `SubAgentResult` Type

```typescript
// Enhanced with cost tracking and structured signal
export const subAgentResultSchemaV2 = subAgentResultSchema.extend({
  cost_usd: z.number().optional(),
  signal: agentSignalSchema.optional(),  // Typed signal instead of regex
});
```

#### 2.4 Migrate `session.ts:runFundSessionWithSubAgents()`

The two-phase execution remains the same pattern, but now uses SDK:

```typescript
// Phase 1: Parallel sub-agents via runAgentQuery (same Promise.allSettled pattern)
// Phase 2: Main decision session via runAgentQuery with sub-agent context injected
```

No structural change — just replace the underlying call.

#### 2.5 Update `mergeSubAgentResults()`

Replace regex signal extraction with structured data:
```typescript
// Before: regex extraction from text
// After: read from result.signal directly
sections.push(`- ${r.type.toUpperCase()}_SIGNAL: ${r.signal?.signal ?? "unknown"} (${r.signal?.confidence})`);
for (const factor of r.signal?.key_factors ?? []) {
  sections.push(`  - ${factor}`);
}
```

#### 2.6 Update Tests

Mock `runAgentQuery` for sub-agent tests. Add tests for structured output validation.

### Deliverables
- `subagent.ts` fully migrated to SDK
- `session.ts:runFundSessionWithSubAgents()` migrated
- Structured outputs for signal extraction (no more regex)
- Cost tracking per sub-agent
- Budget control per sub-agent

### Estimated Scope
- **Files modified:** 3 (`subagent.ts`, `session.ts`, `types.ts`)
- **Risk:** Medium (structured output is new pattern — needs testing)

---

## Phase 3 — Gateway & Daemon Migration (Session 4)

**Goal:** Migrate the Telegram gateway and complete the removal of all `child_process` Claude invocations.

### Tasks

#### 3.1 Migrate `gateway.ts:wakeClaudeForQuestion()`

**Before:**
```typescript
const { execFile } = await import("node:child_process");
const execFileAsync = promisify(execFile);
const { writeMcpSettings } = await import("./session.js");
await writeMcpSettings(fundName);
const result = await execFileAsync(claudePath, [...], { timeout: 5 * 60 * 1000 });
const answer = result.stdout.trim();
```

**After:**
```typescript
import { runAgentQuery } from "./agent.js";

const result = await runAgentQuery({
  fundName,
  prompt,
  model,
  maxTurns: 10,
  timeoutMs: 5 * 60 * 1000,
  maxBudgetUsd: 1.0,  // Telegram queries should be cheap
});

const answer = result.output.trim();
```

#### 3.2 Clean Up `mcp-config.ts`

After all callers are migrated, `writeMcpSettings()` is no longer needed (SDK handles MCP config programmatically). Options:
- **Option A:** Delete `mcp-config.ts` entirely (clean)
- **Option B:** Keep it as fallback for any non-SDK use case

Recommendation: **Option A** — delete it. The `buildMcpServers()` function in `agent.ts` is the replacement.

#### 3.3 Clean Up Imports Across All Files

Remove all references to:
- `child_process` / `execFile`
- `writeMcpSettings`
- `globalConfig.claude_path`

#### 3.4 Update `daemon.ts`

The daemon calls `runFundSession()` which is already migrated. No changes needed in daemon.ts itself — it just calls the already-migrated function. Verify it works.

#### 3.5 Remove `claude_path` from Global Config

Mark as deprecated in the Zod schema. Remove from `fundx init` wizard prompts.

### Deliverables
- `gateway.ts` migrated
- `mcp-config.ts` removed (or deprecated)
- All `child_process` Claude invocations eliminated
- `claude_path` deprecated from config
- Full system tested end-to-end

### Estimated Scope
- **Files modified:** 3 (`gateway.ts`, `config.ts`, `init.ts`)
- **Files deleted:** 1 (`mcp-config.ts`)
- **Risk:** Low (gateway is the simplest integration point)

---

## Phase 4 — SDK Hooks & Enhanced Features (Session 5)

**Goal:** Leverage SDK-specific features that weren't possible with `child_process`.

### Tasks

#### 4.1 Add Trade Interception Hooks

Use `PreToolUse` hooks to intercept trades before execution:

```typescript
hooks: {
  PreToolUse: [{
    matcher: "mcp__broker-alpaca__place_order",
    hooks: [async (input) => {
      // Log trade attempt
      await logTradeAttempt(fundName, input.tool_input);
      // Send Telegram alert before execution
      await sendTelegramNotification(`🔔 Trade: ${JSON.stringify(input.tool_input)}`);
      // Validate against fund constraints
      const valid = await validateTradeConstraints(fundName, input.tool_input);
      if (!valid.ok) {
        return { decision: "block", message: valid.reason };
      }
      return {};  // Allow
    }]
  }]
}
```

This means trades are validated and notified **before** execution, not after.

#### 4.2 Add `canUseTool` Permission Callback

Custom permission logic per fund:

```typescript
canUseTool: async (toolName, input) => {
  // Protect fund config from modification during sessions
  if (toolName === "Write" && input.file_path?.includes("fund_config.yaml")) {
    return { behavior: "deny", message: "Cannot modify fund config during session" };
  }
  // Allow everything else
  return { behavior: "allow", updatedInput: input };
}
```

#### 4.3 Add Session Cost Dashboard

New CLI command `fundx costs` to show cost analytics:

```bash
fundx costs                    # Summary of all session costs
fundx costs --fund runway      # Per-fund breakdown
fundx costs --period week      # Time-based view
```

Reads from enhanced session logs that now contain `cost_usd`, `tokens_in`, `tokens_out`.

#### 4.4 Add Streaming Progress to CLI

During `fundx session run`, show real-time progress:

```typescript
const result = await runAgentQuery({
  fundName,
  prompt,
  onMessage: (message) => {
    if (message.type === "assistant") {
      // Update spinner with what Claude is doing
      spinner.text = `Analyzing... (turn ${turnCount})`;
    }
    if (message.type === "assistant" && hasToolUse(message, "mcp__broker-alpaca__place_order")) {
      spinner.text = `Executing trade...`;
    }
  }
});
```

#### 4.5 Add Budget Controls to Fund Config

```yaml
# fund_config.yaml — new field
claude:
  model: "sonnet"
  max_budget_per_session_usd: 5.0
  max_budget_per_subagent_usd: 2.0
```

### Deliverables
- Trade interception hooks (validate + notify before execution)
- `canUseTool` permission callback
- `fundx costs` command
- Streaming progress in CLI
- Per-fund budget configuration

### Estimated Scope
- **Files modified:** 3-4 (`agent.ts`, `session.ts`, `types.ts`, new `costs.ts`)
- **Files created:** 1 (`costs.ts`)
- **Risk:** Low (additive features, no breaking changes)

---

## Phase 5 — In-Process MCP Servers (Session 6)

**Goal:** Convert external MCP servers from stdio subprocesses to in-process SDK tool definitions for lower latency and better integration.

### Tasks

#### 5.1 Evaluate Which Servers to Convert

| Server | Convert to In-Process? | Reason |
|--------|----------------------|--------|
| `broker-alpaca` | Yes | High-frequency calls, latency matters |
| `market-data` | Yes | High-frequency calls, latency matters |
| `telegram-notify` | No | Low frequency, keep as stdio for isolation |

#### 5.2 Create In-Process Broker Tools

```typescript
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const getAccount = tool(
  "get_account",
  "Get current account info including buying power and equity",
  {},
  async () => {
    const account = await alpacaClient.getAccount();
    return { content: [{ type: "text", text: JSON.stringify(account) }] };
  }
);

const placeOrder = tool(
  "place_order",
  "Place a buy or sell order",
  {
    symbol: z.string(),
    qty: z.number(),
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit", "stop", "stop_limit"]),
    limit_price: z.number().optional(),
    stop_price: z.number().optional(),
  },
  async (args) => {
    const order = await alpacaClient.placeOrder(args);
    return { content: [{ type: "text", text: JSON.stringify(order) }] };
  }
);

export const brokerServer = createSdkMcpServer({
  name: "broker-alpaca",
  version: "1.0.0",
  tools: [getAccount, getPositions, placeOrder, cancelOrder, getOrders, getQuote, getBars, getSnapshot],
});
```

#### 5.3 Create In-Process Market Data Tools

Similar pattern for market-data tools (get_latest_trade, get_bars, get_news, etc.).

#### 5.4 Update `buildMcpServers()` in `agent.ts`

```typescript
export async function buildMcpServers(fundName: string) {
  // In-process servers (fast, zero IPC overhead)
  const servers: Record<string, any> = {
    "broker-alpaca": createBrokerServer(fundName),
    "market-data": createMarketDataServer(fundName),
  };

  // Stdio server (for isolation)
  if (telegramEnabled) {
    servers["telegram-notify"] = { command: "node", args: [...], env: {...} };
  }

  return servers;
}
```

#### 5.5 Deprecate External MCP Server Files

Keep `src/mcp/broker-alpaca.ts` and `src/mcp/market-data.ts` as reference but mark them as deprecated. The in-process versions in `src/agent.ts` (or a new `src/mcp-inprocess.ts`) replace them.

### Deliverables
- In-process broker-alpaca MCP server
- In-process market-data MCP server
- Lower latency for tool calls
- External stdio servers kept for telegram-notify

### Estimated Scope
- **Files created:** 1-2 (`src/mcp-inprocess.ts` or embedded in `agent.ts`)
- **Files modified:** 1 (`agent.ts`)
- **Risk:** Medium (rewriting MCP tool handlers — needs thorough testing against Alpaca API)

---

## Phase 6 — Advanced Patterns (Session 7)

**Goal:** Implement advanced SDK patterns for optimal performance and intelligence.

### Tasks

#### 6.1 Model Routing

Use different models for different tasks based on complexity:

```typescript
// In agent.ts — model routing helper
export function selectModel(task: "query" | "analysis" | "decision" | "subagent"): string {
  switch (task) {
    case "query": return "haiku";      // Simple Q&A — fast and cheap
    case "analysis": return "sonnet";   // Sub-agent analysis — balanced
    case "decision": return "sonnet";   // Trading decisions — capable
    case "subagent": return "haiku";    // Focused sub-agents — fast
  }
}
```

Apply in:
- `ask.ts` → Haiku for simple questions, Sonnet for complex analysis
- `subagent.ts` → Haiku for focused sub-agents
- `session.ts` → Sonnet for trading sessions
- `gateway.ts` → Haiku for Telegram questions

#### 6.2 Session Resumption for Multi-Turn Conversations

For Telegram conversations, maintain session context:

```typescript
// Track session IDs per fund per chat
const activeSessions = new Map<string, string>(); // fundName → sessionId

async function wakeClaudeForQuestion(ctx, fundName, question) {
  const existingSessionId = activeSessions.get(fundName);

  const result = await runAgentQuery({
    fundName,
    prompt: question,
    resume: existingSessionId,  // Continue existing conversation
  });

  activeSessions.set(fundName, result.sessionId);  // Save for next message
}
```

#### 6.3 Programmatic Sub-Agents via `agents` Option

Instead of manually running parallel queries, use SDK's built-in sub-agent system:

```typescript
const result = await query({
  prompt: sessionPrompt,
  options: {
    agents: {
      "macro-analyst": {
        description: "Analyze macroeconomic conditions. Use for Fed policy, rates, GDP analysis.",
        prompt: macroPrompt,
        tools: ["Read", "Grep", "Glob", "mcp__market-data__*"],
        model: "haiku",
      },
      "technical-analyst": {
        description: "Analyze price action and technicals. Use for chart patterns and indicators.",
        prompt: technicalPrompt,
        tools: ["Read", "Grep", "Glob", "mcp__market-data__*"],
        model: "haiku",
      },
      "risk-manager": {
        description: "Assess portfolio risk and validate constraints.",
        prompt: riskPrompt,
        tools: ["Read", "Grep", "Glob", "mcp__broker-alpaca__*"],
        model: "haiku",
      },
    },
  },
});
```

The orchestrator (main agent, running on Sonnet) decides when to invoke each sub-agent. This is more dynamic than the current fixed parallel pattern.

**Trade-off:** Less control over exactly when sub-agents run, but more intelligent orchestration.

#### 6.4 Prompt Caching Optimization

Fund constitutions (CLAUDE.md) don't change between sessions. Structure prompts to maximize cache hits:

```typescript
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: fundConstitution,  // Static per-fund — will be cached
}
// Dynamic prompt goes in the user message
```

### Deliverables
- Model routing based on task complexity
- Session resumption for Telegram conversations
- Programmatic sub-agents via `agents` option
- Prompt caching optimization

### Estimated Scope
- **Files modified:** 4-5 (`agent.ts`, `session.ts`, `subagent.ts`, `gateway.ts`, `ask.ts`)
- **Risk:** Medium (architectural changes to sub-agent orchestration)

---

## Migration Checklist

| Phase | Scope | Risk | Dependencies |
|-------|-------|------|-------------|
| **0: Foundation** | Install SDK, create wrapper, update types | Zero | None |
| **1: Core Sessions** | Migrate `runFundSession` + `runAsk` | Low | Phase 0 |
| **2: Sub-Agents** | Migrate parallel sub-agents, add structured outputs | Medium | Phase 1 |
| **3: Gateway & Cleanup** | Migrate Telegram, remove `child_process` | Low | Phase 2 |
| **4: Hooks & Features** | Trade interception, costs, streaming | Low | Phase 3 |
| **5: In-Process MCP** | Convert broker/market-data to in-process | Medium | Phase 3 |
| **6: Advanced** | Model routing, session resume, programmatic agents | Medium | Phase 4 |

## File Impact Summary

| File | Phase | Change |
|------|-------|--------|
| `package.json` | 0 | Add `@anthropic-ai/claude-agent-sdk` |
| **`src/agent.ts`** | **0** | **Create — central SDK wrapper** |
| `src/types.ts` | 0, 2 | Add SDK result types, structured output schemas |
| `src/config.ts` | 0, 3 | Deprecate `claude_path`, add `max_budget_usd` |
| `src/session.ts` | 1, 2 | Replace `execFileAsync` → `runAgentQuery` |
| `src/ask.ts` | 1 | Replace `execFileAsync` → `runAgentQuery` |
| `src/subagent.ts` | 2 | Replace `execFileAsync` → `runAgentQuery`, add structured outputs |
| `src/gateway.ts` | 3 | Replace `execFileAsync` → `runAgentQuery` |
| `src/mcp-config.ts` | 3 | Delete (replaced by `buildMcpServers` in `agent.ts`) |
| `src/daemon.ts` | 3 | No changes needed (calls already-migrated functions) |
| `src/costs.ts` | 4 | Create — cost analytics command |
| `src/mcp-inprocess.ts` | 5 | Create — in-process MCP tool definitions |
| `src/index.ts` | 4 | Register new `costs` command |

## Testing Strategy

Each phase should be verified with:

1. **Unit tests:** Mock `query()` from SDK, verify options passed correctly
2. **Integration test:** Run against a real fund with paper trading
3. **Cost verification:** Check session logs for cost/token data
4. **Regression:** Ensure CLI behavior identical to pre-migration

```bash
# After each phase:
pnpm typecheck
pnpm test
pnpm build
pnpm dev -- session run <test-fund> pre_market
pnpm dev -- ask "How is my portfolio?" --fund <test-fund>
```

## Authentication for Development

```bash
# Option 1: Max subscription (local/experimental)
claude setup-token
# Then set CLAUDE_CODE_OAUTH_TOKEN in your shell

# Option 2: API key (if available)
export ANTHROPIC_API_KEY=sk-ant-...
```

The SDK wrapper in `agent.ts` doesn't specify authentication — it relies on environment variables, so either method works transparently.
