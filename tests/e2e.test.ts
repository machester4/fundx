import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * End-to-end integration test for the core flow:
 * init workspace → create fund → verify state → run session (mocked SDK)
 *
 * We mock the filesystem and Agent SDK to avoid side effects,
 * but exercise the real business logic end-to-end.
 */

const WORKSPACE = join(homedir(), ".fundx");
const FUNDS_DIR = join(WORKSPACE, "funds");

// Track filesystem state
const fileSystem = new Map<string, string>();
const directories = new Set<string>();

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (path: string) => {
    const content = fileSystem.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      (err as NodeJS.ErrnoException).code = "ENOENT";
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    fileSystem.set(path, content);
  }),
  rename: vi.fn(async (src: string, dest: string) => {
    const content = fileSystem.get(src);
    if (content !== undefined) {
      fileSystem.set(dest, content);
      fileSystem.delete(src);
    }
  }),
  mkdir: vi.fn(async (path: string) => {
    directories.add(path);
  }),
  readdir: vi.fn(async (path: string) => {
    if (path === FUNDS_DIR) {
      const fundNames: Array<{ name: string; isDirectory: () => boolean }> = [];
      for (const key of fileSystem.keys()) {
        if (key.startsWith(FUNDS_DIR + "/")) {
          const relative = key.slice(FUNDS_DIR.length + 1);
          const fundName = relative.split("/")[0];
          if (!fundNames.find((f) => f.name === fundName)) {
            fundNames.push({
              name: fundName,
              isDirectory: () => true,
            });
          }
        }
      }
      return fundNames;
    }
    return [];
  }),
  rm: vi.fn(async (path: string) => {
    for (const key of fileSystem.keys()) {
      if (key.startsWith(path)) {
        fileSystem.delete(key);
      }
    }
  }),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => {
    // Check if path exists in our virtual fs
    if (fileSystem.has(path)) return true;
    if (directories.has(path)) return true;
    // Check if any file starts with this path (it's a directory)
    for (const key of fileSystem.keys()) {
      if (key.startsWith(path + "/")) return true;
    }
    return false;
  }),
}));

// Mock the Agent SDK wrapper instead of child_process
vi.mock("../src/agent.js", () => ({
  runAgentQuery: vi.fn(async () => ({
    output: "Session completed. Analyzed market conditions. No trades executed.",
    cost_usd: 0.0123,
    duration_ms: 5000,
    num_turns: 3,
    usage: { "claude-sonnet-4-6": { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0123, contextWindow: 200000, maxOutputTokens: 16384 } },
    session_id: "test-session-id",
    status: "success",
  })),
  buildMcpServers: vi.fn(async () => ({
    "broker-alpaca": { command: "node", args: ["broker-alpaca.js"], env: {} },
    "market-data": { command: "node", args: ["market-data.js"], env: {} },
  })),
}));

// Import after mocks are set up
import { saveGlobalConfig, loadGlobalConfig } from "../src/config.js";
import { saveFundConfig, loadFundConfig, listFundNames } from "../src/fund.js";
import { initFundState, readPortfolio, readTracker, writeSessionLog, readSessionLog } from "../src/state.js";
import { generateFundClaudeMd } from "../src/template.js";
import { runFundSession } from "../src/session.js";
import { fundConfigSchema, globalConfigSchema } from "../src/types.js";
import type { GlobalConfig, FundConfig } from "../src/types.js";

beforeEach(() => {
  fileSystem.clear();
  directories.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("E2E: init → create fund → run session", () => {
  const FUND_NAME = "runway-fund";

  it("Step 1: Initialize workspace with global config", async () => {
    const globalConfig: GlobalConfig = globalConfigSchema.parse({
      default_model: "sonnet",
      timezone: "America/New_York",
      broker: {
        provider: "alpaca",
        api_key: "test-key",
        secret_key: "test-secret",
        mode: "paper",
      },
    });

    await saveGlobalConfig(globalConfig);

    // Verify config was written
    const loaded = await loadGlobalConfig();
    expect(loaded.default_model).toBe("sonnet");
    expect(loaded.timezone).toBe("America/New_York");
    expect(loaded.broker.provider).toBe("alpaca");
  });

  it("Step 2: Create a fund with runway objective", async () => {
    // First set up global config
    await saveGlobalConfig(globalConfigSchema.parse({}));

    const fundConfig: FundConfig = fundConfigSchema.parse({
      fund: {
        name: FUND_NAME,
        display_name: "Runway Fund",
        description: "Sustain 18 months of living expenses",
        created: "2026-01-15",
        status: "active",
      },
      capital: { initial: 50000, currency: "USD" },
      objective: {
        type: "runway",
        target_months: 18,
        monthly_burn: 2500,
        min_reserve_months: 3,
      },
      risk: {
        profile: "conservative",
        max_drawdown_pct: 10,
        max_position_pct: 15,
      },
      universe: {
        allowed: [{ type: "etf", tickers: ["SPY", "QQQ", "BND", "GLD"] }],
      },
      schedule: {
        timezone: "America/New_York",
        trading_days: ["MON", "TUE", "WED", "THU", "FRI"],
        sessions: {
          pre_market: {
            time: "09:00",
            enabled: true,
            focus: "Analyze overnight developments. Plan trades.",
          },
          post_market: {
            time: "18:00",
            enabled: true,
            focus: "Review day. Update journal.",
          },
        },
      },
      broker: { provider: "alpaca", mode: "paper" },
      claude: {
        model: "sonnet",
        personality: "Conservative and methodical.",
      },
    });

    // Save fund config
    await saveFundConfig(fundConfig);

    // Initialize state
    await initFundState(FUND_NAME, 50000, "runway");

    // Generate CLAUDE.md
    await generateFundClaudeMd(fundConfig);

    // Verify fund config can be loaded back
    const loaded = await loadFundConfig(FUND_NAME);
    expect(loaded.fund.name).toBe(FUND_NAME);
    expect(loaded.fund.display_name).toBe("Runway Fund");
    expect(loaded.objective.type).toBe("runway");
    if (loaded.objective.type === "runway") {
      expect(loaded.objective.monthly_burn).toBe(2500);
      expect(loaded.objective.target_months).toBe(18);
    }

    // Verify portfolio was initialized
    const portfolio = await readPortfolio(FUND_NAME);
    expect(portfolio.cash).toBe(50000);
    expect(portfolio.total_value).toBe(50000);
    expect(portfolio.positions).toHaveLength(0);

    // Verify tracker was initialized
    const tracker = await readTracker(FUND_NAME);
    expect(tracker.type).toBe("runway");
    expect(tracker.initial_capital).toBe(50000);
    expect(tracker.progress_pct).toBe(0);
    expect(tracker.status).toBe("on_track");

    // Verify CLAUDE.md was generated
    const fundRoot = join(FUNDS_DIR, FUND_NAME);
    const claudeMdPath = join(fundRoot, "CLAUDE.md");
    expect(fileSystem.has(claudeMdPath)).toBe(true);
    const claudeMd = fileSystem.get(claudeMdPath)!;
    expect(claudeMd).toContain("Runway Fund");
    expect(claudeMd).toContain("$2500/month");
    expect(claudeMd).toContain("18 months");
    expect(claudeMd).toContain("Conservative and methodical.");
  });

  it("Step 3: Simulate session execution and log writing", async () => {
    // Set up workspace
    await saveGlobalConfig(globalConfigSchema.parse({}));

    const fundConfig: FundConfig = fundConfigSchema.parse({
      fund: {
        name: FUND_NAME,
        display_name: "Runway Fund",
        description: "Test",
        created: "2026-01-15",
        status: "active",
      },
      capital: { initial: 50000, currency: "USD" },
      objective: {
        type: "runway",
        target_months: 18,
        monthly_burn: 2500,
      },
      risk: { profile: "conservative" },
      universe: { allowed: [] },
      schedule: {
        sessions: {
          pre_market: {
            time: "09:00",
            enabled: true,
            focus: "Analyze overnight developments.",
          },
        },
      },
      broker: { provider: "alpaca", mode: "paper" },
    });

    await saveFundConfig(fundConfig);
    await initFundState(FUND_NAME, 50000, "runway");

    // Simulate what runFundSession does: write a session log
    const sessionLog = {
      fund: FUND_NAME,
      session_type: "pre_market",
      started_at: "2026-01-15T09:00:00Z",
      ended_at: "2026-01-15T09:12:00Z",
      trades_executed: 0,
      summary: "Session completed. Analyzed market conditions. No trades executed.",
    };

    await writeSessionLog(FUND_NAME, sessionLog);

    // Verify session log was persisted
    const loaded = await readSessionLog(FUND_NAME);
    expect(loaded).not.toBeNull();
    expect(loaded!.fund).toBe(FUND_NAME);
    expect(loaded!.session_type).toBe("pre_market");
    expect(loaded!.trades_executed).toBe(0);
    expect(loaded!.summary).toContain("Analyzed market conditions");
  });

  it("Full flow: init → create → run session → verify state", async () => {
    // 1. Init workspace
    const globalConfig = globalConfigSchema.parse({
      default_model: "sonnet",
      timezone: "America/New_York",
      broker: { provider: "alpaca", mode: "paper" },
    });
    await saveGlobalConfig(globalConfig);

    // 2. Create fund
    const fundConfig: FundConfig = fundConfigSchema.parse({
      fund: {
        name: "growth-fund",
        display_name: "Growth Fund",
        description: "2x growth target",
        created: "2026-02-01",
        status: "active",
      },
      capital: { initial: 25000, currency: "USD" },
      objective: { type: "growth", target_multiple: 2 },
      risk: { profile: "moderate" },
      universe: {
        allowed: [{ type: "etf", tickers: ["SPY", "QQQ", "ARKK"] }],
      },
      schedule: {
        sessions: {
          pre_market: {
            time: "09:00",
            enabled: true,
            focus: "Morning analysis",
          },
        },
      },
      broker: { provider: "alpaca", mode: "paper" },
    });

    await saveFundConfig(fundConfig);
    await initFundState("growth-fund", 25000, "growth");
    await generateFundClaudeMd(fundConfig);

    // 3. Verify fund appears in list
    const names = await listFundNames();
    expect(names).toContain("growth-fund");

    // 4. Run a session (uses mocked Agent SDK runAgentQuery)
    await runFundSession("growth-fund", "pre_market");

    // 5. Verify session log was written by runFundSession
    const sessionLog = await readSessionLog("growth-fund");
    expect(sessionLog).not.toBeNull();
    expect(sessionLog!.fund).toBe("growth-fund");
    expect(sessionLog!.session_type).toBe("pre_market");
    expect(sessionLog!.summary).toContain("Session completed");
    expect(sessionLog!.started_at).toBeDefined();
    expect(sessionLog!.ended_at).toBeDefined();

    // 6. Verify portfolio and tracker state persisted
    const portfolio = await readPortfolio("growth-fund");
    expect(portfolio.cash).toBe(25000);
    expect(portfolio.total_value).toBe(25000);

    const tracker = await readTracker("growth-fund");
    expect(tracker.type).toBe("growth");
    expect(tracker.initial_capital).toBe(25000);

    // 7. Verify config is loadable
    const loaded = await loadFundConfig("growth-fund");
    expect(loaded.fund.display_name).toBe("Growth Fund");
    expect(loaded.objective.type).toBe("growth");
  });
});
