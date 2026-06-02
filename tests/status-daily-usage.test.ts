import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    workspacePaths: () => ({ ...actual.workspacePaths(), root: tmpRoot, fundsDir: join(tmpRoot, "funds") }),
    fundPaths: (name: string) => {
      const root = join(tmpRoot, "funds", name);
      return {
        ...actual.fundPaths(name),
        root,
        state: {
          ...actual.fundPaths(name).state,
          dir: join(root, "state"),
          sessionLogJsonl: join(root, "state", "session_log.jsonl"),
        },
      };
    },
  };
});

vi.mock("../src/services/fund.service.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/fund.service.js")>("../src/services/fund.service.js");
  return {
    ...actual,
    listFundNames: vi.fn(),
    loadFundConfig: vi.fn(),
  };
});

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn(),
}));

import { getDailyUsagePerFund } from "../src/services/status.service.js";
import { listFundNames, loadFundConfig } from "../src/services/fund.service.js";
import { loadGlobalConfig } from "../src/config.js";

const mockedListFundNames = vi.mocked(listFundNames);
const mockedLoadFundConfig = vi.mocked(loadFundConfig);
const mockedLoadGlobalConfig = vi.mocked(loadGlobalConfig);

const FUND_A = "fundx-A";
const FUND_B = "fundx-B";

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `fundx-status-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(tmpRoot, "funds", FUND_A, "state"), { recursive: true });
  await mkdir(join(tmpRoot, "funds", FUND_B, "state"), { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const FUND_CONFIG_NO_BUDGET = { budget: undefined } as never;
const FUND_CONFIG_CAP_10 = { budget: { dailyCapUsd: 10 } } as never;

describe("getDailyUsagePerFund", () => {
  it("returns zero usage for a fund with no JSONL file", async () => {
    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    const usage = map.get(FUND_A);
    expect(usage?.totalUsd).toBe(0);
    expect(usage?.cap).toBe(90);
    expect(usage?.pct).toBe(0);
    expect(usage?.capped).toBe(false);
  });

  it("aggregates today's cost_usd from JSONL", async () => {
    const today = new Date().toISOString();
    const jsonl = [
      JSON.stringify({ fund: FUND_A, session_type: "pre_market", started_at: today, trades_executed: 0, summary: "", cost_usd: 1.0 }),
      JSON.stringify({ fund: FUND_A, session_type: "mid_session", started_at: today, trades_executed: 0, summary: "", cost_usd: 1.34 }),
    ].join("\n") + "\n";
    await writeFile(join(tmpRoot, "funds", FUND_A, "state", "session_log.jsonl"), jsonl, "utf-8");

    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.totalUsd).toBeCloseTo(2.34, 2);
    expect(map.get(FUND_A)?.sessionCount).toBe(2);
    expect(map.get(FUND_A)?.pct).toBeCloseTo(2.6, 1);
  });

  it("reports capped=true when total >= cap", async () => {
    const today = new Date().toISOString();
    const jsonl = JSON.stringify({ fund: FUND_A, session_type: "pre_market", started_at: today, trades_executed: 0, summary: "", cost_usd: 90.12 }) + "\n";
    await writeFile(join(tmpRoot, "funds", FUND_A, "state", "session_log.jsonl"), jsonl, "utf-8");

    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.capped).toBe(true);
    expect(map.get(FUND_A)?.pct).toBeGreaterThan(100);
  });

  it("returns independent counters per fund", async () => {
    const today = new Date().toISOString();
    await writeFile(
      join(tmpRoot, "funds", FUND_A, "state", "session_log.jsonl"),
      JSON.stringify({ fund: FUND_A, session_type: "pre_market", started_at: today, trades_executed: 0, summary: "", cost_usd: 2.0 }) + "\n",
      "utf-8",
    );
    await writeFile(
      join(tmpRoot, "funds", FUND_B, "state", "session_log.jsonl"),
      JSON.stringify({ fund: FUND_B, session_type: "pre_market", started_at: today, trades_executed: 0, summary: "", cost_usd: 4.0 }) + "\n",
      "utf-8",
    );

    mockedListFundNames.mockResolvedValue([FUND_A, FUND_B]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.totalUsd).toBeCloseTo(2.0, 2);
    expect(map.get(FUND_B)?.totalUsd).toBeCloseTo(4.0, 2);
  });

  it("uses fund.budget.dailyCapUsd when set (cascade)", async () => {
    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_CAP_10);
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.cap).toBe(10);
  });

  it("falls back to global cap when fund cap unset", async () => {
    mockedListFundNames.mockResolvedValue([FUND_A]);
    mockedLoadFundConfig.mockResolvedValue(FUND_CONFIG_NO_BUDGET);
    mockedLoadGlobalConfig.mockResolvedValue({ budget: { dailyCapUsd: 8 } } as never);

    const map = await getDailyUsagePerFund();
    expect(map.get(FUND_A)?.cap).toBe(8);
  });

  it("omits a fund whose config load throws — does NOT abort the entire dashboard", async () => {
    mockedListFundNames.mockResolvedValue([FUND_A, FUND_B]);
    mockedLoadFundConfig.mockImplementation(async (name: string) => {
      if (name === FUND_A) throw new Error("corrupt YAML");
      return FUND_CONFIG_NO_BUDGET;
    });
    mockedLoadGlobalConfig.mockResolvedValue({} as never);

    const map = await getDailyUsagePerFund();
    expect(map.has(FUND_A)).toBe(false);
    expect(map.get(FUND_B)?.totalUsd).toBe(0);
    expect(map.get(FUND_B)?.cap).toBe(90);
  });
});
