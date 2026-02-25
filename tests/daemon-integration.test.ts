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
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// Capture the cron callback directly without actually scheduling
let capturedCronCallback: ((...args: unknown[]) => Promise<void>) | null = null;
vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn((_expr: string, cb: (...args: unknown[]) => Promise<void>) => {
      capturedCronCallback = cb;
    }),
  },
}));

vi.mock("../src/fund.js", () => ({
  listFundNames: vi.fn().mockResolvedValue([]),
  loadFundConfig: vi.fn(),
}));

vi.mock("../src/session.js", () => ({
  runFundSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/gateway.js", () => ({
  startGateway: vi.fn().mockResolvedValue(undefined),
  stopGateway: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/special-sessions.js", () => ({
  checkSpecialSessions: vi.fn().mockReturnValue([]),
}));

vi.mock("../src/reports.js", () => ({
  generateDailyReport: vi.fn().mockResolvedValue(undefined),
  generateWeeklyReport: vi.fn().mockResolvedValue(undefined),
  generateMonthlyReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/sync.js", () => ({
  syncPortfolio: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/stoploss.js", () => ({
  checkStopLosses: vi.fn().mockResolvedValue([]),
  executeStopLosses: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn().mockResolvedValue({
    default_model: "sonnet",
    timezone: "America/New_York",
    broker: { provider: "alpaca", api_key: "k", secret_key: "s", mode: "paper" },
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
}));

vi.mock("../src/journal.js", () => ({
  openJournal: vi.fn().mockReturnValue({ close: vi.fn() }),
  insertTrade: vi.fn().mockReturnValue(1),
}));

// Import after mocks
import cron from "node-cron";
import { listFundNames, loadFundConfig } from "../src/fund.js";
import { syncPortfolio } from "../src/sync.js";
import { checkStopLosses, executeStopLosses } from "../src/stoploss.js";
import { generateDailyReport } from "../src/reports.js";
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

beforeEach(() => {
  vi.clearAllMocks();
  capturedCronCallback = null;
  // Re-mock process.exit after clearAllMocks
  exitSpy.mockImplementation((() => {}) as never);
});

// ── Daemon module imports ────────────────────────────────────────

describe("daemon module", () => {
  it("exports start and stop commands", async () => {
    const { startCommand, stopCommand } = await import("../src/daemon.js");
    expect(startCommand.name()).toBe("start");
    expect(stopCommand.name()).toBe("stop");
  });

  it("registers cron schedule on start", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { startCommand } = await import("../src/daemon.js");
    await startCommand.parseAsync([], { from: "user" });

    expect(cron.schedule).toHaveBeenCalledWith("* * * * *", expect.any(Function));
  });
});

// ── Cron callback behavior ───────────────────────────────────────

describe("daemon cron callback", () => {
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
      universe: { allowed: [] },
      schedule: {
        trading_days: ["MON", "TUE", "WED", "THU", "FRI"],
        sessions: {
          pre_market: { time: "09:00", enabled: true, focus: "Morning" },
        },
      },
      broker: { provider: "alpaca", mode: "paper" },
      ...overrides,
    });

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedCronCallback = null;
    exitSpy.mockImplementation((() => {}) as never);

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    // Import daemon to trigger startDaemon → cron.schedule
    const { startCommand } = await import("../src/daemon.js");
    await startCommand.parseAsync([], { from: "user" });

    // Set up default mocks for the cron loop
    vi.mocked(listFundNames).mockResolvedValue(["test-fund"]);
    vi.mocked(loadFundConfig).mockResolvedValue(makeFundConfig());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls syncPortfolio at 09:30 on trading days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T09:30:00")); // Monday
    await capturedCronCallback!();

    expect(syncPortfolio).toHaveBeenCalledWith("test-fund");
  });

  it("does NOT call syncPortfolio at other times", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T10:00:00")); // Monday 10:00
    await capturedCronCallback!();

    expect(syncPortfolio).not.toHaveBeenCalled();
  });

  it("calls checkStopLosses every 5 min during market hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T10:00:00")); // Monday 10:00
    await capturedCronCallback!();

    expect(checkStopLosses).toHaveBeenCalledWith("test-fund");
  });

  it("calls checkStopLosses at 09:30 (market open, minute % 5 === 0)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T09:30:00"));
    await capturedCronCallback!();

    expect(checkStopLosses).toHaveBeenCalledWith("test-fund");
  });

  it("does NOT call checkStopLosses before market open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T09:25:00"));
    await capturedCronCallback!();

    expect(checkStopLosses).not.toHaveBeenCalled();
  });

  it("does NOT call checkStopLosses after market close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T16:00:00"));
    await capturedCronCallback!();

    expect(checkStopLosses).not.toHaveBeenCalled();
  });

  it("does NOT call checkStopLosses on non-5-minute intervals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T10:03:00"));
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
    vi.setSystemTime(new Date("2026-02-23T10:00:00"));
    await capturedCronCallback!();

    // Flush microtask queue for the .then() chain
    await vi.advanceTimersByTimeAsync(0);

    expect(executeStopLosses).toHaveBeenCalledWith("test-fund", triggered);
  });

  it("does NOT call executeStopLosses when no triggers", async () => {
    vi.mocked(checkStopLosses).mockResolvedValue([]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T10:00:00"));
    await capturedCronCallback!();

    await vi.advanceTimersByTimeAsync(0);
    expect(executeStopLosses).not.toHaveBeenCalled();
  });

  it("skips inactive funds for sync and stoploss", async () => {
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
    vi.setSystemTime(new Date("2026-02-23T09:30:00"));
    await capturedCronCallback!();

    expect(syncPortfolio).not.toHaveBeenCalled();
    expect(checkStopLosses).not.toHaveBeenCalled();
  });

  it("skips non-trading days for sync and stoploss", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-22T09:30:00")); // Sunday
    await capturedCronCallback!();

    expect(syncPortfolio).not.toHaveBeenCalled();
    expect(checkStopLosses).not.toHaveBeenCalled();
  });

  it("still calls dailyReport at 18:30", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-23T18:30:00")); // Monday 18:30
    await capturedCronCallback!();

    expect(generateDailyReport).toHaveBeenCalledWith("test-fund");
  });
});
