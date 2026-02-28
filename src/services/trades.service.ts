import { loadFundConfig } from "./fund.service.js";
import { openJournal, getRecentTrades, getTradesInDays, getTradesByDate } from "../journal.js";
import type { TradeRecord } from "../types.js";

export interface TradesDisplayData {
  fundDisplayName: string;
  label: string;
  trades: Array<{
    timestamp: string;
    side: string;
    symbol: string;
    quantity: number;
    price: number;
    totalValue: number;
    orderType: string;
    pnl: number | null;
    reasoning?: string;
  }>;
}

export interface TradesFilter {
  today?: boolean;
  week?: boolean;
  month?: boolean;
  limit?: number;
}

/** Get trades display data */
export async function getTradesDisplay(
  fundName: string,
  filters?: TradesFilter,
): Promise<TradesDisplayData> {
  const config = await loadFundConfig(fundName);
  const db = openJournal(fundName);

  try {
    let trades: TradeRecord[];
    let label: string;

    if (filters?.today) {
      const today = new Date().toISOString().split("T")[0];
      trades = getTradesByDate(db, fundName, today);
      label = "Today";
    } else if (filters?.week) {
      trades = getTradesInDays(db, fundName, 7);
      label = "Last 7 days";
    } else if (filters?.month) {
      trades = getTradesInDays(db, fundName, 30);
      label = "Last 30 days";
    } else {
      const limit = filters?.limit ?? 20;
      trades = getRecentTrades(db, fundName, limit);
      label = `Last ${limit} trades`;
    }

    return {
      fundDisplayName: config.fund.display_name,
      label,
      trades: trades.map((t) => ({
        timestamp: t.timestamp,
        side: t.side,
        symbol: t.symbol,
        quantity: t.quantity,
        price: t.price,
        totalValue: t.total_value,
        orderType: t.order_type,
        pnl: t.pnl ?? null,
        reasoning: t.reasoning,
      })),
    };
  } finally {
    db.close();
  }
}
