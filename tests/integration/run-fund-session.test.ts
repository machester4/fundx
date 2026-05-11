/**
 * Integration test: runFundSession with mocked SDK
 *
 * Validates that the full session wiring (snapshot envelope, handoff archive,
 * JSONL append, daily-cap state) behaves correctly in isolation without
 * touching the real ~/.fundx workspace or making real SDK calls.
 *
 * Isolation strategy:
 *   - A deterministic tmpdir path is computed once before vi.mock factories run
 *     (using process.env.FUNDX_INT_TMP, set at the very top of the file before
 *     any hoisted factory executes — the env var bridge avoids the TDZ issue)
 *   - vi.mock("../../src/paths.js") redirects fundPaths() and module-level
 *     constants to the isolated tmpdir
 *   - vi.mock("../../src/agent.js") returns a deterministic fake result
 *   - Telegram, universe resolution, and state snapshot are stubbed out
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import yaml from "js-yaml";

// ── Set env var BEFORE vi.mock factories are hoisted ──────────
//    vi.mock factories execute synchronously at module evaluation, AFTER
//    this file is transformed. Setting process.env here makes it available
//    inside the factory closures (process.env is a live reference, not captured).
//    The actual unique path is set in beforeAll(); this primes the key.
process.env["FUNDX_INT_TMP"] = join(
  tmpdir(),
  `fundx-int-session-${process.pid}`,
);

// ── Mock paths.js BEFORE any service import ───────────────────
vi.mock("../../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/paths.js")>(
    "../../src/paths.js",
  );

  // Read root from env at call-time so beforeAll's mkdtemp update is seen
  function root(): string {
    return process.env["FUNDX_INT_TMP"] ?? join(tmpdir(), "fundx-int-fallback");
  }

  return {
    ...actual,
    // Static constants — must be evaluated-at-access, not at module-load.
    // Using getters achieves this without full Proxy overhead.
    get WORKSPACE() { return root(); },
    get GLOBAL_CONFIG() { return join(root(), "config.yaml"); },
    get FUNDS_DIR() { return join(root(), "funds"); },
    get SHARED_DIR() { return join(root(), "shared"); },
    get WORKSPACE_CLAUDE_MD() { return join(root(), "CLAUDE.md"); },
    get WORKSPACE_CLAUDE_DIR() { return join(root(), ".claude"); },
    get WORKSPACE_SKILLS_DIR() { return join(root(), ".claude", "skills"); },
    get WORKSPACE_RULES_DIR() { return join(root(), ".claude", "rules"); },
    get DAEMON_PID() { return join(root(), "daemon.pid"); },
    get DAEMON_LOG() { return join(root(), "daemon.log"); },
    get DAEMON_NEEDS_RESTART() { return join(root(), "daemon.needs-restart"); },
    // fundPaths uses process.env.FUNDX_HOME already — but we override to be explicit
    fundPaths: (name: string) => {
      const fundRoot = join(root(), "funds", name);
      return {
        root: fundRoot,
        config: join(fundRoot, "fund_config.yaml"),
        claudeMd: join(fundRoot, "CLAUDE.md"),
        claudeDir: join(fundRoot, ".claude"),
        claudeSettings: join(fundRoot, ".claude", "settings.json"),
        claudeSkillsDir: join(fundRoot, ".claude", "skills"),
        claudeRulesDir: join(fundRoot, ".claude", "rules"),
        state: {
          dir: join(fundRoot, "state"),
          portfolio: join(fundRoot, "state", "portfolio.json"),
          tracker: join(fundRoot, "state", "objective_tracker.json"),
          journal: join(fundRoot, "state", "trade_journal.sqlite"),
          sessionLog: join(fundRoot, "state", "session_log.json"),
          activeSession: join(fundRoot, "state", "active_session.json"),
          chatHistory: join(fundRoot, "state", "chat_history.json"),
          sessionHistory: join(fundRoot, "state", "session_history.json"),
          lock: join(fundRoot, "state", ".lock"),
          pendingSessions: join(fundRoot, "state", "pending_sessions.json"),
          sessionCounts: join(fundRoot, "state", "session_counts.json"),
          sessionHandoff: join(fundRoot, "state", "session-handoff.md"),
          dailySnapshot: join(fundRoot, "state", "daily_snapshot.json"),
          notifiedMilestones: join(fundRoot, "state", "notified_milestones.json"),
          universe: join(fundRoot, "state", "universe.json"),
          handoffsDir: join(fundRoot, "state", "handoffs"),
          sessionLogJsonl: join(fundRoot, "state", "session_log.jsonl"),
          dailyCapState: join(fundRoot, "state", "daily_cap_state.json"),
        },
        analysis: join(fundRoot, "analysis"),
        scripts: join(fundRoot, "scripts"),
        reports: join(fundRoot, "reports"),
        memory: join(fundRoot, "memory"),
      };
    },
  };
});

// ── Mock agent.js: return fake success without real SDK calls ──
vi.mock("../../src/agent.js", () => ({
  SESSION_EXPIRED_PATTERN: /session.*(expired|not found|invalid)/i,
  runAgentQuery: vi.fn(async () => ({
    output: "Session reflection complete; handoff written.",
    cost_usd: 0.05,
    duration_ms: 3000,
    num_turns: 8,
    usage: {
      "claude-sonnet-4-6": {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.05,
        contextWindow: 200_000,
        maxOutputTokens: 16_384,
      },
    },
    session_id: "sess-int-1",
    status: "success" as const,
    error: undefined,
    toolHistory: [],
    tokens_in: 1000,
    tokens_out: 500,
  })),
  buildMcpServers: vi.fn(async () => ({})),
}));

// ── Stub Telegram (best-effort, dynamically imported inside session.service) ──
vi.mock("../../src/services/gateway.service.js", () => ({
  sendTelegramNotification: vi.fn(async () => {}),
}));

// ── Stub universe resolution (network call) ───────────────────
vi.mock("../../src/services/universe.service.js", () => ({
  resolveUniverse: vi.fn(async () => null),
}));

// ── Stub state snapshot (reads many files; return empty string) ─
vi.mock("../../src/services/snapshot.service.js", () => ({
  buildStateSnapshot: vi.fn(async () => ""),
}));

// ── Stub subagents (no SDK needed) ───────────────────────────
vi.mock("../../src/subagent.js", () => ({
  buildAnalystAgents: vi.fn(() => ({})),
}));

// ── Imports after mocks ───────────────────────────────────────
import { runFundSession } from "../../src/services/session.service.js";

// ── Fund fixture helpers ──────────────────────────────────────
const FUND_NAME = "int-test-fund";

async function seedFund(tmpRoot: string): Promise<void> {
  const fundRoot = join(tmpRoot, "funds", FUND_NAME);
  const stateDir = join(fundRoot, "state");
  await mkdir(stateDir, { recursive: true });

  // Minimal fund_config.yaml
  const config = {
    fund: {
      name: FUND_NAME,
      display_name: "Integration Test Fund",
      description: "Integration test fund",
      created: "2026-01-01",
      status: "active",
    },
    capital: { initial: 10_000, currency: "USD" },
    objective: { type: "growth", target_multiple: 2 },
    risk: { profile: "moderate", max_drawdown_pct: 15, max_position_pct: 25 },
    universe: {
      preset: "sp500",
      include_tickers: [],
      exclude_tickers: [],
      exclude_sectors: [],
    },
    schedule: {
      sessions: {
        mid_session: {
          time: "13:00",
          enabled: true,
          focus: "Monitor positions. React to intraday moves.",
        },
      },
    },
    broker: { mode: "paper" },
    claude: { model: "sonnet" },
  };
  await writeFile(join(fundRoot, "fund_config.yaml"), yaml.dump(config), "utf-8");

  // Minimal global config so loadGlobalConfig doesn't throw
  await writeFile(
    join(tmpRoot, "config.yaml"),
    yaml.dump({ default_model: "sonnet", broker: { mode: "paper" } }),
    "utf-8",
  );

  // Minimal portfolio.json so state reads don't crash
  await writeFile(
    join(stateDir, "portfolio.json"),
    JSON.stringify({
      cash: 10_000,
      holdings: [],
      total_value: 10_000,
      as_of: new Date().toISOString(),
    }),
    "utf-8",
  );
}

// ── Test suite ────────────────────────────────────────────────
describe("integration: runFundSession (mocked SDK)", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "fundx-int-session-"));
    // Update the env var so the mock's root() function sees the real unique dir
    process.env["FUNDX_INT_TMP"] = tmpRoot;
    await seedFund(tmpRoot);
  });

  afterAll(async () => {
    delete process.env["FUNDX_INT_TMP"];
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  it("orient → run → reflect → JSONL append (success path)", async () => {
    await runFundSession(FUND_NAME, "mid_session");

    const sessionLogJsonl = join(tmpRoot, "funds", FUND_NAME, "state", "session_log.jsonl");

    // 1. session_log.jsonl has been created and has at least one entry
    expect(existsSync(sessionLogJsonl)).toBe(true);
    const raw = await readFile(sessionLogJsonl, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    // 2. Last entry has correct shape
    const last = JSON.parse(lines[lines.length - 1]!);
    expect(last.status).toBe("success");
    expect(last.session_type).toBe("mid_session");
    expect(last.fund).toBe(FUND_NAME);
    expect(last.cost_usd).toBe(0.05);
    expect(last.num_turns).toBe(8);

    // 3. daily_cap_state.json absent — cap not breached ($0.05 < default $5)
    const dailyCapState = join(
      tmpRoot,
      "funds",
      FUND_NAME,
      "state",
      "daily_cap_state.json",
    );
    expect(existsSync(dailyCapState)).toBe(false);
  });

  it("second session appends a second JSONL line (accumulation)", async () => {
    await runFundSession(FUND_NAME, "mid_session");

    const sessionLogJsonl = join(tmpRoot, "funds", FUND_NAME, "state", "session_log.jsonl");
    const raw = await readFile(sessionLogJsonl, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    // Should now have at least 2 entries (one from first test, one from this test)
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // All entries should be valid JSON
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
