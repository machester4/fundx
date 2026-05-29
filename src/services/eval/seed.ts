// src/services/eval/seed.ts
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { FUNDS_DIR, fundPaths } from "../../paths.js";
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
import { EVAL_FUND_PREFIX, loadFundConfig } from "../fund.service.js";
import { openJournal } from "../../journal.js";
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
    await seedCurrentHandoff(paths.state.sessionHandoff, state);
    await seedHandoffs(paths.state.handoffsDir, state);
    await seedJournal(fundName, state);
  } catch (err) {
    await cleanup();
    throw err;
  }

  return { fundName, watchlistDbPath, cleanup };
}

export async function cleanupEvalFund(handle: SeedEvalFundHandle): Promise<void> {
  await handle.cleanup();
}

export interface SweepEvalOrphansResult {
  /** Names of `fundx-eval-*` directories removed (sorted) */
  removed: string[];
  /** Names of `fundx-eval-*` directories kept because they were younger than minAgeMs */
  kept: string[];
}

/** Remove leftover `fundx-eval-*` fund directories from a previous interrupted
 *  eval run. The seed cleanup path runs in a `finally`, so a SIGKILL / closed
 *  terminal / OOM leaves directories behind. The daemon then iterates them as
 *  if they were real funds (news_reaction, universe refresh, stop-loss),
 *  burning Claude API spend on synthetic data.
 *
 *  `minAgeMs` (default 30 min) protects concurrent eval runs: any dir created
 *  more recently is treated as belonging to a sibling process and skipped. */
export async function sweepEvalOrphans(
  opts: { minAgeMs?: number } = {},
): Promise<SweepEvalOrphansResult> {
  const minAgeMs = opts.minAgeMs ?? 30 * 60 * 1000;
  const removed: string[] = [];
  const kept: string[] = [];

  let entries;
  try {
    entries = await readdir(FUNDS_DIR, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed, kept };
    throw err;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(EVAL_FUND_PREFIX)) continue;
    const dirPath = join(FUNDS_DIR, entry.name);
    const s = await stat(dirPath);
    const ageMs = now - s.mtimeMs;
    if (ageMs < minAgeMs) {
      kept.push(entry.name);
      continue;
    }
    await rm(dirPath, { recursive: true, force: true });
    removed.push(entry.name);
  }
  removed.sort();
  kept.sort();
  return { removed, kept };
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
    // Mirror the default fund schedule so surface=autonomous cases can run a
    // real session type (chat/ask ignore the schedule). Kept in sync with the
    // defaults in fund.service.ts createFund.
    schedule: {
      sessions: {
        pre_market: {
          time: "09:00",
          enabled: true,
          focus: "Analyze overnight developments. Plan trades.",
        },
        mid_session: {
          time: "13:00",
          enabled: true,
          focus: "Monitor positions. React to intraday moves.",
        },
        post_market: {
          time: "18:00",
          enabled: true,
          focus: "Review day. Update journal. Generate report.",
        },
      },
    },
    broker: {
      mode: "paper",
    },
    claude: {
      model: "claude-sonnet-4-6",
      personality: "concise senior PM",
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

/** Seed the current session-handoff.md. The autonomous state_snapshot envelope
 *  reads this file, so it carries inherited context (e.g. an accumulated
 *  entry-gate framework) into the session being evaluated. */
async function seedCurrentHandoff(handoffPath: string, state: EvalFundState): Promise<void> {
  if (!state.handoff_current) return;
  await mkdir(dirname(handoffPath), { recursive: true });
  await writeFile(handoffPath, state.handoff_current, "utf-8");
}

/** Seed archived handoff files into state/handoffs/.
 *  Each entry's timestamp is used both in the filename and to set the
 *  file's mtime so that listHandoffsSince (which filters by mtime) picks
 *  them up correctly during the meta_reflection eval run. */
async function seedHandoffs(handoffsDir: string, state: EvalFundState): Promise<void> {
  if (!state.handoffs || state.handoffs.length === 0) return;
  await mkdir(handoffsDir, { recursive: true });
  for (const h of state.handoffs) {
    const ts = new Date(h.timestamp);
    const isoTs = ts.toISOString().replace(/:/g, "-");
    const filename = `${isoTs}_${h.session_type}.md`;
    const filePath = join(handoffsDir, filename);
    await writeFile(filePath, h.content, "utf-8");
    // Set mtime to the declared timestamp so listHandoffsSince filters correctly.
    await utimes(filePath, ts, ts);
  }
}

/** Seed journal rows (closed trades with lessons) into the fund's trade journal
 *  SQLite database. Only inserts rows if state.journal is non-empty. */
async function seedJournal(fundName: string, state: EvalFundState): Promise<void> {
  if (!state.journal || state.journal.length === 0) return;
  const db = openJournal(fundName);
  try {
    const stmt = db.prepare(`
      INSERT INTO trades (
        timestamp, fund, symbol, side, quantity, price, total_value,
        order_type, closed_at, close_price, pnl_pct, reasoning, lessons_learned
      ) VALUES (
        @timestamp, @fund, @symbol, @side, @quantity, @price, @total_value,
        @order_type, @closed_at, @close_price, @pnl_pct, @reasoning, @lessons_learned
      )
    `);
    for (const row of state.journal) {
      stmt.run({
        timestamp: row.timestamp,
        fund: fundName,
        symbol: row.symbol,
        side: row.side,
        quantity: 1,
        price: row.price,
        total_value: row.price,
        order_type: "market",
        closed_at: row.closed_at ?? null,
        close_price: row.close_price ?? null,
        pnl_pct: row.pnl_pct ?? null,
        reasoning: row.reasoning,
        lessons_learned: row.lessons_learned,
      });
    }
  } finally {
    db.close();
  }
}
