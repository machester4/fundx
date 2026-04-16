import type Database from "better-sqlite3";
import type { DailyBar, ScoreMetadata, FundConfig, ScreenName, UniverseResolution } from "../types.js";
import {
  insertScreenRun,
  insertScore,
  applyTransitionsForRun,
  tagFundCompatibilityForTickers,
} from "./watchlist.service.js";
import {
  readBars,
  isFresh,
  writeBars,
} from "./price-cache.service.js";
import { openSync, closeSync, unlinkSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { WATCHLIST_DB } from "../paths.js";

const LOOKBACK_TOTAL_DAYS = 273;
const SKIP_RECENT_DAYS = 21;
const BASE_DAYS = 252;
const ADV_WINDOW_DAYS = 30;

export interface MomentumScore {
  score: number;
  return_12_1: number;
  adv_usd_30d: number;
  last_price: number;
  missing_days: number;
}

export function scoreMomentum121(bars: DailyBar[]): MomentumScore | null {
  if (bars.length < LOOKBACK_TOTAL_DAYS) return null;
  const n = bars.length;
  const tMinus21 = bars[n - 1 - SKIP_RECENT_DAYS];
  const tMinus252 = bars[n - 1 - SKIP_RECENT_DAYS - (BASE_DAYS - SKIP_RECENT_DAYS)];
  if (!tMinus21 || !tMinus252 || tMinus252.close === 0) return null;
  const return_12_1 = tMinus21.close / tMinus252.close - 1;

  const last30 = bars.slice(-ADV_WINDOW_DAYS);
  const adv_usd_30d =
    last30.reduce((s, b) => s + b.close * b.volume, 0) / ADV_WINDOW_DAYS;

  return {
    score: return_12_1,
    return_12_1,
    adv_usd_30d,
    last_price: bars[n - 1].close,
    missing_days: Math.max(0, LOOKBACK_TOTAL_DAYS - bars.length),
  };
}

export function metadataFromScore(ms: MomentumScore): ScoreMetadata {
  return {
    return_12_1: ms.return_12_1,
    adv_usd_30d: ms.adv_usd_30d,
    last_price: ms.last_price,
    missing_days: ms.missing_days,
  };
}

const MIN_PRICE = 5;
const MIN_ADV_USD = 10_000_000;
const TOP_DECILE_FRACTION = 0.10;

const STALE_LOCK_MS = 30 * 60 * 1000; // 30 min: if a lock is older than this, assume crashed and reclaim

function lockPath(): string {
  return join(dirname(WATCHLIST_DB), "screening.lock");
}

/**
 * Acquire an exclusive file lock for the screening run.
 * Throws a user-readable error if another run is in progress.
 * Stale locks (>30 min old) are auto-reclaimed — previous run likely crashed.
 */
function acquireLock(now: number): number {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const age = now - statSync(path).mtimeMs;
    if (age < STALE_LOCK_MS) {
      throw new Error(
        `Another screening run is in progress (lock age ${Math.round(age / 1000)}s). ` +
          `If you believe this is stale, delete ${path} and retry.`,
      );
    }
    // Stale — reclaim
    try {
      unlinkSync(path);
    } catch {
      // ignore; openSync below will fail if truly locked
    }
  }
  const fd = openSync(path, "wx");
  return fd;
}

function releaseLock(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // best effort
  }
  try {
    unlinkSync(lockPath());
  } catch {
    // best effort — if already gone, fine
  }
}

export interface RunScreenOptions {
  watchlistDb: Database.Database;
  priceCacheDb: Database.Database;
  universe: string[];
  universeLabel: string;
  fetchBars: (ticker: string) => Promise<DailyBar[]>;
  fundConfigs: FundConfig[];
  /** Map of fund name → resolved universe. Used to tag watchlist compatibility. Pass new Map() if not applicable. */
  resolutions: Map<string, UniverseResolution>;
  /** Optional sector lookup for sector-exclusion tagging accuracy. */
  getSector?: (ticker: string) => Promise<string | null>;
  now: number;
  screenName?: ScreenName;
}

export interface RunScreenSummary {
  run_id: number;
  screen_name: ScreenName;
  universe: string;
  tickers_scored: number;
  tickers_passed: number;
  duration_ms: number;
  top_ten: Array<{ ticker: string; score: number }>;
}

export async function runScreen(
  opts: RunScreenOptions,
): Promise<RunScreenSummary> {
  const fd = acquireLock(opts.now);
  try {
  const started = Date.now();
  const screenName: ScreenName = opts.screenName ?? "momentum-12-1";
  const parameters = {
    screenName,
    min_price: MIN_PRICE,
    min_adv_usd: MIN_ADV_USD,
    top_decile_fraction: TOP_DECILE_FRACTION,
  };

  type Scored = { ticker: string; score: MomentumScore | null };
  const scored: Scored[] = [];
  for (const ticker of opts.universe) {
    let bars: DailyBar[];
    if (isFresh(opts.priceCacheDb, ticker, opts.now)) {
      bars = readBars(opts.priceCacheDb, ticker);
    } else {
      try {
        bars = await opts.fetchBars(ticker);
        writeBars(opts.priceCacheDb, ticker, bars, opts.now);
      } catch (err) {
        console.warn(
          `[screen:${screenName}] fetchBars failed for ${ticker}: ${(err as Error).message}`,
        );
        continue;
      }
    }
    scored.push({ ticker, score: scoreMomentum121(bars) });
  }

  const eligible = scored.filter(
    (s): s is { ticker: string; score: MomentumScore } => {
      if (!s.score) return false;
      if (s.score.last_price < MIN_PRICE) return false;
      if (s.score.adv_usd_30d < MIN_ADV_USD) return false;
      return true;
    },
  );
  eligible.sort((a, b) => b.score.score - a.score.score);
  const cutoff = Math.max(1, Math.floor(eligible.length * TOP_DECILE_FRACTION));
  const passedSet = new Set(
    eligible
      .slice(0, cutoff)
      .filter((s) => s.score.score > 0)
      .map((s) => s.ticker),
  );

  const runId = insertScreenRun(opts.watchlistDb, {
    screen_name: screenName,
    universe: opts.universeLabel,
    ran_at: opts.now,
    tickers_scored: scored.length,
    tickers_passed: passedSet.size,
    duration_ms: Date.now() - started,
    parameters_json: JSON.stringify(parameters),
  });

  const insertTx = opts.watchlistDb.transaction(() => {
    for (const s of scored) {
      if (!s.score) continue;
      insertScore(opts.watchlistDb, {
        run_id: runId,
        ticker: s.ticker,
        screen_name: screenName,
        score: s.score.score,
        passed: passedSet.has(s.ticker),
        metadata: metadataFromScore(s.score),
        scored_at: opts.now,
      });
    }
  });
  insertTx();

  applyTransitionsForRun(opts.watchlistDb, runId, opts.now);

  if (opts.resolutions.size > 0 && passedSet.size > 0) {
    await tagFundCompatibilityForTickers(
      opts.watchlistDb,
      opts.resolutions,
      [...passedSet],
      opts.now,
      { getSector: opts.getSector },
    );
  }

  const topTen = eligible.slice(0, 10).map((s) => ({
    ticker: s.ticker,
    score: s.score.score,
  }));

  return {
    run_id: runId,
    screen_name: screenName,
    universe: opts.universeLabel,
    tickers_scored: scored.length,
    tickers_passed: passedSet.size,
    duration_ms: Date.now() - started,
    top_ten: topTen,
  };
  } finally {
    releaseLock(fd);
  }
}
