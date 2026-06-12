import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKResultMessage,
  ModelUsage,
  AgentDefinition,
  McpSdkServerConfigWithInstance,
  HookEvent,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";
import { loadGlobalConfig } from "./config.js";
import { loadFundConfig } from "./services/fund.service.js";
import { fundPaths, MCP_SERVERS, MCP_COMMAND } from "./paths.js";
import { createMarketDataMcpServer } from "./mcp/market-data.js";

/** Matches Claude Agent SDK error messages for expired/invalid sessions (used in two places — keep in sync) */
export const SESSION_EXPIRED_PATTERN = /session.*(expired|not found|invalid)/i;

/** Claude subscription quota exhaustion ("You're out of extra usage · resets …").
 *  The SDK returns these as non-throwing `status: "error"` results with ~1 turn
 *  and $0 cost. Not matched: ordinary prose mentioning "usage of tools". */
export const QUOTA_EXHAUSTED_PATTERN = /out of (extra )?usage|usage limit/i;

/** Node.js error codes that indicate an MCP server subprocess crashed or lost its transport connection */
const TRANSPORT_ERROR_CODES = new Set(["EPIPE", "ECONNREFUSED", "ECONNRESET", "ENOENT"]);

function isMcpTransportError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code && TRANSPORT_ERROR_CODES.has(code)) return true;
  }
  return false;
}

// ── Types ────────────────────────────────────────────────────

/** Options for running a Claude Agent SDK query scoped to a fund */
export interface AgentQueryOptions {
  /** Fund name (used to resolve config, paths, MCP servers) */
  fundName: string;
  /** The prompt to send to Claude */
  prompt: string;
  /** Claude model override (defaults to fund → global → "claude-opus-4-8") */
  model?: string;
  /** Maximum conversation turns (default: 50) */
  maxTurns?: number;
  /** Maximum budget in USD — query stops if exceeded */
  maxBudgetUsd?: number;
  /** Timeout in milliseconds — aborts query via AbortController */
  timeoutMs?: number;
  /** Callback for each SDK message (streaming progress, logging, etc.) */
  onMessage?: (message: SDKMessage) => void;
  /** Sub-agent definitions available via the Task tool */
  agents?: Record<string, AgentDefinition>;
  /** Session ID to resume (from a previous chat or daemon session) */
  resumeSessionId?: string;
  /** PreToolUse / PostToolUse / Stop hooks (passed through to SDK).
   *  See sdk.d.ts:HookCallbackMatcher for shape. */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

/** Result from a Claude Agent SDK query */
export interface AgentQueryResult {
  /** Final text output from Claude */
  output: string;
  /** Total API cost in USD */
  cost_usd: number;
  /** Wall-clock duration in milliseconds */
  duration_ms: number;
  /** Number of conversation turns */
  num_turns: number;
  /** Per-model token usage breakdown */
  usage: Record<string, ModelUsage>;
  /** Session ID (can be used for resumption) */
  session_id: string;
  /** Outcome status */
  status: "success" | "error_max_turns" | "error_max_budget" | "timeout" | "error" | "watchdog_killed";
  /** Error message if status is not "success" */
  error?: string;
  /** Ordered list of tool invocations with elapsed time in seconds */
  toolHistory: Array<{ name: string; elapsed: number }>;
  /** Total input tokens across all models */
  tokens_in: number;
  /** Total output tokens across all models */
  tokens_out: number;
}

// ── MCP Server Configuration ────────────────────────────────

/** MCP stdio server config shape (matches SDK's McpStdioServerConfig) */
interface McpStdioConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Mixed config: in-process (SDK) servers can coexist with stdio subprocesses in the same record */
type McpServerEntry = McpStdioConfig | McpSdkServerConfigWithInstance;

/**
 * Build MCP server configuration for a fund.
 *
 * `market-data` runs in-process so tools that touch the daemon's zvec news
 * cache (`get_rss_news`) share the same process handle — zvec 0.2.3 is
 * single-writer and rejects concurrent opens. Other servers stay stdio.
 */
export async function buildMcpServers(
  fundName: string,
): Promise<Record<string, McpServerEntry>> {
  const globalConfig = await loadGlobalConfig();
  const paths = fundPaths(fundName);

  // Build broker-local env
  const brokerLocalEnv: Record<string, string> = {
    FUND_DIR: paths.root,
    ...(globalConfig.market_data?.fmp_api_key
      ? { FMP_API_KEY: globalConfig.market_data.fmp_api_key }
      : {}),
  };

  const servers: Record<string, McpServerEntry> = {
    "broker-local": {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.brokerLocal],
      env: brokerLocalEnv,
    },
    "market-data": createMarketDataMcpServer({
      fmpApiKey: globalConfig.market_data?.fmp_api_key,
    }),
    screener: {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.screener],
      env: { ...process.env } as Record<string, string>,
    },
  };

  if (globalConfig.sws?.auth_token) {
    servers["sws"] = {
      command: MCP_COMMAND,
      args: [MCP_SERVERS.sws],
      env: { SWS_AUTH_TOKEN: globalConfig.sws.auth_token },
    };
  }

  return servers;
}

// ── Core Query Wrapper ──────────────────────────────────────

/**
 * Run a Claude Agent SDK query scoped to a fund.
 *
 * Single entry point for all autonomous Claude invocations across
 * session.ts, subagent.ts, ask.ts, and gateway.ts.
 *
 * Key behaviors:
 * - Loads fund config + global config for model/MCP resolution
 * - Uses Claude Code preset system prompt + per-fund CLAUDE.md via settingSources
 * - Bypasses permissions for autonomous execution
 * - Tracks cost, tokens, and session ID in the result
 * - Supports timeout via AbortController (returns "timeout" status)
 */
export async function runAgentQuery(
  options: AgentQueryOptions,
): Promise<AgentQueryResult> {
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(options.fundName);
  const paths = fundPaths(options.fundName);

  const model =
    options.model ??
    fundConfig.claude.model ??
    globalConfig.default_model ??
    "claude-opus-4-8";

  const mcpServers = await buildMcpServers(options.fundName);

  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs) {
    timeoutId = setTimeout(() => abortController.abort(), options.timeoutMs);
  }

  const startTime = Date.now();
  let output = "";
  let costUsd = 0;
  let numTurns = 0;
  let modelUsage: Record<string, ModelUsage> = {};
  let sessionId = "";
  let status: AgentQueryResult["status"] = "success";
  let error: string | undefined;

  // Tool history + token accumulators
  const toolHistory: Array<{ name: string; elapsed: number }> = [];
  let activeBlockType: "thinking" | "tool_use" | null = null;
  let activeToolName: string | null = null;
  let activeToolStartedAt: number | null = null;

  // Build a clean child-process environment that strips CLAUDECODE so that the
  // Agent SDK subprocess is not rejected as a "nested Claude Code session".
  // This matters when runAgentQuery is invoked from within an existing Claude
  // Code session (e.g. `fundx eval` or `fundx ask`) where CLAUDECODE=1 is set.
  const childEnv = { ...process.env } as Record<string, string>;
  delete childEnv["CLAUDECODE"];

  let attemptedMcpRetry = false;
  try {
    retryLoop: while (true) {
      // Reset all accumulators before each attempt so a retry starts clean
      output = "";
      costUsd = 0;
      numTurns = 0;
      modelUsage = {};
      sessionId = "";
      status = "success";
      error = undefined;
      toolHistory.length = 0;
      activeBlockType = null;
      activeToolName = null;
      activeToolStartedAt = null;

      try {
        for await (const message of query({
          prompt: options.prompt,
          options: {
            model,
            maxTurns: options.maxTurns ?? 50,
            maxBudgetUsd:
              options.maxBudgetUsd ?? globalConfig.max_budget_usd ?? undefined,
            cwd: paths.root,
            env: childEnv,
            systemPrompt: { type: "preset", preset: "claude_code" },
            settingSources: ["project"],
            // Required for the toolHistory accumulation below: the SDK only emits
            // stream_event messages when this is set. Without it, toolHistory is
            // silently always empty for every runAgentQuery caller (autonomous
            // sessions + ask). Chat sets it in its own loop (chat.service.ts).
            includePartialMessages: true,
            mcpServers,
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            abortController,
            agents: options.agents,
            ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
            ...(options.hooks ? { hooks: options.hooks } : {}),
          },
        })) {
          // Forward to optional callback
          options.onMessage?.(message);

          // Track tool invocations via stream events
          if (message.type === "stream_event") {
            const event = (message as { event?: unknown }).event as
              | { type?: string; content_block?: { type?: string; name?: string } }
              | undefined;
            if (event?.type === "content_block_start" && event.content_block?.type === "tool_use" && typeof event.content_block.name === "string") {
              activeBlockType = "tool_use";
              activeToolName = event.content_block.name;
              activeToolStartedAt = Date.now();
            } else if (event?.type === "content_block_stop" && activeBlockType === "tool_use") {
              if (activeToolName !== null && activeToolStartedAt !== null) {
                toolHistory.push({
                  name: activeToolName,
                  elapsed: (Date.now() - activeToolStartedAt) / 1000,
                });
              }
              activeBlockType = null;
              activeToolName = null;
              activeToolStartedAt = null;
            } else if (event?.type === "content_block_start" && event.content_block?.type === "thinking") {
              activeBlockType = "thinking";
            } else if (event?.type === "content_block_stop" && activeBlockType === "thinking") {
              activeBlockType = null;
            }
          }

          // Capture result metadata
          if (message.type === "result") {
            const result = message as SDKResultMessage;
            costUsd = result.total_cost_usd;
            numTurns = result.num_turns;
            modelUsage = result.modelUsage;
            sessionId = result.session_id;

            if (result.subtype === "success") {
              output = result.result;
            } else {
              status = mapResultSubtype(result.subtype);
              error = result.subtype;
              if ("errors" in result && result.errors?.length) {
                error = result.errors.join("; ");
              }
            }
          }

          // Capture session_id from init message
          if (
            message.type === "system" &&
            "subtype" in message &&
            message.subtype === "init"
          ) {
            sessionId = message.session_id;
          }
        }
        break retryLoop;
      } catch (err) {
        if (err instanceof AbortError || (err instanceof Error && err.name === "AbortError")) {
          status = "timeout";
          error = "Query timed out";
          break retryLoop;
        }
        if (
          isMcpTransportError(err) &&
          !attemptedMcpRetry &&
          costUsd === 0 &&
          numTurns === 0 &&
          toolHistory.length === 0
        ) {
          attemptedMcpRetry = true;
          console.warn(`[agent] MCP transport error (${(err as { code?: string }).code}); retrying once`);
          continue retryLoop;
        }
        status = "error";
        error = err instanceof Error ? err.message : String(err);
        break retryLoop;
      }
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  let tokensIn = 0;
  let tokensOut = 0;
  for (const u of Object.values(modelUsage) as Array<{ inputTokens?: number; outputTokens?: number }>) {
    tokensIn += u.inputTokens ?? 0;
    tokensOut += u.outputTokens ?? 0;
  }

  return {
    output,
    cost_usd: costUsd,
    duration_ms: Date.now() - startTime,
    num_turns: numTurns,
    usage: modelUsage,
    session_id: sessionId,
    status,
    ...(error !== undefined ? { error } : {}),
    toolHistory,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
  };
}

/** Map SDK result subtypes to our simplified status enum */
function mapResultSubtype(
  subtype: string,
): AgentQueryResult["status"] {
  switch (subtype) {
    case "success":
      return "success";
    case "error_max_turns":
      return "error_max_turns";
    case "error_max_budget_usd":
      return "error_max_budget";
    default:
      return "error";
  }
}
