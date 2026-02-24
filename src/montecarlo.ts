import { Command } from "commander";
import chalk from "chalk";
import { loadFundConfig } from "./fund.js";
import { readPortfolio } from "./state.js";
import { openJournal, getTradesInDays } from "./journal.js";
import type { MonteCarloResult, TradeRecord } from "./types.js";

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

// ── Display Helpers ──────────────────────────────────────────

function renderDistributionBar(
  value: number,
  min: number,
  max: number,
  width: number,
  color: (s: string) => string,
): string {
  const range = max - min || 1;
  const pos = Math.round(((value - min) / range) * width);
  const bar =
    "░".repeat(Math.max(pos, 0)) +
    color("█") +
    "░".repeat(Math.max(width - pos - 1, 0));
  return bar;
}

// ── CLI Commands ───────────────────────────────────────────────

export const monteCarloCommand = new Command("montecarlo").description(
  "Monte Carlo portfolio projections",
);

monteCarloCommand
  .command("run")
  .description("Run Monte Carlo simulation for a fund")
  .argument("<fund>", "Fund name")
  .option("-n, --simulations <count>", "Number of simulations", "10000")
  .option("-h, --horizon <months>", "Projection horizon in months")
  .option("-s, --seed <seed>", "Random seed", "42")
  .action(
    async (
      fundName: string,
      opts: { simulations: string; horizon?: string; seed: string },
    ) => {
      try {
        const config = await loadFundConfig(fundName);
        const portfolio = await readPortfolio(fundName);

        console.log(
          chalk.bold(
            `\n  Monte Carlo Simulation: ${config.fund.display_name}\n`,
          ),
        );
        console.log(chalk.dim(`  Running ${opts.simulations} simulations...`));

        const result = await runFundMonteCarlo(fundName, {
          simulations: parseInt(opts.simulations, 10),
          horizonMonths: opts.horizon ? parseInt(opts.horizon, 10) : undefined,
          seed: parseInt(opts.seed, 10),
        });

        console.log();
        console.log(chalk.bold("  Input Parameters:"));
        console.log(`  Current Value:    $${portfolio.total_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
        console.log(`  Monthly Return:   ${(result.monthly_return_mean * 100).toFixed(2)}% (mean)`);
        console.log(`  Monthly Vol:      ${(result.monthly_return_std * 100).toFixed(2)}% (std)`);
        console.log(`  Horizon:          ${result.horizon_months} months`);
        console.log(`  Simulations:      ${result.simulations.toLocaleString()}`);
        console.log();

        // Distribution
        const barWidth = 40;
        const minVal = result.percentiles.p5;
        const maxVal = result.percentiles.p95;

        console.log(chalk.bold("  Projected Value Distribution:"));
        console.log();

        const percentiles = [
          { label: "5th pctl ", value: result.percentiles.p5, color: chalk.red },
          { label: "10th pctl", value: result.percentiles.p10, color: chalk.red },
          { label: "25th pctl", value: result.percentiles.p25, color: chalk.yellow },
          { label: "Median   ", value: result.percentiles.p50, color: chalk.green },
          { label: "75th pctl", value: result.percentiles.p75, color: chalk.cyan },
          { label: "90th pctl", value: result.percentiles.p90, color: chalk.cyan },
          { label: "95th pctl", value: result.percentiles.p95, color: chalk.blue },
        ];

        for (const p of percentiles) {
          const bar = renderDistributionBar(
            p.value,
            minVal,
            maxVal,
            barWidth,
            p.color,
          );
          console.log(
            `  ${p.label} ${bar} $${p.value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
          );
        }

        console.log();

        // Statistics
        console.log(chalk.bold("  Statistics:"));
        console.log(`  Mean:             $${result.mean_final_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
        console.log(`  Std Dev:          $${result.std_final_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);

        const probRuin = result.probability_of_ruin;
        const ruinColor =
          probRuin > 0.2
            ? chalk.red
            : probRuin > 0.05
              ? chalk.yellow
              : chalk.green;
        console.log(
          `  Prob. of Ruin:    ${ruinColor(`${(probRuin * 100).toFixed(1)}%`)}`,
        );

        // Runway-specific
        if (result.runway_months) {
          console.log();
          console.log(chalk.bold("  Runway Projections:"));
          console.log(
            `  5th percentile:   ${chalk.red(`${result.runway_months.p5.toFixed(0)} months`)}`,
          );
          console.log(
            `  25th percentile:  ${chalk.yellow(`${result.runway_months.p25.toFixed(0)} months`)}`,
          );
          console.log(
            `  Median:           ${chalk.green(`${result.runway_months.p50.toFixed(0)} months`)}`,
          );
          console.log(
            `  75th percentile:  ${chalk.cyan(`${result.runway_months.p75.toFixed(0)} months`)}`,
          );
          console.log(
            `  95th percentile:  ${chalk.blue(`${result.runway_months.p95.toFixed(0)} months`)}`,
          );
        }

        console.log();
      } catch (err) {
        console.error(chalk.red(`  Error: ${err}`));
      }
    },
  );

monteCarloCommand
  .command("compare")
  .description("Compare Monte Carlo results across funds")
  .option("-n, --simulations <count>", "Number of simulations", "5000")
  .action(async (opts: { simulations: string }) => {
    const { listFundNames } = await import("./fund.js");
    const names = await listFundNames();

    if (names.length === 0) {
      console.log(chalk.dim("  No funds found.\n"));
      return;
    }

    console.log(
      chalk.bold(`\n  Monte Carlo Comparison (${opts.simulations} simulations)\n`),
    );

    const simulations = parseInt(opts.simulations, 10);

    for (const name of names) {
      try {
        const config = await loadFundConfig(name);
        const result = await runFundMonteCarlo(name, { simulations });

        const ruinColor =
          result.probability_of_ruin > 0.2
            ? chalk.red
            : result.probability_of_ruin > 0.05
              ? chalk.yellow
              : chalk.green;

        console.log(chalk.bold(`  ${config.fund.display_name} (${name})`));
        console.log(
          `    Median: $${result.percentiles.p50.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `5-95: $${result.percentiles.p5.toLocaleString(undefined, { maximumFractionDigits: 0 })}–$${result.percentiles.p95.toLocaleString(undefined, { maximumFractionDigits: 0 })} | ` +
          `Ruin: ${ruinColor(`${(result.probability_of_ruin * 100).toFixed(1)}%`)}`,
        );

        if (result.runway_months) {
          console.log(
            `    Runway: ${result.runway_months.p25.toFixed(0)}–${result.runway_months.p75.toFixed(0)} months (25th-75th pctl)`,
          );
        }

        console.log();
      } catch (err) {
        console.log(chalk.red(`  ${name}: Error — ${err}`));
        console.log();
      }
    }
  });
