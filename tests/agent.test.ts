import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Tests for src/agent.ts — the core Agent SDK wrapper.
 *
 * We mock:
 * - @anthropic-ai/claude-agent-sdk (the SDK query function)
 * - ../src/config.js (global config)
 * - ../src/fund.js (fund config)
 *
 * We test:
 * - buildMcpServers: env var assembly, conditional telegram-notify
 * - runAgentQuery: model resolution, timeout, message iteration, error handling
 */

// ── Mock data ─────────────────────────────────────────────────

const WORKSPACE = join(homedir(), ".fundx");

const makeGlobalConfig = (overrides: Record<string, unknown> = {}) => ({
  default_model: "sonnet",
  timezone: "America/New_York",
  broker: {
    provider: "alpaca",
    api_key: "ak-test-123",
    secret_key: "sk-test-456",
    mode: "paper",
  },
  telegram: {
    bot_token: "",
    chat_id: "",
  },
  max_budget_usd: 10,
  ...overrides,
});

const makeFundConfig = (overrides: Record<string, unknown> = {}) => ({
  fund: { name: "test-fund", display_name: "Test Fund", status: "active" },
  capital: { initial: 50000, currency: "USD" },
  objective: { type: "runway", target_months: 18, monthly_burn: 2500 },
  risk: { profile: "conservative" },
  universe: { allowed: [] },
  schedule: { sessions: {} },
  broker: { provider: "alpaca", mode: "paper" },
  claude: { model: "sonnet", personality: "Test" },
  notifications: {
    telegram: { enabled: false },
    quiet_hours: { enabled: false, start: "22:00", end: "07:00" },
  },
  ...overrides,
});

// ── SDK mock setup ────────────────────────────────────────────

// We'll store messages to yield from the mock query generator
let mockMessages: Array<Record<string, unknown>> = [];
let capturedQueryParams: Record<string, unknown> | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  class AbortError extends Error {
    constructor(message = "The operation was aborted") {
      super(message);
      this.name = "AbortError";
    }
  }
  return {
    AbortError,
    query: vi.fn((params: Record<string, unknown>) => {
      capturedQueryParams = params;
      // Return an async iterable
      return {
        [Symbol.asyncIterator]: async function* () {
          for (const msg of mockMessages) {
            yield msg;
          }
        },
      };
    }),
  };
});

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn(),
}));

vi.mock("../src/fund.js", () => ({
  loadFundConfig: vi.fn(),
}));

// Import after mocks
import { buildMcpServers, runAgentQuery } from "../src/agent.js";
import { loadGlobalConfig } from "../src/config.js";
import { loadFundConfig } from "../src/fund.js";
import { MCP_SERVERS } from "../src/paths.js";

const mockedGlobalConfig = vi.mocked(loadGlobalConfig);
const mockedFundConfig = vi.mocked(loadFundConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockMessages = [];
  capturedQueryParams = null;
  mockedGlobalConfig.mockResolvedValue(makeGlobalConfig() as never);
  mockedFundConfig.mockResolvedValue(makeFundConfig() as never);
});

// ── buildMcpServers ───────────────────────────────────────────

describe("buildMcpServers", () => {
  it("returns broker-alpaca and market-data by default", async () => {
    const servers = await buildMcpServers("test-fund");

    expect(Object.keys(servers)).toEqual(["broker-alpaca", "market-data"]);
    expect(servers["broker-alpaca"].command).toBe("node");
    expect(servers["broker-alpaca"].args).toEqual([MCP_SERVERS.brokerAlpaca]);
    expect(servers["market-data"].command).toBe("node");
    expect(servers["market-data"].args).toEqual([MCP_SERVERS.marketData]);
  });

  it("passes Alpaca credentials to broker env", async () => {
    const servers = await buildMcpServers("test-fund");

    expect(servers["broker-alpaca"].env.ALPACA_API_KEY).toBe("ak-test-123");
    expect(servers["broker-alpaca"].env.ALPACA_SECRET_KEY).toBe("sk-test-456");
    expect(servers["broker-alpaca"].env.ALPACA_MODE).toBe("paper");
  });

  it("omits API key env vars when credentials are empty", async () => {
    mockedGlobalConfig.mockResolvedValue(
      makeGlobalConfig({
        broker: { provider: "alpaca", api_key: "", secret_key: "", mode: "paper" },
      }) as never,
    );

    const servers = await buildMcpServers("test-fund");

    expect(servers["broker-alpaca"].env.ALPACA_API_KEY).toBeUndefined();
    expect(servers["broker-alpaca"].env.ALPACA_SECRET_KEY).toBeUndefined();
    expect(servers["broker-alpaca"].env.ALPACA_MODE).toBe("paper");
  });

  it("includes telegram-notify when Telegram is fully configured", async () => {
    mockedGlobalConfig.mockResolvedValue(
      makeGlobalConfig({
        telegram: { bot_token: "bot123:ABC", chat_id: "999" },
      }) as never,
    );
    mockedFundConfig.mockResolvedValue(
      makeFundConfig({
        notifications: {
          telegram: { enabled: true },
          quiet_hours: { enabled: false, start: "22:00", end: "07:00" },
        },
      }) as never,
    );

    const servers = await buildMcpServers("test-fund");

    expect(Object.keys(servers)).toContain("telegram-notify");
    expect(servers["telegram-notify"].env.TELEGRAM_BOT_TOKEN).toBe("bot123:ABC");
    expect(servers["telegram-notify"].env.TELEGRAM_CHAT_ID).toBe("999");
  });

  it("excludes telegram-notify when fund notifications disabled", async () => {
    mockedGlobalConfig.mockResolvedValue(
      makeGlobalConfig({
        telegram: { bot_token: "bot123:ABC", chat_id: "999" },
      }) as never,
    );
    // Fund has telegram disabled (default)
    const servers = await buildMcpServers("test-fund");

    expect(Object.keys(servers)).not.toContain("telegram-notify");
  });

  it("includes quiet hours env vars when enabled", async () => {
    mockedGlobalConfig.mockResolvedValue(
      makeGlobalConfig({
        telegram: { bot_token: "bot123:ABC", chat_id: "999" },
      }) as never,
    );
    mockedFundConfig.mockResolvedValue(
      makeFundConfig({
        notifications: {
          telegram: { enabled: true },
          quiet_hours: { enabled: true, start: "23:00", end: "08:00" },
        },
      }) as never,
    );

    const servers = await buildMcpServers("test-fund");

    expect(servers["telegram-notify"].env.QUIET_HOURS_START).toBe("23:00");
    expect(servers["telegram-notify"].env.QUIET_HOURS_END).toBe("08:00");
  });

  it("uses fund broker mode over global broker mode", async () => {
    mockedFundConfig.mockResolvedValue(
      makeFundConfig({
        broker: { provider: "alpaca", mode: "live" },
      }) as never,
    );

    const servers = await buildMcpServers("test-fund");

    expect(servers["broker-alpaca"].env.ALPACA_MODE).toBe("live");
  });
});

// ── runAgentQuery ─────────────────────────────────────────────

describe("runAgentQuery", () => {
  it("returns successful result from SDK", async () => {
    mockMessages = [
      {
        type: "system",
        subtype: "init",
        session_id: "sess-init-123",
        tools: [],
        mcp_servers: [],
        cwd: "/tmp",
        apiKeySource: "user",
        claude_code_version: "1.0.0",
      },
      {
        type: "result",
        subtype: "success",
        result: "Analysis complete. Market is bullish.",
        total_cost_usd: 0.05,
        num_turns: 5,
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 2000,
            outputTokens: 800,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.05,
            contextWindow: 200000,
            maxOutputTokens: 16384,
          },
        },
        session_id: "sess-result-456",
        duration_ms: 3000,
        duration_api_ms: 2500,
        is_error: false,
        stop_reason: "end_turn",
        usage: { inputTokens: 2000, outputTokens: 800 },
        permission_denials: [],
        uuid: "00000000-0000-0000-0000-000000000000",
      },
    ];

    const result = await runAgentQuery({
      fundName: "test-fund",
      prompt: "Analyze market conditions",
    });

    expect(result.status).toBe("success");
    expect(result.output).toBe("Analysis complete. Market is bullish.");
    expect(result.cost_usd).toBe(0.05);
    expect(result.num_turns).toBe(5);
    expect(result.session_id).toBe("sess-result-456");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.usage["claude-sonnet-4-6"].inputTokens).toBe(2000);
    expect(result.error).toBeUndefined();
  });

  it("resolves model: options.model > fund config > global config > 'sonnet'", async () => {
    // Case 1: explicit model override
    mockMessages = [];
    await runAgentQuery({
      fundName: "test-fund",
      prompt: "test",
      model: "opus",
    });
    expect(capturedQueryParams?.options).toMatchObject({ model: "opus" });

    // Case 2: fund config model (no explicit override)
    mockedFundConfig.mockResolvedValue(
      makeFundConfig({ claude: { model: "haiku" } }) as never,
    );
    await runAgentQuery({ fundName: "test-fund", prompt: "test" });
    expect(capturedQueryParams?.options).toMatchObject({ model: "haiku" });

    // Case 3: global default model (no fund or explicit)
    mockedFundConfig.mockResolvedValue(
      makeFundConfig({ claude: {} }) as never,
    );
    mockedGlobalConfig.mockResolvedValue(
      makeGlobalConfig({ default_model: "opus" }) as never,
    );
    await runAgentQuery({ fundName: "test-fund", prompt: "test" });
    expect(capturedQueryParams?.options).toMatchObject({ model: "opus" });

    // Case 4: final fallback is "sonnet"
    mockedGlobalConfig.mockResolvedValue(
      makeGlobalConfig({ default_model: undefined }) as never,
    );
    await runAgentQuery({ fundName: "test-fund", prompt: "test" });
    expect(capturedQueryParams?.options).toMatchObject({ model: "sonnet" });
  });

  it("passes correct SDK options (permissionMode, systemPrompt, cwd)", async () => {
    mockMessages = [];

    await runAgentQuery({
      fundName: "test-fund",
      prompt: "test prompt",
      maxTurns: 25,
      maxBudgetUsd: 5.0,
    });

    expect(capturedQueryParams?.prompt).toBe("test prompt");
    const opts = capturedQueryParams?.options as Record<string, unknown>;
    expect(opts.maxTurns).toBe(25);
    expect(opts.maxBudgetUsd).toBe(5.0);
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(opts.settingSources).toEqual(["project"]);
    expect(opts.cwd).toBe(join(WORKSPACE, "funds", "test-fund"));
  });

  it("defaults maxTurns to 50 when not provided", async () => {
    mockMessages = [];
    await runAgentQuery({ fundName: "test-fund", prompt: "test" });

    const opts = capturedQueryParams?.options as Record<string, unknown>;
    expect(opts.maxTurns).toBe(50);
  });

  it("uses global max_budget_usd when no per-query budget specified", async () => {
    mockMessages = [];
    await runAgentQuery({ fundName: "test-fund", prompt: "test" });

    const opts = capturedQueryParams?.options as Record<string, unknown>;
    expect(opts.maxBudgetUsd).toBe(10); // from makeGlobalConfig
  });

  it("captures session_id from init message", async () => {
    mockMessages = [
      {
        type: "system",
        subtype: "init",
        session_id: "early-session-id",
        tools: [],
        mcp_servers: [],
        cwd: "/tmp",
        apiKeySource: "user",
        claude_code_version: "1.0.0",
      },
      {
        type: "result",
        subtype: "success",
        result: "done",
        total_cost_usd: 0.01,
        num_turns: 1,
        modelUsage: {},
        session_id: "result-session-id",
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        stop_reason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50 },
        permission_denials: [],
        uuid: "00000000-0000-0000-0000-000000000000",
      },
    ];

    const result = await runAgentQuery({
      fundName: "test-fund",
      prompt: "test",
    });

    // Result's session_id should be from the result message (overwrites init)
    expect(result.session_id).toBe("result-session-id");
  });

  it("handles error_max_turns result subtype", async () => {
    mockMessages = [
      {
        type: "result",
        subtype: "error_max_turns",
        total_cost_usd: 0.08,
        num_turns: 50,
        modelUsage: {},
        session_id: "sess-max-turns",
        errors: ["Exceeded maximum turns"],
        duration_ms: 10000,
        duration_api_ms: 9000,
        is_error: true,
        stop_reason: null,
        usage: { inputTokens: 5000, outputTokens: 2000 },
        permission_denials: [],
        uuid: "00000000-0000-0000-0000-000000000000",
      },
    ];

    const result = await runAgentQuery({
      fundName: "test-fund",
      prompt: "test",
    });

    expect(result.status).toBe("error_max_turns");
    expect(result.error).toBe("Exceeded maximum turns");
    expect(result.output).toBe("");
  });

  it("handles error_max_budget_usd result subtype", async () => {
    mockMessages = [
      {
        type: "result",
        subtype: "error_max_budget_usd",
        total_cost_usd: 5.0,
        num_turns: 20,
        modelUsage: {},
        session_id: "sess-budget",
        errors: ["Budget exceeded"],
        duration_ms: 5000,
        duration_api_ms: 4000,
        is_error: true,
        stop_reason: null,
        usage: { inputTokens: 10000, outputTokens: 5000 },
        permission_denials: [],
        uuid: "00000000-0000-0000-0000-000000000000",
      },
    ];

    const result = await runAgentQuery({
      fundName: "test-fund",
      prompt: "test",
    });

    expect(result.status).toBe("error_max_budget");
    expect(result.error).toBe("Budget exceeded");
  });

  it("handles thrown errors from SDK query", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockReturnValueOnce({
      [Symbol.asyncIterator]: async function* () {
        throw new Error("Network connection failed");
      },
    } as never);

    const result = await runAgentQuery({
      fundName: "test-fund",
      prompt: "test",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("Network connection failed");
    expect(result.output).toBe("");
  });

  it("invokes onMessage callback for each SDK message", async () => {
    const messages: Array<Record<string, unknown>> = [];
    mockMessages = [
      { type: "system", subtype: "init", session_id: "s1", tools: [], mcp_servers: [], cwd: "/tmp", apiKeySource: "user", claude_code_version: "1.0.0" },
      { type: "result", subtype: "success", result: "ok", total_cost_usd: 0.01, num_turns: 1, modelUsage: {}, session_id: "s2", duration_ms: 100, duration_api_ms: 80, is_error: false, stop_reason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 }, permission_denials: [], uuid: "00000000-0000-0000-0000-000000000000" },
    ];

    await runAgentQuery({
      fundName: "test-fund",
      prompt: "test",
      onMessage: (msg) => messages.push(msg as Record<string, unknown>),
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe("system");
    expect(messages[1].type).toBe("result");
  });

  it("injects MCP servers into SDK query options", async () => {
    mockMessages = [];

    await runAgentQuery({ fundName: "test-fund", prompt: "test" });

    const opts = capturedQueryParams?.options as Record<string, unknown>;
    const mcpServers = opts.mcpServers as Record<string, unknown>;
    expect(mcpServers).toHaveProperty("broker-alpaca");
    expect(mcpServers).toHaveProperty("market-data");
  });

  it("handles error subtype with no errors array (fallback to subtype string)", async () => {
    mockMessages = [
      {
        type: "result",
        subtype: "error_during_execution",
        total_cost_usd: 0.02,
        num_turns: 3,
        modelUsage: {},
        session_id: "sess-err",
        errors: [],
        duration_ms: 2000,
        duration_api_ms: 1500,
        is_error: true,
        stop_reason: null,
        usage: { inputTokens: 500, outputTokens: 200 },
        permission_denials: [],
        uuid: "00000000-0000-0000-0000-000000000000",
      },
    ];

    const result = await runAgentQuery({
      fundName: "test-fund",
      prompt: "test",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("error_during_execution");
  });

  it("detects AbortError as timeout status", async () => {
    const { query, AbortError } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockReturnValueOnce({
      [Symbol.asyncIterator]: async function* () {
        throw new (AbortError as new (msg?: string) => Error)("The operation was aborted");
      },
    } as never);

    const result = await runAgentQuery({
      fundName: "test-fund",
      prompt: "test",
      timeoutMs: 1000,
    });

    expect(result.status).toBe("timeout");
    expect(result.error).toBe("Query timed out");
    expect(result.output).toBe("");
  });

  it("does not treat non-abort errors as timeout", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockReturnValueOnce({
      [Symbol.asyncIterator]: async function* () {
        throw new Error("API rate limit exceeded");
      },
    } as never);

    const result = await runAgentQuery({
      fundName: "test-fund",
      prompt: "test",
    });

    expect(result.status).toBe("error");
    expect(result.error).toBe("API rate limit exceeded");
  });
});
