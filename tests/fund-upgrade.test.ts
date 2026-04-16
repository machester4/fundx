import { describe, it, expect, vi, beforeEach } from "vitest";

const mockedReadFile = vi.fn();
const mockedWriteFile = vi.fn();
const mockedCopyFile = vi.fn();
const mockedRename = vi.fn().mockResolvedValue(undefined);
const mockedMkdir = vi.fn();
const mockedRm = vi.fn();
const mockedReaddir = vi.fn();
const mockedExistsSync = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockedReadFile(...args),
  writeFile: (...args: unknown[]) => mockedWriteFile(...args),
  copyFile: (...args: unknown[]) => mockedCopyFile(...args),
  rename: (...args: unknown[]) => mockedRename(...args),
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
    claudeSettings: `/home/test/.fundx/funds/${name}/.claude/settings.json`,
    claudeSkillsDir: `/home/test/.fundx/funds/${name}/.claude/skills`,
    state: {
      dir: `/home/test/.fundx/funds/${name}/state`,
      portfolio: `/home/test/.fundx/funds/${name}/state/portfolio.json`,
      tracker: `/home/test/.fundx/funds/${name}/state/objective_tracker.json`,
      journal: `/home/test/.fundx/funds/${name}/state/trade_journal.sqlite`,
      sessionLog: `/home/test/.fundx/funds/${name}/state/session_log.json`,
      activeSession: `/home/test/.fundx/funds/${name}/state/active_session.json`,
      chatHistory: `/home/test/.fundx/funds/${name}/state/chat_history.json`,
      sessionHistory: `/home/test/.fundx/funds/${name}/state/session_history.json`,
      lock: `/home/test/.fundx/funds/${name}/state/.lock`,
    },
    analysis: `/home/test/.fundx/funds/${name}/analysis`,
    scripts: `/home/test/.fundx/funds/${name}/scripts`,
    reports: `/home/test/.fundx/funds/${name}/reports`,
    claudeRulesDir: `/home/test/.fundx/funds/${name}/.claude/rules`,
    memory: `/home/test/.fundx/funds/${name}/memory`,
  }),
}));

vi.mock("../src/state.js", () => ({
  initFundState: vi.fn(),
  clearActiveSession: vi.fn(),
}));

const mockedGenerateFundClaudeMd = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/template.js", () => ({
  generateFundClaudeMd: (...args: unknown[]) => mockedGenerateFundClaudeMd(...args),
}));

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn().mockResolvedValue({
    default_model: "sonnet",
    broker: { mode: "paper" },
    telegram: { enabled: false },
  }),
}));

import { upgradeFund, isLegacyUniverse, migrateUniverseFromLegacy } from "../src/services/fund.service.js";
import { BUILTIN_SKILLS, getFundRuleCount } from "../src/skills.js";

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
  preset: sp500
schedule:
  sessions: {}
broker:
  mode: paper
claude:
  model: sonnet
`;

beforeEach(() => {
  vi.clearAllMocks();
  mockedReadFile.mockResolvedValue(VALID_FUND_YAML);
  mockedWriteFile.mockResolvedValue(undefined);
  mockedCopyFile.mockResolvedValue(undefined);
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

  it("rewrites all builtin skills and rules", async () => {
    await upgradeFund("test-fund");

    // mkdir is called once per skill + once for rules dir (ensureFundRules) + once for memory dir + once for rules dir again (ensureFundMemory)
    expect(mockedMkdir).toHaveBeenCalledTimes(BUILTIN_SKILLS.length + 3);
    // writeFile is called once per skill (SKILL.md) + once per rule file + 4 memory files + 1 memory-usage rule
    expect(mockedWriteFile).toHaveBeenCalledTimes(BUILTIN_SKILLS.length + getFundRuleCount() + 5);
  });

  it("returns fund name, skill count, migration status and warnings", async () => {
    const result = await upgradeFund("test-fund");

    expect(result.fundName).toBe("test-fund");
    expect(result.skillCount).toBe(BUILTIN_SKILLS.length);
    expect(result.universeMigrated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("clears active session so next chat starts fresh", async () => {
    const { clearActiveSession } = await import("../src/state.js");
    await upgradeFund("test-fund");

    expect(clearActiveSession).toHaveBeenCalledWith("test-fund");
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

  it("migrates legacy universe when detected", async () => {
    const legacyYaml = `
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
  allowed:
    - type: etf
      tickers:
        - SPY
        - QQQ
  forbidden:
    - type: stock
      tickers:
        - TSLA
schedule:
  sessions: {}
broker:
  mode: paper
claude:
  model: sonnet
`;
    // First read is for migration check (legacy), second is for loadFundConfig (after migration writes new schema)
    mockedReadFile
      .mockResolvedValueOnce(legacyYaml)   // maybeMigrateUniverseFile
      .mockResolvedValueOnce(VALID_FUND_YAML); // loadFundConfig after migration

    const result = await upgradeFund("test-fund");

    expect(result.universeMigrated).toBe(true);
    expect(result.warnings).toEqual([]);
    // copyFile should have been called to create .bak
    expect(mockedCopyFile).toHaveBeenCalledWith(
      "/home/test/.fundx/funds/test-fund/fund_config.yaml",
      "/home/test/.fundx/funds/test-fund/fund_config.yaml.bak",
    );
    // writeFile should have been called with the .tmp file (atomic write pattern)
    const writeFileCalls = mockedWriteFile.mock.calls;
    const tmpWrite = writeFileCalls.find((c: unknown[]) =>
      typeof c[0] === "string" && c[0].endsWith("fund_config.yaml.tmp"),
    );
    expect(tmpWrite).toBeDefined();
    // rename should atomically move .tmp → config
    expect(mockedRename).toHaveBeenCalledWith(
      "/home/test/.fundx/funds/test-fund/fund_config.yaml.tmp",
      "/home/test/.fundx/funds/test-fund/fund_config.yaml",
    );
  });

  it("does not migrate when universe is already new schema", async () => {
    const result = await upgradeFund("test-fund");

    expect(mockedCopyFile).not.toHaveBeenCalled();
    expect(result.universeMigrated).toBe(false);
  });
});

describe("isLegacyUniverse", () => {
  it("detects legacy shape via allowed key", () => {
    expect(isLegacyUniverse({ allowed: [], forbidden: [] })).toBe(true);
  });
  it("detects legacy shape via forbidden key only", () => {
    expect(isLegacyUniverse({ forbidden: [] })).toBe(true);
  });
  it("returns false for new schema", () => {
    expect(isLegacyUniverse({ preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] })).toBe(false);
  });
  it("returns false for null/undefined", () => {
    expect(isLegacyUniverse(null)).toBe(false);
    expect(isLegacyUniverse(undefined)).toBe(false);
  });
});

describe("migrateUniverseFromLegacy", () => {
  it("maps forbidden tickers/sectors and allowed tickers to new shape", () => {
    const legacy = {
      allowed: [{ type: "stock", tickers: ["TSM", "ASML"] }],
      forbidden: [{ type: "stock", tickers: ["TSLA"], sectors: ["Energy"] }],
    };
    const migrated = migrateUniverseFromLegacy(legacy);
    expect(migrated).toEqual({
      preset: "sp500",
      include_tickers: ["ASML", "TSM"],
      exclude_tickers: ["TSLA"],
      exclude_sectors: ["Energy"],
    });
  });

  it("handles empty allowed/forbidden", () => {
    expect(migrateUniverseFromLegacy({ allowed: [], forbidden: [] })).toEqual({
      preset: "sp500",
      include_tickers: [],
      exclude_tickers: [],
      exclude_sectors: [],
    });
  });

  it("uppercases tickers", () => {
    const migrated = migrateUniverseFromLegacy({
      allowed: [{ tickers: ["tsm", "asml"] }],
      forbidden: [{ tickers: ["tsla"] }],
    });
    expect(migrated.include_tickers).toEqual(["ASML", "TSM"]);
    expect(migrated.exclude_tickers).toEqual(["TSLA"]);
  });

  it("drops strategies/protocols silently (caller logs warning)", () => {
    const migrated = migrateUniverseFromLegacy({
      allowed: [{ type: "defi", strategies: ["yield-farm"], protocols: ["Aave"] }],
      forbidden: [],
    });
    expect(migrated.include_tickers).toEqual([]);
  });

  it("dedupes across multiple allowed/forbidden entries", () => {
    const migrated = migrateUniverseFromLegacy({
      allowed: [{ tickers: ["TSM"] }, { tickers: ["TSM", "ASML"] }],
      forbidden: [{ tickers: ["TSLA"] }, { tickers: ["TSLA"] }],
    });
    expect(migrated.include_tickers).toEqual(["ASML", "TSM"]);
    expect(migrated.exclude_tickers).toEqual(["TSLA"]);
  });
});
