import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Tests for src/services/session.service.ts — session runner that calls runAgentQuery.
 *
 * We mock:
 * - ../src/agent.js (runAgentQuery, buildMcpServers, SESSION_EXPIRED_PATTERN)
 * - ../src/services/fund.service.js (loadFundConfig)
 * - ../src/state.js (writeSessionLog, readActiveSession, writeActiveSession)
 * - ../src/subagent.js (buildAnalystAgents)
 * - node:fs/promises (for file writes)
 *
 * We test:
 * - runFundSession: prompt construction, model/timeout, session log writing
 */

const _WORKSPACE = join(homedir(), ".fundx");

// ── Mock setup ────────────────────────────────────────────────

const mockRunAgentQuery = vi.fn();
const mockWriteSessionLog = vi.fn();

vi.mock("../src/agent.js", () => ({
  runAgentQuery: (...args: unknown[]) => mockRunAgentQuery(...args),
  buildMcpServers: vi.fn(async () => ({})),
  SESSION_EXPIRED_PATTERN: /session.*(expired|not found|invalid)/i,
}));

vi.mock("../src/state.js", () => ({
  writeSessionLog: (...args: unknown[]) => mockWriteSessionLog(...args),
  readActiveSession: vi.fn().mockResolvedValue(null),
  writeActiveSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/subagent.js", () => ({
  buildAnalystAgents: vi.fn(() => ({
    "market-analyst": { description: "Market", prompt: "test", model: "sonnet" },
    "technical-analyst": { description: "Technical", prompt: "test", model: "sonnet" },
    "risk-guardian": { description: "Risk", prompt: "test", model: "sonnet" },
  })),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(async () => []),
  rm: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

const makeFundConfig = (sessionOverrides: Record<string, unknown> = {}) => ({
  fund: { name: "test-fund", display_name: "Test Fund", status: "active" },
  capital: { initial: 50000, currency: "USD" },
  objective: { type: "runway", target_months: 18, monthly_burn: 2500 },
  risk: { profile: "conservative" },
  universe: { preset: "sp500" },
  schedule: {
    sessions: {
      pre_market: {
        time: "09:00",
        enabled: true,
        focus: "Analyze overnight developments.",
        max_duration_minutes: 20,
        ...sessionOverrides,
      },
    },
  },
  broker: { mode: "paper" },
  claude: { model: "sonnet", personality: "Conservative." },
  notifications: {
    telegram: { enabled: false },
    quiet_hours: { enabled: false, start: "22:00", end: "07:00" },
  },
});

vi.mock("../src/services/fund.service.js", () => ({
  loadFundConfig: vi.fn(),
  saveFundConfig: vi.fn(),
  listFundNames: vi.fn(async () => ["test-fund"]),
}));

const mockReadCachedUniverse = vi.fn();
vi.mock("../src/services/universe.service.js", () => ({
  readCachedUniverse: (...args: unknown[]) => mockReadCachedUniverse(...args),
}));

import { runFundSession } from "../src/services/session.service.js";
import { loadFundConfig } from "../src/services/fund.service.js";

const mockedLoadFundConfig = vi.mocked(loadFundConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadFundConfig.mockResolvedValue(makeFundConfig() as never);
  mockReadCachedUniverse.mockResolvedValue(null);
  mockRunAgentQuery.mockResolvedValue({
    output: "Session complete. No trades.",
    cost_usd: 0.03,
    duration_ms: 4000,
    num_turns: 4,
    usage: {
      "claude-sonnet-4-6": {
        inputTokens: 1500,
        outputTokens: 600,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.03,
        contextWindow: 200000,
        maxOutputTokens: 16384,
      },
    },
    session_id: "sess-123",
    status: "success",
  });
  mockWriteSessionLog.mockResolvedValue(undefined);
});

// ── runFundSession ────────────────────────────────────────────

describe("runFundSession", () => {
  it("calls runAgentQuery with correct prompt and model", async () => {
    await runFundSession("test-fund", "pre_market");

    expect(mockRunAgentQuery).toHaveBeenCalledTimes(1);
    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.fundName).toBe("test-fund");
    expect(opts.prompt).toContain("pre_market session");
    expect(opts.prompt).toContain("Analyze overnight developments.");
    expect(opts.model).toBe("sonnet");
    expect(opts.maxTurns).toBe(50);
  });

  it("uses session max_duration_minutes for timeout", async () => {
    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    // 20 minutes * 60 * 1000 = 1_200_000
    expect(opts.timeoutMs).toBe(20 * 60 * 1000);
  });

  it("defaults timeout to 15 minutes when max_duration_minutes not set", async () => {
    mockedLoadFundConfig.mockResolvedValue(
      makeFundConfig({ max_duration_minutes: undefined }) as never,
    );

    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.timeoutMs).toBe(15 * 60 * 1000);
  });

  it("uses options.focus override when provided", async () => {
    await runFundSession("test-fund", "pre_market", {
      focus: "Custom focus: analyze AAPL earnings",
    });

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).toContain("Custom focus: analyze AAPL earnings");
    expect(opts.prompt).not.toContain("Analyze overnight developments.");
  });

  it("writes session log with SDK metadata", async () => {
    await runFundSession("test-fund", "pre_market");

    expect(mockWriteSessionLog).toHaveBeenCalledTimes(1);
    const [fundName, log] = mockWriteSessionLog.mock.calls[0];
    expect(fundName).toBe("test-fund");
    expect(log.fund).toBe("test-fund");
    expect(log.session_type).toBe("pre_market");
    expect(log.cost_usd).toBe(0.03);
    expect(log.tokens_in).toBe(1500);
    expect(log.tokens_out).toBe(600);
    expect(log.model_used).toBe("claude-sonnet-4-6");
    expect(log.num_turns).toBe(4);
    expect(log.session_id).toBe("sess-123");
    expect(log.status).toBe("success");
    expect(log.summary).toContain("Session complete");
    expect(log.started_at).toBeDefined();
    expect(log.ended_at).toBeDefined();
  });

  it("throws when session type not found in config", async () => {
    await expect(
      runFundSession("test-fund", "nonexistent_session"),
    ).rejects.toThrow("Session type 'nonexistent_session' not found");
  });

  it("sums tokens across multiple models in usage", async () => {
    mockRunAgentQuery.mockResolvedValue({
      output: "done",
      cost_usd: 0.10,
      duration_ms: 8000,
      num_turns: 10,
      usage: {
        "claude-sonnet-4-6": {
          inputTokens: 3000,
          outputTokens: 1000,
        },
        "claude-haiku-4-5": {
          inputTokens: 500,
          outputTokens: 200,
        },
      },
      session_id: "multi-model",
      status: "success",
    });

    await runFundSession("test-fund", "pre_market");

    const [, log] = mockWriteSessionLog.mock.calls[0];
    expect(log.tokens_in).toBe(3500); // 3000 + 500
    expect(log.tokens_out).toBe(1200); // 1000 + 200
  });

  it("passes empty model when claude.model is empty", async () => {
    mockedLoadFundConfig.mockResolvedValue(
      makeFundConfig() as never,
    );
    // Override with empty claude model
    const config = makeFundConfig();
    (config.claude as Record<string, unknown>).model = "";
    mockedLoadFundConfig.mockResolvedValue(config as never);

    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    // Empty string is falsy, so model should be undefined (let agent.ts resolve)
    expect(opts.model).toBeUndefined();
  });
});

// ── AgentDefinition integration ───────────────────────────────

describe("runFundSession with agents", () => {
  it("passes agents to runAgentQuery", async () => {
    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.agents).toBeDefined();
    expect(opts.agents["market-analyst"]).toBeDefined();
    expect(opts.agents["technical-analyst"]).toBeDefined();
    expect(opts.agents["risk-guardian"]).toBeDefined();
  });

  it("adds debate skills prompt when useDebateSkills is true", async () => {
    await runFundSession("test-fund", "pre_market", { useDebateSkills: true });

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).toContain("Investment Debate");
    expect(opts.prompt).toContain("Risk Assessment");
    expect(opts.prompt).toContain("thorough analysis");
  });

  it("does not add debate skills prompt by default", async () => {
    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).not.toContain("Investment Debate");
    expect(opts.prompt).not.toContain("thorough analysis");
  });

  it("prompt references session-init rule", async () => {
    await runFundSession("test-fund", "pre_market");
    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).toContain("session-init rule");
    expect(opts.prompt).toContain("Session Protocol");
  });
});

// ── fund_universe block in session prompt ─────────────────────

describe("runFundSession — fund_universe block", () => {
  it("includes <fund_universe> block when cached resolution exists", async () => {
    mockReadCachedUniverse.mockResolvedValue({
      resolved_at: 1_744_000_000_000,
      config_hash: "abc123",
      resolved_from: "fmp",
      source: { kind: "preset", preset: "sp500" },
      base_tickers: ["AAPL", "MSFT"],
      final_tickers: ["AAPL", "MSFT"],
      include_applied: [],
      exclude_tickers_applied: [],
      exclude_sectors_applied: [],
      exclude_tickers_config: [],
      exclude_sectors_config: [],
      count: 2,
    });

    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).toContain("<fund_universe>");
    expect(opts.prompt).toContain("count: 2");
    expect(opts.prompt).toContain("source: preset:sp500");
    expect(opts.prompt).toContain("resolved_from: fmp");
    expect(opts.prompt).toContain("</fund_universe>");
  });

  it("omits <fund_universe> block when no cached resolution", async () => {
    mockReadCachedUniverse.mockResolvedValue(null);

    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).not.toContain("<fund_universe>");
  });

  it("adds freshness_warning when resolved_from is stale_cache", async () => {
    mockReadCachedUniverse.mockResolvedValue({
      resolved_at: 1_744_000_000_000,
      config_hash: "abc123",
      resolved_from: "stale_cache",
      source: { kind: "preset", preset: "nasdaq100" },
      base_tickers: ["AAPL"],
      final_tickers: ["AAPL"],
      include_applied: [],
      exclude_tickers_applied: [],
      exclude_sectors_applied: [],
      exclude_tickers_config: [],
      exclude_sectors_config: [],
      count: 1,
    });

    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).toContain("freshness_warning");
    expect(opts.prompt).toContain("stale_cache");
  });

  it("includes excluded_tickers and excluded_sectors when present", async () => {
    mockReadCachedUniverse.mockResolvedValue({
      resolved_at: 1_744_000_000_000,
      config_hash: "abc123",
      resolved_from: "fmp",
      source: { kind: "preset", preset: "sp500" },
      base_tickers: ["AAPL", "TSLA"],
      final_tickers: ["AAPL"],
      include_applied: [],
      exclude_tickers_applied: ["TSLA"],
      exclude_sectors_applied: [],
      exclude_tickers_config: ["TSLA"],
      exclude_sectors_config: ["Energy"],
      count: 1,
    });

    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).toContain("excluded_tickers: [TSLA]");
    expect(opts.prompt).toContain("excluded_sectors: [Energy]");
  });
});
