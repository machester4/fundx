import { describe, it, expect, vi, beforeEach } from "vitest";

const mockedReadFile = vi.fn();
const mockedWriteFile = vi.fn();
const mockedReaddir = vi.fn();
const mockedMkdir = vi.fn();
const mockedRm = vi.fn();
const mockedExistsSync = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockedReadFile(...args),
  writeFile: (...args: unknown[]) => mockedWriteFile(...args),
  readdir: (...args: unknown[]) => mockedReaddir(...args),
  mkdir: (...args: unknown[]) => mockedMkdir(...args),
  rm: (...args: unknown[]) => mockedRm(...args),
}));

vi.mock("node:fs", () => ({
  existsSync: (...args: unknown[]) => mockedExistsSync(...args),
}));

vi.mock("../src/paths.js", () => ({
  FUNDS_DIR: "/home/test/.fundx/funds",
  WORKSPACE: "/home/test/.fundx",
  WORKSPACE_CLAUDE_DIR: "/home/test/.fundx/.claude",
  fundPaths: (name: string) => ({
    root: `/home/test/.fundx/funds/${name}`,
    config: `/home/test/.fundx/funds/${name}/fund_config.yaml`,
    claudeMd: `/home/test/.fundx/funds/${name}/CLAUDE.md`,
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

vi.mock("../src/template.js", () => ({
  generateFundClaudeMd: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn().mockResolvedValue({
    default_model: "sonnet",
    broker: { mode: "paper" },
    telegram: { enabled: false },
  }),
}));

import { loadFundConfig, saveFundConfig, listFundNames, resolveWizardUniverseChoice, normalizeWizardUniverse } from "../src/services/fund.service.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockResolvedValue(undefined);
});

const VALID_FUND_YAML = `
fund:
  name: runway
  display_name: Runway Fund
  description: My runway fund
  created: "2026-01-01"
  status: active
capital:
  initial: 30000
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

describe("loadFundConfig", () => {
  it("loads and validates a fund config from YAML", async () => {
    mockedReadFile.mockResolvedValue(VALID_FUND_YAML);

    const config = await loadFundConfig("runway");
    expect(config.fund.name).toBe("runway");
    expect(config.fund.display_name).toBe("Runway Fund");
    expect(config.capital.initial).toBe(30000);
    expect(config.objective.type).toBe("runway");
    expect(config.broker.mode).toBe("paper");
  });

  it("throws on invalid YAML", async () => {
    mockedReadFile.mockResolvedValue("invalid: :::yaml");
    await expect(loadFundConfig("bad")).rejects.toThrow();
  });

  it("throws on missing required fields", async () => {
    mockedReadFile.mockResolvedValue("fund:\n  name: test\n");
    await expect(loadFundConfig("test")).rejects.toThrow();
  });

  it("throws when file doesn't exist", async () => {
    mockedReadFile.mockRejectedValue(new Error("ENOENT"));
    await expect(loadFundConfig("nonexistent")).rejects.toThrow();
  });
});

describe("saveFundConfig", () => {
  it("creates directory and writes YAML", async () => {
    const config = await (async () => {
      mockedReadFile.mockResolvedValue(VALID_FUND_YAML);
      return loadFundConfig("runway");
    })();

    await saveFundConfig(config);

    expect(mockedMkdir).toHaveBeenCalledWith(
      expect.stringContaining("runway"),
      { recursive: true },
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("fund_config.yaml"),
      expect.stringContaining("runway"),
      "utf-8",
    );
  });
});

describe("listFundNames", () => {
  it("returns directory names from FUNDS_DIR", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      { name: "runway", isDirectory: () => true },
      { name: "growth", isDirectory: () => true },
      { name: ".gitkeep", isDirectory: () => false },
    ]);

    const names = await listFundNames();
    expect(names).toEqual(["runway", "growth"]);
  });

  it("returns empty array when FUNDS_DIR doesn't exist", async () => {
    mockedExistsSync.mockReturnValue(false);

    const names = await listFundNames();
    expect(names).toEqual([]);
  });

  it("filters out files (only returns directories)", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockResolvedValue([
      { name: "notes.md", isDirectory: () => false },
      { name: "my-fund", isDirectory: () => true },
    ]);

    const names = await listFundNames();
    expect(names).toEqual(["my-fund"]);
  });
});

describe("resolveWizardUniverseChoice", () => {
  it("sp500 → preset", () => {
    expect(resolveWizardUniverseChoice("sp500")).toEqual({
      preset: "sp500",
      include_tickers: [],
      exclude_tickers: [],
      exclude_sectors: [],
    });
  });
  it("nasdaq100 → preset", () => {
    expect(resolveWizardUniverseChoice("nasdaq100").preset).toBe("nasdaq100");
  });
  it("dow30 → preset", () => {
    expect(resolveWizardUniverseChoice("dow30").preset).toBe("dow30");
  });
  it("tmpl-large → filters with market_cap_min 10B", () => {
    const u = resolveWizardUniverseChoice("tmpl-large");
    expect(u.filters?.market_cap_min).toBe(10_000_000_000);
    expect(u.filters?.exchange).toEqual(["NYSE", "NASDAQ"]);
  });
  it("tmpl-mid → filters with market_cap_max 10B and market_cap_min 2B", () => {
    const u = resolveWizardUniverseChoice("tmpl-mid");
    expect(u.filters?.market_cap_max).toBe(10_000_000_000);
    expect(u.filters?.market_cap_min).toBe(2_000_000_000);
  });
  it("custom → filters with just is_actively_trading", () => {
    const u = resolveWizardUniverseChoice("custom");
    expect(u.filters?.is_actively_trading).toBe(true);
  });
  it("include_tickers passed through", () => {
    const u = resolveWizardUniverseChoice("sp500", ["TSM", "ASML"]);
    expect(u.include_tickers).toEqual(["TSM", "ASML"]);
  });
  it("unknown choice defaults to custom filters", () => {
    const u = resolveWizardUniverseChoice("unknown-preset");
    expect(u.filters?.is_actively_trading).toBe(true);
  });
});

describe("normalizeWizardUniverse", () => {
  it("parses comma-separated tickers, uppercases and trims", () => {
    const u = normalizeWizardUniverse({ universeChoice: "sp500", tickers: "tsm, asml , " });
    expect(u.include_tickers).toEqual(["TSM", "ASML"]);
  });
  it("handles empty tickers string", () => {
    const u = normalizeWizardUniverse({ universeChoice: "sp500", tickers: "" });
    expect(u.include_tickers).toEqual([]);
  });
  it("defaults to sp500 when universeChoice is undefined", () => {
    const u = normalizeWizardUniverse({ tickers: "" });
    expect(u.preset).toBe("sp500");
  });
});
