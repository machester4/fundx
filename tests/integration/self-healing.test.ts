/**
 * Integration test: self-healing primitives (Phase 5a)
 *
 * Tests resilience primitives:
 *   1. MCP transport retry (5a.5): EPIPE first attempt → success on second
 *   2. Watchdog status enum smoke: "watchdog_killed" is a valid SessionLogV2 status
 *
 * Isolation strategy:
 *   - SDK `query` is mocked via vi.mock hoisting; the REAL runAgentQuery logic runs
 *   - config.js / fund.service.js / paths.js are mocked to avoid touching ~/.fundx
 *   - createMarketDataMcpServer is stubbed so no market-data MCP subprocess is launched
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock SDK query BEFORE any other imports (hoisted by vitest) ──────────────
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return { ...actual, query: vi.fn() };
});

// ── Mock config / fund service / paths to avoid real disk reads ──────────────
vi.mock("../../src/config.js", () => ({
  loadGlobalConfig: vi.fn(async () => ({
    default_model: "sonnet",
    max_budget_usd: undefined,
    telegram: { bot_token: "", chat_id: "" },
    market_data: { provider: "yfinance", fmp_api_key: undefined },
    sws: undefined,
    broker: { mode: "paper" },
  })),
  saveGlobalConfig: vi.fn(async () => {}),
}));

vi.mock("../../src/services/fund.service.js", () => ({
  loadFundConfig: vi.fn(async () => ({
    fund: {
      name: "fundx-audit",
      display_name: "Test Fund",
      description: "",
      created: "2026-01-01",
      status: "active",
    },
    capital: { initial: 10_000, currency: "USD" },
    objective: { type: "growth", target_multiple: 2 },
    risk: { profile: "moderate", max_drawdown_pct: 15, max_position_pct: 25 },
    universe: { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] },
    schedule: { sessions: {} },
    broker: { mode: "paper" },
    claude: { model: "sonnet" },
    notifications: {
      telegram: {
        enabled: false,
        trade_alerts: false,
        stop_loss_alerts: false,
        daily_digest: false,
        weekly_digest: false,
        milestone_alerts: false,
        drawdown_alerts: false,
      },
      quiet_hours: {
        enabled: false,
        start: "22:00",
        end: "08:00",
        allow_critical: true,
      },
    },
  })),
}));

vi.mock("../../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/paths.js")>(
    "../../src/paths.js",
  );
  return {
    ...actual,
    fundPaths: (name: string) => ({
      root: `/tmp/fundx-heal-test/${name}`,
      config: `/tmp/fundx-heal-test/${name}/fund_config.yaml`,
      claudeMd: `/tmp/fundx-heal-test/${name}/CLAUDE.md`,
      claudeDir: `/tmp/fundx-heal-test/${name}/.claude`,
      state: {
        dir: `/tmp/fundx-heal-test/${name}/state`,
        portfolio: `/tmp/fundx-heal-test/${name}/state/portfolio.json`,
        tracker: `/tmp/fundx-heal-test/${name}/state/objective_tracker.json`,
        journal: `/tmp/fundx-heal-test/${name}/state/trade_journal.sqlite`,
        sessionLog: `/tmp/fundx-heal-test/${name}/state/session_log.json`,
        sessionHandoff: `/tmp/fundx-heal-test/${name}/state/session-handoff.md`,
        sessionLogJsonl: `/tmp/fundx-heal-test/${name}/state/session_log.jsonl`,
        dailyCapState: `/tmp/fundx-heal-test/${name}/state/daily_cap_state.json`,
      },
    }),
  };
});

// ── Mock market-data MCP (in-process server; would try to open zvec store) ───
vi.mock("../../src/mcp/market-data.js", () => ({
  createMarketDataMcpServer: vi.fn(() => ({
    type: "sdk" as const,
    createInstance: () => ({ close: async () => {} }),
  })),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import * as sdk from "@anthropic-ai/claude-agent-sdk";

const { query } = sdk as unknown as { query: ReturnType<typeof vi.fn> };

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStream(messages: unknown[], throwAtStart?: Error) {
  return (async function* () {
    if (throwAtStart) throw throwAtStart;
    for (const m of messages) yield m;
  })();
}

const SUCCESS_MESSAGES = [
  {
    type: "system",
    subtype: "init",
    session_id: "s-heal",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "sonnet",
    permissionMode: "bypassPermissions",
  },
  {
    type: "result",
    subtype: "success",
    result: "ok",
    total_cost_usd: 0.01,
    num_turns: 1,
    modelUsage: {},
    session_id: "s-heal",
  },
];

// ── Test suite ────────────────────────────────────────────────────────────────

describe("integration: self-healing primitives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 1. MCP transport retry ────────────────────────────────────────────────

  it("MCP transport retry: EPIPE first attempt → success on second", async () => {
    const { runAgentQuery } = await import("../../src/agent.js");

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

    // First call throws EPIPE; second call yields success
    query
      .mockReturnValueOnce(makeStream([], epipe))
      .mockReturnValueOnce(makeStream(SUCCESS_MESSAGES));

    const r = await runAgentQuery({ fundName: "fundx-audit", prompt: "x" });

    expect(r.status).toBe("success");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("MCP transport retry: ECONNRESET first attempt → success on second", async () => {
    const { runAgentQuery } = await import("../../src/agent.js");

    const econnreset = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });

    query
      .mockReturnValueOnce(makeStream([], econnreset))
      .mockReturnValueOnce(makeStream(SUCCESS_MESSAGES));

    const r = await runAgentQuery({ fundName: "fundx-audit", prompt: "x" });

    expect(r.status).toBe("success");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("MCP transport retry: non-transport error is NOT retried", async () => {
    const { runAgentQuery } = await import("../../src/agent.js");

    const regular = new Error("something else broke");
    query.mockReturnValueOnce(makeStream([], regular));

    const r = await runAgentQuery({ fundName: "fundx-audit", prompt: "x" });

    expect(r.status).toBe("error");
    expect(query).toHaveBeenCalledTimes(1);
  });

  // ── 2. Watchdog status enum smoke ────────────────────────────────────────

  it("watchdog_killed is in the SessionLogV2 status enum", async () => {
    const { sessionLogV2Schema } = await import("../../src/types.js");

    const result = sessionLogV2Schema.safeParse({
      fund: "f",
      session_type: "mid_session",
      started_at: "2026-05-10T00:00:00Z",
      status: "watchdog_killed",
    });

    expect(result.success).toBe(true);
  });

  it("watchdog_killed is rejected by the old sessionLogSchema (pre-v2)", async () => {
    const { sessionLogSchema } = await import("../../src/types.js");

    const result = sessionLogSchema.safeParse({
      session_type: "mid_session",
      started_at: "2026-05-10T00:00:00Z",
      status: "watchdog_killed",
    });

    // The old schema does not include watchdog_killed in its enum
    expect(result.success).toBe(false);
  });
});
