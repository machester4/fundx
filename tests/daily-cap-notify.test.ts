import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FUND = "fundx-cap-test";
let tmpRoot: string;

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => {
      const root = join(tmpRoot, "funds", name);
      return {
        ...actual.fundPaths(name),
        root,
        state: {
          ...actual.fundPaths(name).state,
          dir: join(root, "state"),
          dailyCapState: join(root, "state", "daily_cap_state.json"),
        },
      };
    },
  };
});

const sendMock = vi.fn();
const logEventMock = vi.fn().mockReturnValue(true);
const logLineMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/services/daemon.service.js", () => ({
  notifyDaemonEvent: vi.fn().mockResolvedValue(undefined),
  logDaemonEvent: (event: string) => logEventMock(event),
  logDaemonLine: (msg: string) => logLineMock(msg),
}));
vi.mock("../src/services/notify.service.js", () => ({
  notifyDailyCap: (...args: unknown[]) => sendMock(...args),
}));

import { notifyDailyCapReached } from "../src/services/daily-cap.service.js";

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `fundx-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(tmpRoot, "funds", FUND, "state"), { recursive: true });
  sendMock.mockReset();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("notifyDailyCapReached", () => {
  it("sends an alert on first call of the day", async () => {
    await notifyDailyCapReached(FUND, 5, { totalUsd: 5.32, sessionCount: 7, entries: [] });
    expect(sendMock).toHaveBeenCalledTimes(1);
    // notifyDailyCap(fundName, capUsd, spentUsd) — structured args, not stringified subject/body
    expect(sendMock.mock.calls[0][0]).toBe(FUND);
    expect(sendMock.mock.calls[0][1]).toBe(5);
    expect(sendMock.mock.calls[0][2]).toBeCloseTo(5.32);
  });

  it("does not re-send if already alerted today", async () => {
    await notifyDailyCapReached(FUND, 5, { totalUsd: 5.32, sessionCount: 7, entries: [] });
    await notifyDailyCapReached(FUND, 5, { totalUsd: 6.10, sessionCount: 8, entries: [] });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("re-sends when the alerted_for_date is from a previous day", async () => {
    const path = join(tmpRoot, "funds", FUND, "state", "daily_cap_state.json");
    await writeFile(path, JSON.stringify({ alerted_for_date: "2020-01-01" }), "utf-8");

    await notifyDailyCapReached(FUND, 5, { totalUsd: 5.32, sessionCount: 7, entries: [] });
    expect(sendMock).toHaveBeenCalledTimes(1);

    const stateAfter = JSON.parse(await readFile(path, "utf-8"));
    const today = new Date().toISOString().split("T")[0];
    expect(stateAfter.alerted_for_date).toBe(today);
  });

  it("treats a corrupt state file like ENOENT — sends alert and overwrites instead of throwing", async () => {
    const path = join(tmpRoot, "funds", FUND, "state", "daily_cap_state.json");
    // Partial JSON write / disk corruption — JSON.parse throws SyntaxError
    await writeFile(path, "{ not valid json", "utf-8");

    await notifyDailyCapReached(FUND, 5, { totalUsd: 5.32, sessionCount: 7, entries: [] });

    // Did not throw, alert fired, state file rewritten cleanly with today's date
    expect(sendMock).toHaveBeenCalledTimes(1);
    const stateAfter = JSON.parse(await readFile(path, "utf-8"));
    const today = new Date().toISOString().split("T")[0];
    expect(stateAfter.alerted_for_date).toBe(today);
  });
});
