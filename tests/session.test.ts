import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Tests for src/session.ts — session runner that calls runAgentQuery.
 *
 * We mock:
 * - ../src/agent.js (runAgentQuery, buildMcpServers)
 * - ../src/services/fund.service.js (loadFundConfig)
 * - ../src/state.js (writeSessionLog)
 * - ../src/subagent.js (runSubAgents, etc.)
 * - node:fs/promises (for file writes)
 *
 * We test:
 * - runFundSession: prompt construction, model/timeout, session log writing
 * - runFundSessionWithSubAgents: sub-agent invocation, combined prompt, log
 */

const _WORKSPACE = join(homedir(), ".fundx");

// ── Mock setup ────────────────────────────────────────────────

const mockRunAgentQuery = vi.fn();
const mockWriteSessionLog = vi.fn();
const mockRunSubAgents = vi.fn();
const mockSaveSubAgentAnalysis = vi.fn();

vi.mock("../src/agent.js", () => ({
  runAgentQuery: (...args: unknown[]) => mockRunAgentQuery(...args),
  buildMcpServers: vi.fn(async () => ({})),
}));

vi.mock("../src/state.js", () => ({
  writeSessionLog: (...args: unknown[]) => mockWriteSessionLog(...args),
}));

vi.mock("../src/subagent.js", () => ({
  getDefaultSubAgents: vi.fn(() => [
    { type: "macro", name: "Macro Analyst", prompt: "test macro", max_turns: 10 },
    { type: "technical", name: "Technical Analyst", prompt: "test tech", max_turns: 10 },
  ]),
  buildAnalystAgents: vi.fn(() => ({
    "macro-analyst": { description: "Macro", prompt: "test", model: "haiku" },
    "technical-analyst": { description: "Technical", prompt: "test", model: "haiku" },
  })),
  runSubAgents: (...args: unknown[]) => mockRunSubAgents(...args),
  mergeSubAgentResults: vi.fn(() => "# Combined Analysis\nMACRO_SIGNAL: bullish"),
  saveSubAgentAnalysis: (...args: unknown[]) => mockSaveSubAgentAnalysis(...args),
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
  universe: { allowed: [] },
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
  broker: { provider: "alpaca", mode: "paper" },
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

import { runFundSession, runFundSessionWithSubAgents } from "../src/services/session.service.js";
import { loadFundConfig } from "../src/services/fund.service.js";

const mockedLoadFundConfig = vi.mocked(loadFundConfig);

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadFundConfig.mockResolvedValue(makeFundConfig() as never);
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
  mockRunSubAgents.mockResolvedValue([
    { type: "macro", name: "Macro Analyst", started_at: "2026-02-25T09:00:00Z", ended_at: "2026-02-25T09:02:00Z", status: "success", output: "Bullish outlook" },
    { type: "technical", name: "Technical Analyst", started_at: "2026-02-25T09:00:00Z", ended_at: "2026-02-25T09:01:30Z", status: "success", output: "Neutral signals" },
  ]);
  mockSaveSubAgentAnalysis.mockResolvedValue("/tmp/analysis.md");
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

// ── runFundSessionWithSubAgents ───────────────────────────────

describe("runFundSessionWithSubAgents", () => {
  it("runs sub-agents first, then main session with combined analysis", async () => {
    await runFundSessionWithSubAgents("test-fund", "pre_market");

    // Sub-agents should be called first
    expect(mockRunSubAgents).toHaveBeenCalledTimes(1);
    const [fundName, agents, opts] = mockRunSubAgents.mock.calls[0];
    expect(fundName).toBe("test-fund");
    expect(agents).toHaveLength(2); // macro + technical from mock
    expect(opts.timeoutMinutes).toBe(8);

    // Then main session should be called
    expect(mockRunAgentQuery).toHaveBeenCalledTimes(1);
    const queryOpts = mockRunAgentQuery.mock.calls[0][0];
    expect(queryOpts.prompt).toContain("Sub-Agent Analysis");
    expect(queryOpts.prompt).toContain("Combined Analysis");
    expect(queryOpts.prompt).toContain("MACRO_SIGNAL: bullish");
  });

  it("saves sub-agent analysis to file", async () => {
    await runFundSessionWithSubAgents("test-fund", "pre_market");

    expect(mockSaveSubAgentAnalysis).toHaveBeenCalledTimes(1);
    const [fundName, results, sessionType] = mockSaveSubAgentAnalysis.mock.calls[0];
    expect(fundName).toBe("test-fund");
    expect(results).toHaveLength(2);
    expect(sessionType).toBe("pre_market");
  });

  it("writes session log with parallel suffix and sub-agent counts", async () => {
    await runFundSessionWithSubAgents("test-fund", "pre_market");

    expect(mockWriteSessionLog).toHaveBeenCalledTimes(1);
    const [, log] = mockWriteSessionLog.mock.calls[0];
    expect(log.session_type).toBe("pre_market_parallel");
    expect(log.summary).toContain("Sub-agents: 2/2 OK");
    expect(log.analysis_file).toBe("/tmp/analysis.md");
    expect(log.cost_usd).toBe(0.03);
  });

  it("throws when session type not found", async () => {
    await expect(
      runFundSessionWithSubAgents("test-fund", "nonexistent"),
    ).rejects.toThrow("Session type 'nonexistent' not found");
  });

  it("counts failed sub-agents in summary", async () => {
    mockRunSubAgents.mockResolvedValue([
      { type: "macro", name: "Macro", started_at: "t0", ended_at: "t1", status: "success", output: "ok" },
      { type: "technical", name: "Technical", started_at: "t0", ended_at: "t1", status: "error", output: "", error: "timeout" },
    ]);

    await runFundSessionWithSubAgents("test-fund", "pre_market");

    const [, log] = mockWriteSessionLog.mock.calls[0];
    expect(log.summary).toContain("Sub-agents: 1/2 OK");
  });
});

// ── AgentDefinition integration ───────────────────────────────

describe("runFundSession with agents", () => {
  it("passes agents to runAgentQuery", async () => {
    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.agents).toBeDefined();
    expect(opts.agents["macro-analyst"]).toBeDefined();
    expect(opts.agents["technical-analyst"]).toBeDefined();
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
});
