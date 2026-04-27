// src/services/eval/seed.ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { fundPaths } from "../../paths.js";
import { writeJsonAtomic } from "../../state.js";
import { generateFundClaudeMd } from "../../template.js";
import { ensureFundSkillFiles, ensureFundRules } from "../../skills.js";
import {
  openWatchlistDb,
  insertScreenRun,
  insertScore,
  tagWatchlistForFundDirect,
  applyTransitionsForRun,
} from "../watchlist.service.js";
import { loadFundConfig } from "../fund.service.js";
import type { EvalFundState, FundConfig } from "../../types.js";

export interface SeedEvalFundHandle {
  fundName: string;
  watchlistDbPath: string;
  cleanup: () => Promise<void>;
}

export interface SeedEvalFundOptions {
  /** Override the name generator (test-only). Default: `fundx-eval-<uuid-prefix>` */
  generateFundName?: () => string;
}

const DAY_MS = 24 * 3600 * 1000;

export async function seedEvalFund(
  state: EvalFundState,
  opts: SeedEvalFundOptions = {},
): Promise<SeedEvalFundHandle> {
  const fundName = (opts.generateFundName ?? defaultFundName)();
  if (!fundName.startsWith("fundx-eval-")) {
    throw new Error(`Generated fund name must start with "fundx-eval-", got: ${fundName}`);
  }

  const paths = fundPaths(fundName);
  const tempRoot = await mkdtemp(join(tmpdir(), "fundx-eval-db-"));
  const watchlistDbPath = join(tempRoot, "watchlist.sqlite");

  const prevEnv = process.env.FUNDX_WATCHLIST_DB_PATH;
  process.env.FUNDX_WATCHLIST_DB_PATH = watchlistDbPath;

  let cleanupDone = false;
  async function cleanup(): Promise<void> {
    if (cleanupDone) return;
    cleanupDone = true;
    if (prevEnv === undefined) delete process.env.FUNDX_WATCHLIST_DB_PATH;
    else process.env.FUNDX_WATCHLIST_DB_PATH = prevEnv;
    await rm(paths.root, { recursive: true, force: true });
    await rm(tempRoot, { recursive: true, force: true });
  }

  try {
    await mkdir(paths.root, { recursive: true });
    await seedFundConfig(paths.config, fundName, state);
    const config = await loadFundConfig(fundName);
    await mkdir(dirname(paths.state.portfolio), { recursive: true });
    await seedPortfolio(paths.state.portfolio, state);
    await seedTracker(paths.state.tracker, state, config);
    await generateFundClaudeMd(config);
    await ensureFundSkillFiles(paths.claudeDir);
    await ensureFundRules(paths.claudeDir);
    await seedWatchlist(watchlistDbPath, state, fundName);
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { fundName, watchlistDbPath, cleanup };
}

export async function cleanupEvalFund(handle: SeedEvalFundHandle): Promise<void> {
  await handle.cleanup();
}

// ── private helpers ─────────────────────────────────────────────────

function defaultFundName(): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  return `fundx-eval-${suffix}`;
}

async function seedFundConfig(path: string, fundName: string, state: EvalFundState): Promise<void> {
  const objType = state.fund_config.objective ?? "runway";
  const objective: Record<string, unknown> =
    objType === "runway"
      ? { type: "runway", target_months: 12, monthly_burn: 800 }
      : objType === "growth"
        ? { type: "growth", target_multiple: 2 }
        : objType === "income"
          ? { type: "income", target_monthly_income: 1000 }
          : objType === "accumulation"
            ? { type: "accumulation", target_asset: "BTC", target_amount: 1 }
            : { type: "custom", description: "Eval custom objective" };

  const doc = {
    fund: {
      name: fundName,
      display_name: `Eval ${fundName}`,
      description: "Synthetic fund for prompt evaluation",
      status: "active",
      created: new Date().toISOString(),
    },
    objective,
    capital: {
      initial: state.fund_config.initial_capital ?? 10000,
    },
    risk: {
      profile: state.fund_config.risk_profile ?? "moderate",
    },
    universe: {
      preset: "sp500",
    },
    schedule: {},
    broker: {
      mode: "paper",
    },
    claude: {
      model: "claude-sonnet-4-6",
      personality: "concise senior PM",
    },
    notifications: {
      telegram: {
        enabled: false,
      },
    },
  };
  await writeFile(path, yaml.dump(doc), "utf8");
}

async function seedPortfolio(path: string, state: EvalFundState): Promise<void> {
  const positions = state.portfolio.positions.map((p) => ({
    symbol: p.symbol,
    shares: p.shares,
    avg_cost: p.avg_cost,
    current_price: p.current_price,
    market_value: p.shares * p.current_price,
    unrealized_pnl: p.shares * (p.current_price - p.avg_cost),
    unrealized_pnl_pct: ((p.current_price - p.avg_cost) / p.avg_cost) * 100,
    weight_pct: 0,
    stop_loss: p.avg_cost * 0.9,
    entry_date: new Date().toISOString().slice(0, 10),
    entry_reason: p.entry_reason,
  }));
  const positionValue = positions.reduce((sum, p) => sum + p.market_value, 0);
  const totalValue = state.portfolio.cash + positionValue;
  for (const p of positions) p.weight_pct = totalValue === 0 ? 0 : (p.market_value / totalValue) * 100;

  const doc = {
    last_updated: new Date().toISOString(),
    cash: state.portfolio.cash,
    total_value: totalValue,
    positions,
  };
  await writeJsonAtomic(path, doc);
}

async function seedTracker(path: string, state: EvalFundState, config: FundConfig): Promise<void> {
  const doc = {
    last_updated: new Date().toISOString(),
    initial_capital: config.capital.initial,
    current_value: config.capital.initial + (config.capital.initial * state.tracker.progress_pct) / 100,
    progress_pct: state.tracker.progress_pct,
    status: state.tracker.status,
  };
  await writeJsonAtomic(path, doc);
}

async function seedWatchlist(dbPath: string, state: EvalFundState, fundName: string): Promise<void> {
  if (state.watchlist.length === 0) return;

  await mkdir(dirname(dbPath), { recursive: true });
  const db = openWatchlistDb(dbPath);
  try {
    const now = Date.now();
    for (const entry of state.watchlist) {
      const screen = (entry.screens[0] ?? "momentum-12-1") as "momentum-12-1";
      const surfacedAt = now - entry.first_surfaced_days_ago * DAY_MS;
      const runId = insertScreenRun(db, {
        screen_name: screen,
        universe: "sp500",
        ran_at: surfacedAt,
        tickers_scored: 1,
        tickers_passed: entry.status === "candidate" || entry.status === "watching" ? 1 : 0,
        duration_ms: 0,
        parameters_json: "{}",
      });
      insertScore(db, {
        run_id: runId,
        ticker: entry.ticker,
        score: entry.peak_score ?? 0.5,
        passed: entry.status === "candidate" || entry.status === "watching",
        scored_at: surfacedAt,
        screen_name: screen,
        metadata: {
          return_12_1: entry.peak_score ?? 0.5,
          adv_usd_30d: 1_000_000,
          last_price: 100,
          missing_days: 0,
        },
      });
      applyTransitionsForRun(db, runId, now);
    }
    // Tag every seeded ticker as compatible with the seeded fund so the
    // production fund-scoped watchlist filter (added to buildFundContext) returns
    // the seeded entries during evaluation.
    tagWatchlistForFundDirect(db, fundName, state.watchlist.map((e) => e.ticker), now);
  } finally {
    db.close();
  }
}
