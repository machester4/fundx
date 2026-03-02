import { describe, it, expect, vi, beforeEach } from "vitest";

const mockedReadFile = vi.fn();
const mockedWriteFile = vi.fn();
const mockedMkdir = vi.fn();
const mockedRm = vi.fn();
const mockedReaddir = vi.fn();
const mockedExistsSync = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockedReadFile(...args),
  writeFile: (...args: unknown[]) => mockedWriteFile(...args),
  mkdir: (...args: unknown[]) => mockedMkdir(...args),
  rm: (...args: unknown[]) => mockedRm(...args),
  readdir: (...args: unknown[]) => mockedReaddir(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockedExistsSync(...args),
}));

vi.mock("../src/paths.js", () => ({
  WORKSPACE: "/home/test/.fundx",
  WORKSPACE_CLAUDE_DIR: "/home/test/.fundx/.claude",
  FUNDS_DIR: "/home/test/.fundx/funds",
  fundPaths: (name: string) => ({
    root: `/home/test/.fundx/funds/${name}`,
    config: `/home/test/.fundx/funds/${name}/fund_config.yaml`,
    claudeMd: `/home/test/.fundx/funds/${name}/CLAUDE.md`,
    claudeDir: `/home/test/.fundx/funds/${name}/.claude`,
    claudeSkillsDir: `/home/test/.fundx/funds/${name}/.claude/skills`,
    state: {
      dir: `/home/test/.fundx/funds/${name}/state`,
      portfolio: `/home/test/.fundx/funds/${name}/state/portfolio.json`,
      tracker: `/home/test/.fundx/funds/${name}/state/objective_tracker.json`,
      journal: `/home/test/.fundx/funds/${name}/state/trade_journal.sqlite`,
      sessionLog: `/home/test/.fundx/funds/${name}/state/session_log.json`,
    },
    analysis: `/home/test/.fundx/funds/${name}/analysis`,
    scripts: `/home/test/.fundx/funds/${name}/scripts`,
    reports: `/home/test/.fundx/funds/${name}/reports`,
  }),
}));

vi.mock("../src/state.js", () => ({
  initFundState: vi.fn(),
}));

const mockedGenerateFundClaudeMd = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/template.js", () => ({
  generateFundClaudeMd: (...args: unknown[]) => mockedGenerateFundClaudeMd(...args),
}));

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn().mockResolvedValue({
    default_model: "sonnet",
    broker: { provider: "alpaca", mode: "paper" },
    telegram: { enabled: false },
  }),
}));

import { upgradeFund } from "../src/services/fund.service.js";
import { BUILTIN_SKILLS } from "../src/skills.js";

const VALID_FUND_YAML = `
fund:
  name: test-fund
  display_name: Test Fund
  description: A test fund
  created: "2026-01-01"
  status: active
capital:
  initial: 10000
  currency: USD
objective:
  type: runway
  target_months: 18
  monthly_burn: 2000
  min_reserve_months: 3
risk:
  profile: moderate
  max_drawdown_pct: 15
  max_position_pct: 25
universe:
  allowed: []
  forbidden: []
schedule:
  sessions: {}
broker:
  provider: alpaca
  mode: paper
claude:
  model: sonnet
`;

beforeEach(() => {
  vi.clearAllMocks();
  mockedReadFile.mockResolvedValue(VALID_FUND_YAML);
  mockedWriteFile.mockResolvedValue(undefined);
  mockedMkdir.mockResolvedValue(undefined);
  mockedRm.mockResolvedValue(undefined);
  mockedExistsSync.mockReturnValue(false);
});

describe("upgradeFund", () => {
  it("regenerates CLAUDE.md from fund config", async () => {
    await upgradeFund("test-fund");

    expect(mockedGenerateFundClaudeMd).toHaveBeenCalledTimes(1);
    expect(mockedGenerateFundClaudeMd).toHaveBeenCalledWith(
      expect.objectContaining({ fund: expect.objectContaining({ name: "test-fund" }) }),
    );
  });

  it("wipes the skills directory before rewriting", async () => {
    await upgradeFund("test-fund");

    expect(mockedRm).toHaveBeenCalledWith(
      "/home/test/.fundx/funds/test-fund/.claude/skills",
      { recursive: true, force: true },
    );
  });

  it("rewrites all builtin skills", async () => {
    await upgradeFund("test-fund");

    // mkdir is called once per skill
    expect(mockedMkdir).toHaveBeenCalledTimes(BUILTIN_SKILLS.length);
    // writeFile is called once per skill (SKILL.md) — CLAUDE.md is handled by mocked generateFundClaudeMd
    expect(mockedWriteFile).toHaveBeenCalledTimes(BUILTIN_SKILLS.length);
  });

  it("returns fund name and skill count", async () => {
    const result = await upgradeFund("test-fund");

    expect(result.fundName).toBe("test-fund");
    expect(result.skillCount).toBe(BUILTIN_SKILLS.length);
  });

  it("throws when fund config is invalid", async () => {
    mockedReadFile.mockResolvedValue("invalid: :::yaml");

    await expect(upgradeFund("bad-fund")).rejects.toThrow();
  });

  it("throws when fund does not exist", async () => {
    mockedReadFile.mockRejectedValue(new Error("ENOENT: no such file"));

    await expect(upgradeFund("nonexistent")).rejects.toThrow("ENOENT");
  });

  it("skills are written after rm completes", async () => {
    const callOrder: string[] = [];
    mockedRm.mockImplementation(async () => { callOrder.push("rm"); });
    mockedMkdir.mockImplementation(async () => { callOrder.push("mkdir"); });

    await upgradeFund("test-fund");

    const rmIndex = callOrder.indexOf("rm");
    const firstMkdir = callOrder.indexOf("mkdir");
    expect(rmIndex).toBeLessThan(firstMkdir);
  });
});
