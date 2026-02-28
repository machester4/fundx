import { loadFundConfig } from "./fund.service.js";
import { readPortfolio } from "../state.js";
import { syncPortfolio } from "../sync.js";
import type { Portfolio } from "../types.js";

export interface PortfolioDisplayData {
  fundDisplayName: string;
  lastUpdated: string;
  totalValue: number;
  cash: number;
  cashPct: number;
  initialCapital: number;
  pnl: number;
  pnlPct: number;
  synced: boolean;
  positions: Array<{
    symbol: string;
    shares: number;
    avgCost: number;
    currentPrice: number;
    marketValue: number;
    unrealizedPnl: number;
    unrealizedPnlPct: number;
    weightPct: number;
    stopLoss: number | null;
  }>;
}

/** Get portfolio display data */
export async function getPortfolioDisplay(
  fundName: string,
  options?: { sync?: boolean },
): Promise<PortfolioDisplayData> {
  const config = await loadFundConfig(fundName);

  let portfolio: Portfolio;
  let synced = false;

  if (options?.sync) {
    try {
      portfolio = await syncPortfolio(fundName);
      synced = true;
    } catch {
      portfolio = await readPortfolio(fundName);
    }
  } else {
    portfolio = await readPortfolio(fundName);
  }

  const pnl = portfolio.total_value - config.capital.initial;
  const pnlPct = (pnl / config.capital.initial) * 100;
  const cashPct =
    portfolio.total_value > 0
      ? (portfolio.cash / portfolio.total_value) * 100
      : 0;

  return {
    fundDisplayName: config.fund.display_name,
    lastUpdated: portfolio.last_updated,
    totalValue: portfolio.total_value,
    cash: portfolio.cash,
    cashPct,
    initialCapital: config.capital.initial,
    pnl,
    pnlPct,
    synced,
    positions: portfolio.positions.map((pos) => ({
      symbol: pos.symbol,
      shares: pos.shares,
      avgCost: pos.avg_cost,
      currentPrice: pos.current_price,
      marketValue: pos.market_value,
      unrealizedPnl: pos.unrealized_pnl,
      unrealizedPnlPct: pos.unrealized_pnl_pct,
      weightPct: pos.weight_pct,
      stopLoss: pos.stop_loss ?? null,
    })),
  };
}
