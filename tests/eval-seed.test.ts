import { describe, it, expect, afterEach } from "vitest";
import { readFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { seedEvalFund } from "../src/services/eval/seed.js";
import { fundPaths } from "../src/paths.js";
import { openWatchlistDb, queryWatchlist } from "../src/services/watchlist.service.js";
import type { EvalFundState } from "../src/types.js";

const minimalState: EvalFundState = {
  fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
  portfolio: { cash: 10000, positions: [] },
  tracker: { progress_pct: 0, status: "on_track" },
  watchlist: [],
};

const stateWithWatchlist: EvalFundState = {
  ...minimalState,
  watchlist: [
    { ticker: "NVDA", status: "candidate", peak_score: 0.9, screens: ["momentum-12-1"], first_surfaced_days_ago: 7 },
    { ticker: "AMD",  status: "watching",  peak_score: 0.7, screens: ["momentum-12-1"], first_surfaced_days_ago: 3 },
  ],
};

describe("seedEvalFund", () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it("creates a fund dir named fundx-eval-<ulid> and writes state files", async () => {
    const handle = await seedEvalFund(minimalState);
    cleanup = handle.cleanup;

    expect(handle.fundName).toMatch(/^fundx-eval-[a-f0-9]+$/);
    const paths = fundPaths(handle.fundName);

    const cfgRaw = await readFile(paths.config, "utf8");
    const cfg = yaml.load(cfgRaw) as Record<string, unknown>;
    expect((cfg as { objective?: { type?: string } }).objective?.type).toBe("runway");

    const portRaw = await readFile(paths.state.portfolio, "utf8");
    const port = JSON.parse(portRaw);
    expect(port.cash).toBe(10000);
    expect(port.positions).toEqual([]);

    await access(paths.state.tracker, constants.F_OK);
    await access(paths.claudeMd, constants.F_OK);
    await access(join(paths.claudeDir, "skills", "opportunity-screening", "SKILL.md"), constants.F_OK);
    await access(join(paths.claudeDir, "rules", "state-consistency.md"), constants.F_OK);
  });

  it("seeds the watchlist DB at the override path and sets the env var", async () => {
    const handle = await seedEvalFund(stateWithWatchlist);
    cleanup = handle.cleanup;

    expect(process.env.FUNDX_WATCHLIST_DB_PATH).toBe(handle.watchlistDbPath);

    const db = openWatchlistDb(handle.watchlistDbPath);
    try {
      const entries = queryWatchlist(db, { limit: 10 });
      expect(entries).toHaveLength(2);
      const tickers = entries.map((e) => e.ticker).sort();
      expect(tickers).toEqual(["AMD", "NVDA"]);
    } finally {
      db.close();
    }
  });

  it("rejects any fundName NOT starting with fundx-eval-", async () => {
    await expect(
      seedEvalFund(minimalState, { generateFundName: () => "my-real-fund" }),
    ).rejects.toThrow(/must start with "fundx-eval-"/);
  });
});

describe("cleanupEvalFund", () => {
  it("removes fund dir, tempdir, and restores env var", async () => {
    const before = process.env.FUNDX_WATCHLIST_DB_PATH;
    const handle = await seedEvalFund(minimalState);
    const fundDir = fundPaths(handle.fundName).root;
    expect(process.env.FUNDX_WATCHLIST_DB_PATH).toBe(handle.watchlistDbPath);

    await handle.cleanup();

    await expect(access(fundDir, constants.F_OK)).rejects.toBeDefined();
    await expect(access(handle.watchlistDbPath, constants.F_OK)).rejects.toBeDefined();
    expect(process.env.FUNDX_WATCHLIST_DB_PATH).toBe(before);
  });

  it("is idempotent — calling cleanup twice does not throw", async () => {
    const handle = await seedEvalFund(minimalState);
    await handle.cleanup();
    await expect(handle.cleanup()).resolves.toBeUndefined();
  });
});
