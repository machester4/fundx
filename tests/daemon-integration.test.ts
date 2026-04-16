import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockRejectedValue(new Error("ENOENT")),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn().mockReturnValue("node fundx"),
}));

// Capture cron callbacks by expression without actually scheduling
const capturedCronCallbacks = new Map<string, (...args: unknown[]) => Promise<void>>();
let capturedCronCallback: ((...args: unknown[]) => Promise<void>) | null = null;
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((expr: string, cb: (...args: unknown[]) => Promise<void>) => {
      capturedCronCallbacks.set(expr, cb);
      // Keep backwards compat: capturedCronCallback points to the per-minute schedule
      if (expr === "* * * * *") capturedCronCallback = cb;
    }),
  },
}));

vi.mock("../src/services/fund.service.js", () => ({
  listFundNames: vi.fn().mockResolvedValue([]),
  loadFundConfig: vi.fn(),
  saveFundConfig: vi.fn(),
}));

vi.mock("../src/services/session.service.js", () => ({
  runFundSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/gateway.service.js", () => ({
  startGateway: vi.fn().mockResolvedValue(undefined),
  stopGateway: vi.fn().mockResolvedValue(undefined),
  sendTelegramNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/special-sessions.service.js", () => ({
  checkSpecialSessions: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/services/reports.service.js", () => ({
  generateDailyReport: vi.fn().mockResolvedValue(undefined),
  generateWeeklyReport: vi.fn().mockResolvedValue(undefined),
  generateMonthlyReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/stoploss.js", () => ({
  checkStopLosses: vi.fn().mockResolvedValue([]),
  executeStopLosses: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn().mockResolvedValue({
    default_model: "sonnet",
    timezone: "America/New_York",
    broker: { mode: "paper" },
  }),
}));

vi.mock("../src/state.js", () => ({
  readPortfolio: vi.fn().mockResolvedValue({
    last_updated: "2026-01-01",
    cash: 50000,
    total_value: 50000,
    positions: [],
  }),
  writePortfolio: vi.fn().mockResolvedValue(undefined),
  readTracker: vi.fn().mockResolvedValue(null),
  readSessionHistory: vi.fn().mockResolvedValue({}),
  writeSessionHistory: vi.fn().mockResolvedValue(undefined),
  readPendingSessions: vi.fn().mockResolvedValue([]),
  writePendingSessions: vi.fn().mockResolvedValue(undefined),
  readSessionCounts: vi.fn().mockResolvedValue({ date: "2026-01-01", agent: 0, news: 0 }),
  writeSessionCounts: vi.fn().mockResolvedValue(undefined),
  readDailySnapshot: vi.fn().mockResolvedValue(null),
  writeDailySnapshot: vi.fn().mockResolvedValue(undefined),
  readNotifiedMilestones: vi.fn().mockResolvedValue({
    thresholds_notified: [],
    peak_value: 0,
    drawdown_thresholds_notified: [],
    last_checked: null,
  }),
  writeNotifiedMilestones: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/journal.js", () => ({
  openJournal: vi.fn().mockReturnValue({ close: vi.fn() }),
  insertTrade: vi.fn().mockReturnValue(1),
  getTradesInDays: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/lock.js", () => ({
  acquireFundLock: vi.fn().mockResolvedValue(true),
  releaseFundLock: vi.fn().mockResolvedValue(undefined),
  withTimeout: vi.fn((promise: Promise<unknown>) => promise),
}));

vi.mock("../src/services/news.service.js", () => ({
  fetchAllFeeds: vi.fn().mockResolvedValue([]),
  checkBreakingNews: vi.fn().mockResolvedValue(undefined),
  cleanOldArticles: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/services/news-ipc.service.js", () => ({
  startNewsIpcServer: vi.fn().mockResolvedValue(undefined),
  stopNewsIpcServer: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import cron from "node-cron";
import { listFundNames, loadFundConfig } from "../src/services/fund.service.js";
import { checkStopLosses, executeStopLosses } from "../src/stoploss.js";
import { generateDailyReport } from "../src/services/reports.service.js";
import { startDaemon, stopDaemon, isDaemonRunning, checkMissedSessions, cleanOldAnalysisFiles, sendDailyDigest, sendWeeklyDigest, checkMilestonesAndDrawdown } from "../src/services/daemon.service.js";
import { runFundSession } from "../src/services/session.service.js";
import { readSessionHistory } from "../src/state.js";
import type { FundConfig } from "../src/types.js";
import { fundConfigSchema } from "../src/types.js";

// Prevent process.exit in daemon cleanup
const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

// Track listeners we add so we can clean up
const addedListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
vi.spyOn(process, "on").mockImplementation(((event: string, fn: (...args: unknown[]) => void) => {
  addedListeners.push({ event, fn });
  return process;
}) as typeof process.on);

afterAll(() => {
  exitSpy.mockRestore();
});

// Shared test helper
const makeFundConfig = (overrides?: Partial<FundConfig>): FundConfig =>
  fundConfigSchema.parse({
    fund: {
      name: "test-fund",
      display_name: "Test Fund",
      description: "Test",
      created: "2026-01-01",
      status: "active",
    },
    capital: { initial: 50000, currency: "USD" },
    objective: { type: "runway", target_months: 18, monthly_burn: 2500 },
    risk: { profile: "conservative", stop_loss_pct: 8 },
    universe: { preset: "sp500" },
    schedule: {
      trading_days: ["MON", "TUE", "WED", "THU", "FRI"],
      sessions: {
        pre_market: { time: "09:00", enabled: true, focus: "Morning" },
      },
    },
    broker: { mode: "paper" },
    ...overrides,
  });

beforeEach(() => {
  vi.clearAllMocks();
  capturedCronCallback = null;
  capturedCronCallbacks.clear();
  // Re-mock process.exit after clearAllMocks
  exitSpy.mockImplementation((() => {}) as never);
});

// ── Daemon module ────────────────────────────────────────────

describe("daemon module", () => {
  it("exports start and stop commands", async () => {
    expect(typeof startDaemon).toBe("function");
    expect(typeof stopDaemon).toBe("function");
    expect(typeof isDaemonRunning).toBe("function");
  });

  it("registers cron schedule on start", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    await startDaemon();

    expect(cron.schedule).toHaveBeenCalledWith("* * * * *", expect.any(Function));
  });
});

// ── Cron callback behavior ───────────────────────────────────────

describe("daemon cron callback", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedCronCallback = null;
    capturedCronCallbacks.clear();
    exitSpy.mockImplementation((() => {}) as never);

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    // Start daemon to trigger cron.schedule
    await startDaemon();

    // Set up default mocks for the cron loop
    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls checkStopLosses every 5 min during market hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T10:00:00Z")); // Monday 10:00 UTC
    await capturedCronCallback!();

    expect(checkStopLosses).toHaveBeenCalledWith("test-fund");
  });

  it("calls checkStopLosses at 09:30 (market open, minute % 5 === 0)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T09:30:00Z")); // UTC
    await capturedCronCallback!();

    expect(checkStopLosses).toHaveBeenCalledWith("test-fund");
  });

  it("does NOT call checkStopLosses before market open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T09:25:00Z")); // UTC
    await capturedCronCallback!();

    expect(checkStopLosses).not.toHaveBeenCalled();
  });

  it("does NOT call checkStopLosses after market close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T16:00:00Z")); // UTC
    await capturedCronCallback!();

    expect(checkStopLosses).not.toHaveBeenCalled();
  });

  it("does NOT call checkStopLosses on non-5-minute intervals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T10:03:00Z")); // UTC
    await capturedCronCallback!();

    expect(checkStopLosses).not.toHaveBeenCalled();
  });

  it("calls executeStopLosses when triggers are found", async () => {
    const triggered = [
      {
        symbol: "SPY",
        shares: 10,
        stopPrice: 440,
        currentPrice: 438,
        avgCost: 450,
        loss: -120,
        lossPct: -2.67,
      },
    ];
    vi.mocked(checkStopLosses).mockResolvedValue(triggered);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T10:00:00Z")); // UTC
    await capturedCronCallback!();

    // Flush microtask queue for the .then() chain
    await vi.advanceTimersByTimeAsync(0);

    expect(executeStopLosses).toHaveBeenCalledWith("test-fund", triggered);
  });

  it("does NOT call executeStopLosses when no triggers", async () => {
    vi.mocked(checkStopLosses).mockResolvedValue([]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T10:00:00Z")); // UTC
    await capturedCronCallback!();

    await vi.advanceTimersByTimeAsync(0);
    expect(executeStopLosses).not.toHaveBeenCalled();
  });

  it("skips inactive funds for stoploss", async () => {
    vi.mocked(loadFundConfig).mockResolvedValue(
      makeFundConfig({
        fund: {
          name: "test-fund",
          display_name: "Test Fund",
          description: "Test",
          created: "2026-01-01",
          status: "paused",
        },
      }),
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T09:30:00Z")); // UTC
    await capturedCronCallback!();

    expect(checkStopLosses).not.toHaveBeenCalled();
  });

  it("skips non-trading days for stoploss", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-22T09:30:00Z")); // Sunday UTC
    await capturedCronCallback!();

    expect(checkStopLosses).not.toHaveBeenCalled();
  });

  it("still calls dailyReport at 18:30", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T18:30:00Z")); // Monday 18:30 UTC
    await capturedCronCallback!();

    expect(generateDailyReport).toHaveBeenCalledWith("test-fund");
  });
});

// ── cleanOldAnalysisFiles ────────────────────────────────────

describe("cleanOldAnalysisFiles", () => {
  it("is exported and callable", () => {
    expect(typeof cleanOldAnalysisFiles).toBe("function");
  });

  it("deletes .md files older than 30 days and keeps recent ones", async () => {
    const { listFundNames } = await import("../src/services/fund.service.js");
    const { readdir, stat, unlink } = await import("node:fs/promises");

    vi.mocked(listFundNames).mockResolvedValueOnce(["test-fund"]);
    vi.mocked(readdir).mockResolvedValueOnce(["old-analysis.md", "recent-analysis.md", "data.json"] as never);

    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    const oneDayAgo = now - 1 * 24 * 60 * 60 * 1000;

    vi.mocked(stat)
      .mockResolvedValueOnce({ mtimeMs: thirtyOneDaysAgo } as never)  // old-analysis.md
      .mockResolvedValueOnce({ mtimeMs: oneDayAgo } as never);         // recent-analysis.md

    await cleanOldAnalysisFiles();

    // Should delete old .md file
    expect(unlink).toHaveBeenCalledWith(
      expect.stringContaining("old-analysis.md"),
    );
    // Should NOT delete recent .md file
    const unlinkCalls = vi.mocked(unlink).mock.calls.map((c) => c[0] as string);
    expect(unlinkCalls.some((p) => p.includes("recent-analysis.md"))).toBe(false);
    // Should skip non-.md files entirely (no stat call for data.json)
    expect(stat).toHaveBeenCalledTimes(2);
  });
});

// ── Catch-up on startup ──────────────────────────────────────

describe("daemon catch-up on startup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no catch-up when session history is current", async () => {
    vi.useFakeTimers();
    // Monday 09:15 UTC — pre_market is at 09:00, so it was 15 min ago
    vi.setSystemTime(new Date("2026-02-23T09:15:00Z"));

    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
    // Session history shows pre_market ran today at 09:00
    vi.mocked(readSessionHistory).mockResolvedValue({
      pre_market: "2026-02-23T09:00:30.000Z",
    });

    await checkMissedSessions();

    expect(runFundSession).not.toHaveBeenCalled();
  });

  it("catch-up runs for missed session within tolerance", async () => {
    vi.useFakeTimers();
    // Monday 09:30 UTC — pre_market was at 09:00, 30 min ago (within 60-min tolerance)
    vi.setSystemTime(new Date("2026-02-23T09:30:00Z"));

    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
    // Session history shows last run was yesterday
    vi.mocked(readSessionHistory).mockResolvedValue({
      pre_market: "2026-02-22T09:00:00.000Z",
    });

    await checkMissedSessions();

    expect(runFundSession).toHaveBeenCalledWith(
      "test-fund",
      "catchup_pre_market",
      expect.objectContaining({
        focus: expect.stringContaining("[CATCH-UP]"),
      }),
    );
  });

  it("no catch-up when outside tolerance (> 60 min)", async () => {
    vi.useFakeTimers();
    // Monday 10:30 UTC — pre_market was at 09:00, 90 min ago (outside 60-min tolerance)
    vi.setSystemTime(new Date("2026-02-23T10:30:00Z"));

    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
    vi.mocked(readSessionHistory).mockResolvedValue({
      pre_market: "2026-02-22T09:00:00.000Z",
    });

    await checkMissedSessions();

    expect(runFundSession).not.toHaveBeenCalled();
  });

  it("handles fund with no session history (first run)", async () => {
    vi.useFakeTimers();
    // Monday 09:20 UTC — pre_market was at 09:00, 20 min ago
    vi.setSystemTime(new Date("2026-02-23T09:20:00Z"));

    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
    // Empty history (first run ever)
    vi.mocked(readSessionHistory).mockResolvedValue({});

    await checkMissedSessions();

    // Should catch up because lastRunMs=0 is before scheduledMs
    expect(runFundSession).toHaveBeenCalledWith(
      "test-fund",
      "catchup_pre_market",
      expect.objectContaining({
        focus: expect.stringContaining("[CATCH-UP]"),
      }),
    );
  });
});

// ── sendDailyDigest ──────────────────────────────────────────

describe("sendDailyDigest", () => {
  it("is exported and callable", () => {
    expect(typeof sendDailyDigest).toBe("function");
  });

  it("includes P&L when daily snapshot exists for today", async () => {
    const { readPortfolio, readTracker, readDailySnapshot } = await import("../src/state.js");
    const { sendTelegramNotification } = await import("../src/services/gateway.service.js");

    vi.mocked(loadFundConfig).mockResolvedValueOnce(makeFundConfig({
      notifications: { telegram: { enabled: true, daily_digest: true }, quiet_hours: { enabled: false } },
    }) as never);
    vi.mocked(readPortfolio).mockResolvedValueOnce({
      last_updated: "2026-04-08",
      cash: 9500,
      total_value: 10500,
      positions: [{ symbol: "URA", shares: 6, avg_cost: 48, current_price: 52, market_value: 312, unrealized_pnl: 24, unrealized_pnl_pct: 8.3, weight_pct: 3, entry_date: "2026-04-01", entry_reason: "test" }],
    } as never);
    vi.mocked(readTracker).mockResolvedValueOnce({
      type: "growth", initial_capital: 10000, current_value: 10500, progress_pct: 5, status: "on_track",
    } as never);
    const today = new Date().toISOString().split("T")[0];
    vi.mocked(readDailySnapshot).mockResolvedValueOnce({ date: today, total_value: 10000 } as never);

    await sendDailyDigest("test-fund");

    expect(sendTelegramNotification).toHaveBeenCalledWith(
      expect.stringContaining("Daily Digest"),
    );
  });
});

// ── sendWeeklyDigest ─────────────────────────────────────────

describe("sendWeeklyDigest", () => {
  it("is exported and callable", () => {
    expect(typeof sendWeeklyDigest).toBe("function");
  });
});

// ── checkMilestonesAndDrawdown ───────────────────────────────

describe("checkMilestonesAndDrawdown", () => {
  it("is exported and callable", () => {
    expect(typeof checkMilestonesAndDrawdown).toBe("function");
  });
});
