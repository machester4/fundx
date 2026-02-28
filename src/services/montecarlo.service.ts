import { loadFundConfig } from "./fund.service.js";
import { readPortfolio } from "../state.js";
import { openJournal, getTradesInDays } from "../journal.js";
import type { MonteCarloResult, TradeRecord } from "../types.js";

// ── Monte Carlo Engine ───────────────────────────────────────

/**
 * Simple pseudo-random number generator (seeded).
 * Uses a linear congruential generator for reproducibility.
 */
function createRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff;
  };
}

/**
 * Generate a normally distributed random number using Box-Muller transform.
 */
function normalRandom(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) *
    Math.cos(2 * Math.PI * u2);
}

/**
 * Estimate monthly return statistics from trade history.
 */
function estimateReturns(
  trades: TradeRecord[],
  portfolioValue: number,
): { mean: number; std: number } {
  if (trades.length === 0 || portfolioValue === 0) {
    // Default: conservative assumption
    return { mean: 0.005, std: 0.04 }; // 0.5% monthly mean, 4% std
  }

  // Group realized P&L by month
  const monthlyPnl = new Map<string, number>();
  for (const t of trades) {
    if (t.pnl === undefined || t.pnl === null) continue;
    const date = t.closed_at?.split("T")[0] ?? t.timestamp.split("T")[0];
    const monthKey = date.slice(0, 7); // YYYY-MM
    const current = monthlyPnl.get(monthKey) ?? 0;
    monthlyPnl.set(monthKey, current + t.pnl);
  }

  if (monthlyPnl.size === 0) {
    return { mean: 0.005, std: 0.04 };
  }

  // Convert to returns
  const returns = [...monthlyPnl.values()].map(
    (pnl) => pnl / portfolioValue,
  );

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    Math.max(returns.length - 1, 1);
  const std = Math.sqrt(variance);

  return {
    mean: isFinite(mean) ? mean : 0.005,
    std: isFinite(std) && std > 0 ? std : 0.04,
  };
}

/**
 * Run Monte Carlo simulation for portfolio projections.
 */
export function runMonteCarloSimulation(
  initialValue: number,
  monthlyReturn: { mean: number; std: number },
  horizonMonths: number,
  numSimulations: number,
  monthlyBurn?: number,
  seed: number = 42,
): MonteCarloResult {
  const rng = createRng(seed);
  const finalValues: number[] = [];
  const ruinCount = { value: 0 };
  const runwayMonths: number[] = [];

  for (let sim = 0; sim < numSimulations; sim++) {
    let value = initialValue;
    let runwayMonth = horizonMonths;

    for (let month = 0; month < horizonMonths; month++) {
      // Apply random return
      const ret =
        monthlyReturn.mean + monthlyReturn.std * normalRandom(rng);
      value *= 1 + ret;

      // Apply monthly burn if specified
      if (monthlyBurn !== undefined) {
        value -= monthlyBurn;
      }

      // Check for ruin (value <= 0)
      if (value <= 0) {
        value = 0;
        runwayMonth = month + 1;
        ruinCount.value++;
        break;
      }
    }

    finalValues.push(value);
    if (monthlyBurn !== undefined) {
      runwayMonths.push(runwayMonth);
    }
  }

  // Sort for percentile calculation
  finalValues.sort((a, b) => a - b);
  runwayMonths.sort((a, b) => a - b);

  const percentile = (arr: number[], p: number): number => {
    const index = Math.ceil(p * arr.length) - 1;
    return arr[Math.max(0, Math.min(index, arr.length - 1))];
  };

  const mean =
    finalValues.reduce((a, b) => a + b, 0) / finalValues.length;
  const variance =
    finalValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) /
    finalValues.length;

  const result: MonteCarloResult = {
    fund: "",
    simulations: numSimulations,
    horizon_months: horizonMonths,
    computed_at: new Date().toISOString(),
    percentiles: {
      p5: percentile(finalValues, 0.05),
      p10: percentile(finalValues, 0.1),
      p25: percentile(finalValues, 0.25),
      p50: percentile(finalValues, 0.5),
      p75: percentile(finalValues, 0.75),
      p90: percentile(finalValues, 0.9),
      p95: percentile(finalValues, 0.95),
    },
    probability_of_ruin: ruinCount.value / numSimulations,
    mean_final_value: mean,
    std_final_value: Math.sqrt(variance),
    monthly_return_mean: monthlyReturn.mean,
    monthly_return_std: monthlyReturn.std,
  };

  if (monthlyBurn !== undefined && runwayMonths.length > 0) {
    result.runway_months = {
      p5: percentile(runwayMonths, 0.05),
      p25: percentile(runwayMonths, 0.25),
      p50: percentile(runwayMonths, 0.5),
      p75: percentile(runwayMonths, 0.75),
      p95: percentile(runwayMonths, 0.95),
    };
  }

  return result;
}

/**
 * Run a Monte Carlo simulation for a specific fund.
 */
export async function runFundMonteCarlo(
  fundName: string,
  options?: {
    simulations?: number;
    horizonMonths?: number;
    seed?: number;
  },
): Promise<MonteCarloResult> {
  const config = await loadFundConfig(fundName);
  const portfolio = await readPortfolio(fundName);

  const simulations = options?.simulations ?? 10000;
  const seed = options?.seed ?? 42;

  // Determine horizon
  let horizonMonths = options?.horizonMonths ?? 12;
  let monthlyBurn: number | undefined;

  if (config.objective.type === "runway") {
    horizonMonths = config.objective.target_months;
    monthlyBurn = config.objective.monthly_burn;
  } else if (
    config.objective.type === "growth" &&
    config.objective.timeframe_months
  ) {
    horizonMonths = config.objective.timeframe_months;
  }

  // Estimate returns from trade history
  let trades: TradeRecord[] = [];
  try {
    const db = openJournal(fundName);
    try {
      trades = getTradesInDays(db, fundName, 365);
    } finally {
      db.close();
    }
  } catch {
    // No journal
  }

  const returns = estimateReturns(trades, portfolio.total_value);

  const result = runMonteCarloSimulation(
    portfolio.total_value,
    returns,
    horizonMonths,
    simulations,
    monthlyBurn,
    seed,
  );

  result.fund = fundName;
  return result;
}
