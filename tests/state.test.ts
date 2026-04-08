import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import {
  readPortfolio,
  writePortfolio,
  readTracker,
  writeTracker,
  readSessionLog,
  writeSessionLog,
  initFundState,
  readSessionHandoff,
  writeSessionHandoff,
  readDailySnapshot,
  writeDailySnapshot,
  readNotifiedMilestones,
  writeNotifiedMilestones,
} from "../src/state.js";
import type { Portfolio, ObjectiveTracker, SessionLog } from "../src/types.js";

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedRename = vi.mocked(rename);
const mockedMkdir = vi.mocked(mkdir);

const FUND = "test-fund";
const fundRoot = join(homedir(), ".fundx", "funds", FUND);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readPortfolio", () => {
  it("reads and validates portfolio from disk", async () => {
    const portfolio: Portfolio = {
      last_updated: "2026-01-01T00:00:00Z",
      cash: 10000,
      total_value: 10000,
      positions: [],
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(portfolio));

    const result = await readPortfolio(FUND);
    expect(result.cash).toBe(10000);
    expect(result.positions).toHaveLength(0);
    expect(mockedReadFile).toHaveBeenCalledWith(
      join(fundRoot, "state", "portfolio.json"),
      "utf-8",
    );
  });
});

describe("writePortfolio", () => {
  it("writes atomically via tmp + rename", async () => {
    const portfolio: Portfolio = {
      last_updated: "2026-01-01T00:00:00Z",
      cash: 5000,
      total_value: 5000,
      positions: [],
    };

    await writePortfolio(FUND, portfolio);

    const expectedPath = join(fundRoot, "state", "portfolio.json");
    expect(mockedMkdir).toHaveBeenCalled();
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expectedPath + ".tmp",
      expect.stringContaining('"cash": 5000'),
      "utf-8",
    );
    expect(mockedRename).toHaveBeenCalledWith(
      expectedPath + ".tmp",
      expectedPath,
    );
  });
});

describe("readTracker", () => {
  it("reads and validates objective tracker", async () => {
    const tracker: ObjectiveTracker = {
      type: "growth",
      initial_capital: 10000,
      current_value: 12000,
      progress_pct: 40,
      status: "ahead",
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(tracker));

    const result = await readTracker(FUND);
    expect(result.progress_pct).toBe(40);
    expect(result.status).toBe("ahead");
  });
});

describe("writeTracker", () => {
  it("writes tracker atomically", async () => {
    const tracker: ObjectiveTracker = {
      type: "growth",
      initial_capital: 10000,
      current_value: 10000,
      progress_pct: 0,
      status: "on_track",
    };

    await writeTracker(FUND, tracker);

    const expectedPath = join(fundRoot, "state", "objective_tracker.json");
    expect(mockedRename).toHaveBeenCalledWith(
      expectedPath + ".tmp",
      expectedPath,
    );
  });
});

describe("readSessionLog", () => {
  it("returns session log when present", async () => {
    const log: SessionLog = {
      fund: FUND,
      session_type: "pre_market",
      started_at: "2026-01-01T09:00:00Z",
      trades_executed: 0,
      summary: "test",
    };
    mockedReadFile.mockResolvedValue(JSON.stringify(log));

    const result = await readSessionLog(FUND);
    expect(result).not.toBeNull();
    expect(result!.session_type).toBe("pre_market");
  });

  it("returns null when file does not exist", async () => {
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedReadFile.mockRejectedValue(err);

    const result = await readSessionLog(FUND);
    expect(result).toBeNull();
  });

  it("throws on corrupted JSON", async () => {
    mockedReadFile.mockResolvedValue("not valid json {{{");

    await expect(readSessionLog(FUND)).rejects.toThrow();
  });
});

describe("writeSessionLog", () => {
  it("writes session log atomically", async () => {
    const log: SessionLog = {
      fund: FUND,
      session_type: "post_market",
      started_at: "2026-01-01T18:00:00Z",
      ended_at: "2026-01-01T18:10:00Z",
      trades_executed: 3,
      summary: "Good session",
    };

    await writeSessionLog(FUND, log);

    const expectedPath = join(fundRoot, "state", "session_log.json");
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expectedPath + ".tmp",
      expect.stringContaining('"trades_executed": 3'),
      "utf-8",
    );
    expect(mockedRename).toHaveBeenCalledWith(
      expectedPath + ".tmp",
      expectedPath,
    );
  });
});

describe("initFundState", () => {
  it("creates directories and initializes state files", async () => {
    await initFundState(FUND, 50000, "runway");

    // Should create all necessary directories
    expect(mockedMkdir).toHaveBeenCalledWith(
      join(fundRoot, "state"),
      { recursive: true },
    );
    expect(mockedMkdir).toHaveBeenCalledWith(
      join(fundRoot, "analysis"),
      { recursive: true },
    );
    expect(mockedMkdir).toHaveBeenCalledWith(
      join(fundRoot, "scripts"),
      { recursive: true },
    );

    // Should write portfolio with initial capital
    const portfolioTmp = join(fundRoot, "state", "portfolio.json.tmp");
    const portfolioCall = mockedWriteFile.mock.calls.find(
      (call) => call[0] === portfolioTmp,
    );
    expect(portfolioCall).toBeDefined();
    const portfolioData = JSON.parse(portfolioCall![1] as string);
    expect(portfolioData.cash).toBe(50000);
    expect(portfolioData.total_value).toBe(50000);

    // Should write tracker with correct type
    const trackerTmp = join(fundRoot, "state", "objective_tracker.json.tmp");
    const trackerCall = mockedWriteFile.mock.calls.find(
      (call) => call[0] === trackerTmp,
    );
    expect(trackerCall).toBeDefined();
    const trackerData = JSON.parse(trackerCall![1] as string);
    expect(trackerData.type).toBe("runway");
    expect(trackerData.initial_capital).toBe(50000);
    expect(trackerData.progress_pct).toBe(0);
  });
});

describe("Daily Snapshot", () => {
  it("reads daily snapshot from the correct path", async () => {
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({ date: "2026-04-08", total_value: 10000 }));
    const snapshot = await readDailySnapshot("test-fund");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.date).toBe("2026-04-08");
    expect(snapshot!.total_value).toBe(10000);
  });

  it("returns null when snapshot does not exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedReadFile.mockRejectedValueOnce(err);
    const snapshot = await readDailySnapshot("test-fund");
    expect(snapshot).toBeNull();
  });

  it("writes daily snapshot atomically", async () => {
    await writeDailySnapshot("test-fund", { date: "2026-04-08", total_value: 10000 });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("daily_snapshot.json.tmp"),
      expect.stringContaining("10000"),
      "utf-8",
    );
    expect(mockedRename).toHaveBeenCalled();
  });
});

describe("Notified Milestones", () => {
  it("reads milestones from the correct path", async () => {
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({
      thresholds_notified: [10, 25],
      peak_value: 12500,
      drawdown_thresholds_notified: [],
      last_checked: "2026-04-08T15:30:00Z",
    }));
    const milestones = await readNotifiedMilestones("test-fund");
    expect(milestones.thresholds_notified).toEqual([10, 25]);
    expect(milestones.peak_value).toBe(12500);
  });

  it("returns defaults when file does not exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedReadFile.mockRejectedValueOnce(err);
    const milestones = await readNotifiedMilestones("test-fund");
    expect(milestones.thresholds_notified).toEqual([]);
    expect(milestones.peak_value).toBe(0);
    expect(milestones.drawdown_thresholds_notified).toEqual([]);
  });

  it("writes milestones atomically", async () => {
    await writeNotifiedMilestones("test-fund", {
      thresholds_notified: [10],
      peak_value: 10500,
      drawdown_thresholds_notified: [],
      last_checked: "2026-04-08T16:00:00Z",
    });
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("notified_milestones.json.tmp"),
      expect.stringContaining("10500"),
      "utf-8",
    );
    expect(mockedRename).toHaveBeenCalled();
  });
});

describe("Session Handoff", () => {
  it("reads handoff markdown from the correct path", async () => {
    mockedReadFile.mockResolvedValueOnce("# Session Handoff — 2026-04-08 pre-market\n\n## Session Contract\n> Orient complete.");
    const content = await readSessionHandoff("test-fund");
    expect(content).toContain("# Session Handoff");
    expect(mockedReadFile).toHaveBeenCalledWith(
      expect.stringContaining("session-handoff.md"),
      "utf-8",
    );
  });

  it("returns null when handoff file does not exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockedReadFile.mockRejectedValueOnce(err);
    const content = await readSessionHandoff("test-fund");
    expect(content).toBeNull();
  });

  it("writes handoff markdown atomically (tmp + rename)", async () => {
    await writeSessionHandoff("test-fund", "# Handoff content");
    expect(mockedMkdir).toHaveBeenCalled();
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("session-handoff.md.tmp"),
      "# Handoff content",
      "utf-8",
    );
    expect(mockedRename).toHaveBeenCalledWith(
      expect.stringContaining("session-handoff.md.tmp"),
      expect.stringContaining("session-handoff.md"),
    );
  });
});
