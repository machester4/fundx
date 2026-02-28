import { loadFundConfig } from "./fund.service.js";
import { readPortfolio, readTracker } from "../state.js";
import { openJournal, getTradesInDays } from "../journal.js";
import type { TradeRecord } from "../types.js";

// ── Data Types ──────────────────────────────────────────────

export interface AllocationItem {
  label: string;
  pct: number;
  colorIndex: number;
  isCash?: boolean;
}

export interface PnlItem {
  label: string;
  value: number;
}

export interface HistoryData {
  fundDisplayName: string;
  days: number;
  sortedDates: string[];
  volumes: number[];
  totalTrades: number;
  closedTrades: Array<{ label: string; value: number }>;
}

export interface OverviewData {
  fundDisplayName: string;
  initialCapital: number;
  currentValue: number;
  totalReturn: number;
  totalReturnPct: number;
  progressPct: number | null;
  progressStatus: string | null;
  allocation: AllocationItem[];
  pnl: PnlItem[];
}

// ── Data Getters ────────────────────────────────────────────

/** Get portfolio allocation data */
export async function getAllocationData(fundName: string): Promise<{
  fundDisplayName: string;
  totalValue: number;
  items: AllocationItem[];
}> {
  const config = await loadFundConfig(fundName);
  const portfolio = await readPortfolio(fundName);

  const items: AllocationItem[] = [];
  for (let i = 0; i < portfolio.positions.length; i++) {
    const pos = portfolio.positions[i];
    items.push({
      label: pos.symbol,
      pct: pos.weight_pct,
      colorIndex: i,
    });
  }

  const cashPct =
    portfolio.total_value > 0
      ? (portfolio.cash / portfolio.total_value) * 100
      : 100;
  items.push({ label: "Cash", pct: cashPct, colorIndex: -1, isCash: true });

  return {
    fundDisplayName: config.fund.display_name,
    totalValue: portfolio.total_value,
    items,
  };
}

/** Get P&L data by position */
export async function getPnlData(fundName: string): Promise<{
  fundDisplayName: string;
  items: PnlItem[];
}> {
  const config = await loadFundConfig(fundName);
  const portfolio = await readPortfolio(fundName);

  const items = portfolio.positions.map((p) => ({
    label: p.symbol,
    value: p.unrealized_pnl_pct,
  }));

  return {
    fundDisplayName: config.fund.display_name,
    items,
  };
}

/** Get trade activity history data */
export async function getHistoryData(
  fundName: string,
  days: number,
): Promise<HistoryData | null> {
  const config = await loadFundConfig(fundName);

  const db = openJournal(fundName);
  try {
    const trades = getTradesInDays(db, fundName, days);

    if (trades.length === 0) return null;

    const tradesByDate = new Map<string, TradeRecord[]>();
    for (const t of trades) {
      const date = t.timestamp.split("T")[0];
      const group = tradesByDate.get(date) ?? [];
      if (!tradesByDate.has(date)) tradesByDate.set(date, group);
      group.push(t);
    }

    const sortedDates = [...tradesByDate.keys()].sort();
    const volumes = sortedDates.map(
      (d) => (tradesByDate.get(d) ?? []).length,
    );

    const closedTrades = trades
      .filter((t) => t.pnl !== undefined && t.pnl !== null)
      .map((t) => ({
        label: `${t.symbol} ${t.side[0].toUpperCase()}`,
        value: t.pnl_pct ?? 0,
      }))
      .slice(0, 15);

    return {
      fundDisplayName: config.fund.display_name,
      days,
      sortedDates,
      volumes,
      totalTrades: trades.length,
      closedTrades,
    };
  } finally {
    db.close();
  }
}

/** Get full overview data */
export async function getOverviewData(fundName: string): Promise<OverviewData> {
  const config = await loadFundConfig(fundName);
  const portfolio = await readPortfolio(fundName);
  const tracker = await readTracker(fundName).catch(() => null);

  const totalReturn = portfolio.total_value - config.capital.initial;
  const totalReturnPct = (totalReturn / config.capital.initial) * 100;

  const allocation: AllocationItem[] = portfolio.positions.map((p, i) => ({
    label: p.symbol,
    pct: p.weight_pct,
    colorIndex: i,
  }));

  const cashPct =
    portfolio.total_value > 0
      ? (portfolio.cash / portfolio.total_value) * 100
      : 100;
  allocation.push({ label: "Cash", pct: cashPct, colorIndex: -1, isCash: true });

  const pnl = portfolio.positions.map((p) => ({
    label: p.symbol,
    value: p.unrealized_pnl_pct,
  }));

  return {
    fundDisplayName: config.fund.display_name,
    initialCapital: config.capital.initial,
    currentValue: portfolio.total_value,
    totalReturn,
    totalReturnPct,
    progressPct: tracker?.progress_pct ?? null,
    progressStatus: tracker?.status ?? null,
    allocation,
    pnl,
  };
}

// ── Chart rendering utilities (pure string output) ──────────

const SPARK_CHARS = ["\u2581", "\u2582", "\u2583", "\u2584", "\u2585", "\u2586", "\u2587", "\u2588"];

/** Render a sparkline string from values */
export function renderSparkline(values: number[]): string {
  if (values.length === 0) return "";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values
    .map((v) => {
      const normalized = (v - min) / range;
      const index = Math.min(
        Math.floor(normalized * (SPARK_CHARS.length - 1)),
        SPARK_CHARS.length - 1,
      );
      return SPARK_CHARS[index];
    })
    .join("");
}
