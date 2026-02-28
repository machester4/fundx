import { loadFundConfig } from "./fund.service.js";
import { readPortfolio, readTracker } from "../state.js";
import { openJournal, getTradeSummary, getTradesInDays } from "../journal.js";

export interface PerformanceData {
  fundDisplayName: string;
  initialCapital: number;
  currentValue: number;
  totalReturn: number;
  totalReturnPct: number;
  cash: number;
  cashPct: number;
  positionCount: number;
  objective: {
    type: string;
    progressPct: number;
    status: string;
  } | null;
  tradeStats: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnl: number;
    avgPnlPct: number;
    bestTradePnl: number;
    worstTradePnl: number;
  } | null;
  recentActivity: {
    weekTrades: number;
    monthTrades: number;
  } | null;
  risk: {
    profile: string;
    maxDrawdownPct: number;
    maxPositionPct: number;
    stopLossPct: number;
  };
  overweightPositions: Array<{
    symbol: string;
    weightPct: number;
    maxPct: number;
  }>;
}

/** Get performance data for a fund */
export async function getPerformanceData(fundName: string): Promise<PerformanceData> {
  const config = await loadFundConfig(fundName);
  const portfolio = await readPortfolio(fundName);
  const tracker = await readTracker(fundName).catch(() => null);

  const totalReturn = portfolio.total_value - config.capital.initial;
  const totalReturnPct = (totalReturn / config.capital.initial) * 100;
  const cashPct =
    portfolio.total_value > 0
      ? (portfolio.cash / portfolio.total_value) * 100
      : 0;

  let tradeStats: PerformanceData["tradeStats"] = null;
  let recentActivity: PerformanceData["recentActivity"] = null;

  try {
    const db = openJournal(fundName);
    try {
      const summary = getTradeSummary(db, fundName);

      if (summary.total_trades > 0) {
        const winRate =
          summary.total_trades > 0
            ? (summary.winning_trades / summary.total_trades) * 100
            : 0;

        tradeStats = {
          totalTrades: summary.total_trades,
          winningTrades: summary.winning_trades,
          losingTrades: summary.losing_trades,
          winRate,
          totalPnl: summary.total_pnl,
          avgPnlPct: summary.avg_pnl_pct,
          bestTradePnl: summary.best_trade_pnl,
          worstTradePnl: summary.worst_trade_pnl,
        };
      }

      const weekTrades = getTradesInDays(db, fundName, 7);
      const monthTrades = getTradesInDays(db, fundName, 30);

      if (weekTrades.length > 0 || monthTrades.length > 0) {
        recentActivity = {
          weekTrades: weekTrades.length,
          monthTrades: monthTrades.length,
        };
      }
    } finally {
      db.close();
    }
  } catch {
    // No journal yet
  }

  const overweightPositions = portfolio.positions
    .filter((p) => p.weight_pct > config.risk.max_position_pct)
    .map((p) => ({
      symbol: p.symbol,
      weightPct: p.weight_pct,
      maxPct: config.risk.max_position_pct,
    }));

  return {
    fundDisplayName: config.fund.display_name,
    initialCapital: config.capital.initial,
    currentValue: portfolio.total_value,
    totalReturn,
    totalReturnPct,
    cash: portfolio.cash,
    cashPct,
    positionCount: portfolio.positions.length,
    objective: tracker
      ? {
          type: tracker.type,
          progressPct: tracker.progress_pct,
          status: tracker.status,
        }
      : null,
    tradeStats,
    recentActivity,
    risk: {
      profile: config.risk.profile,
      maxDrawdownPct: config.risk.max_drawdown_pct,
      maxPositionPct: config.risk.max_position_pct,
      stopLossPct: config.risk.stop_loss_pct,
    },
    overweightPositions,
  };
}
