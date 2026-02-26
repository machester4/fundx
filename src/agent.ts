import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKResultMessage,
  ModelUsage,
  AgentDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { loadGlobalConfig } from "./config.js";
import { loadFundConfig } from "./fund.js";
import { fundPaths, MCP_SERVERS } from "./paths.js";

// ── Types ────────────────────────────────────────────────────

/** Options for running a Claude Agent SDK query scoped to a fund */
export interface AgentQueryOptions {
  /** Fund name (used to resolve config, paths, MCP servers) */
  fundName: string;
  /** The prompt to send to Claude */
  prompt: string;
  /** Claude model override (defaults to fund → global → "sonnet") */
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
  status: "success" | "error_max_turns" | "error_max_budget" | "timeout" | "error";
  /** Error message if status is not "success" */
  error?: string;
}

// ── MCP Server Configuration ────────────────────────────────

/** MCP stdio server config shape (matches SDK's McpStdioServerConfig) */
interface McpStdioConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Build MCP server configuration for a fund.
 *
 * Returns MCP server config programmatically for the Agent SDK query.
 */
export async function buildMcpServers(
  fundName: string,
): Promise<Record<string, McpStdioConfig>> {
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(fundName);

  const brokerEnv: Record<string, string> = {};
  if (globalConfig.broker.api_key)
    brokerEnv.ALPACA_API_KEY = globalConfig.broker.api_key;
  if (globalConfig.broker.secret_key)
    brokerEnv.ALPACA_SECRET_KEY = globalConfig.broker.secret_key;
  brokerEnv.ALPACA_MODE =
    fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";

  const servers: Record<string, McpStdioConfig> = {
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
      telegramEnv.QUIET_HOURS_START =
        fundConfig.notifications.quiet_hours.start;
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
    "sonnet";

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

  try {
    for await (const message of query({
      prompt: options.prompt,
      options: {
        model,
        maxTurns: options.maxTurns ?? 50,
        maxBudgetUsd:
          options.maxBudgetUsd ?? globalConfig.max_budget_usd ?? undefined,
        cwd: paths.root,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["project"],
        mcpServers,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController,
        agents: options.agents,
      },
    })) {
      // Forward to optional callback
      options.onMessage?.(message);

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
  } catch (err) {
    if (err instanceof AbortError || (err instanceof Error && err.name === "AbortError")) {
      status = "timeout";
      error = "Query timed out";
    } else {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  return {
    output,
    cost_usd: costUsd,
    duration_ms: Date.now() - startTime,
    num_turns: numTurns,
    usage: modelUsage,
    session_id: sessionId,
    status,
    error,
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
