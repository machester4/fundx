import { listFundNames } from "./fund.service.js";
import { readPortfolio } from "../state.js";
import { openJournal, getTradesInDays } from "../journal.js";
import type { CorrelationEntry, Portfolio, TradeRecord } from "../types.js";

// ── Correlation Computation ──────────────────────────────────

/**
 * Compute Pearson correlation coefficient between two arrays of returns.
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;

  const xs = x.slice(0, n);
  const ys = y.slice(0, n);

  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denominator = Math.sqrt(sumX2 * sumY2);
  if (denominator === 0) return 0;

  return sumXY / denominator;
}

/**
 * Extract daily P&L series from trade records.
 * Groups trades by date and sums P&L.
 */
function extractDailyPnl(
  trades: TradeRecord[],
  days: number,
): Map<string, number> {
  const dailyPnl = new Map<string, number>();

  // Initialize all days to 0
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyPnl.set(d.toISOString().split("T")[0], 0);
  }

  // Sum P&L from trades with closed positions
  for (const trade of trades) {
    if (trade.pnl === undefined || trade.pnl === null) continue;
    const date =
      trade.closed_at?.split("T")[0] ?? trade.timestamp.split("T")[0];
    const current = dailyPnl.get(date) ?? 0;
    dailyPnl.set(date, current + trade.pnl);
  }

  return dailyPnl;
}

/**
 * Compute position overlap between two portfolios.
 * Returns shared symbols.
 */
function findOverlappingSymbols(
  portfolioA: Portfolio,
  portfolioB: Portfolio,
): string[] {
  const symbolsA = new Set(portfolioA.positions.map((p) => p.symbol));
  const symbolsB = new Set(portfolioB.positions.map((p) => p.symbol));
  return [...symbolsA].filter((s) => symbolsB.has(s));
}

/**
 * Compute correlation between two funds based on their trade history.
 */
export async function computeFundCorrelation(
  fundA: string,
  fundB: string,
  periodDays: number = 30,
): Promise<CorrelationEntry> {
  // Get trade data
  let tradesA: TradeRecord[] = [];
  let tradesB: TradeRecord[] = [];

  try {
    const dbA = openJournal(fundA);
    try {
      tradesA = getTradesInDays(dbA, fundA, periodDays);
    } finally {
      dbA.close();
    }
  } catch {
    // No journal for fund A
  }

  try {
    const dbB = openJournal(fundB);
    try {
      tradesB = getTradesInDays(dbB, fundB, periodDays);
    } finally {
      dbB.close();
    }
  } catch {
    // No journal for fund B
  }

  // Extract daily P&L
  const pnlA = extractDailyPnl(tradesA, periodDays);
  const pnlB = extractDailyPnl(tradesB, periodDays);

  // Align the series
  const allDates = [...new Set([...pnlA.keys(), ...pnlB.keys()])].sort();
  const seriesA = allDates.map((d) => pnlA.get(d) ?? 0);
  const seriesB = allDates.map((d) => pnlB.get(d) ?? 0);

  const correlation = pearsonCorrelation(seriesA, seriesB);

  // Check position overlap
  let overlappingSymbols: string[] = [];
  try {
    const portfolioA = await readPortfolio(fundA);
    const portfolioB = await readPortfolio(fundB);
    overlappingSymbols = findOverlappingSymbols(portfolioA, portfolioB);
  } catch {
    // Skip if portfolios not available
  }

  // Generate warning if correlation is too high
  let warning: string | undefined;
  if (Math.abs(correlation) > 0.8) {
    warning = `High correlation (${correlation.toFixed(2)}) between ${fundA} and ${fundB}. Diversification may be limited.`;
  }
  if (overlappingSymbols.length > 0) {
    const overlapWarning = `Shared positions: ${overlappingSymbols.join(", ")}`;
    warning = warning ? `${warning} ${overlapWarning}` : overlapWarning;
  }

  return {
    fund_a: fundA,
    fund_b: fundB,
    correlation,
    period_days: periodDays,
    computed_at: new Date().toISOString(),
    overlapping_symbols: overlappingSymbols,
    warning,
  };
}

/**
 * Compute correlation matrix for all funds.
 */
export async function computeCorrelationMatrix(
  periodDays: number = 30,
): Promise<CorrelationEntry[]> {
  const names = await listFundNames();
  const results: CorrelationEntry[] = [];

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      try {
        const entry = await computeFundCorrelation(
          names[i],
          names[j],
          periodDays,
        );
        results.push(entry);
      } catch {
        // Skip pairs that fail
      }
    }
  }

  return results;
}
