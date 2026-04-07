import type { Portfolio } from "./types.js";

export interface TradeExecution {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  total_value: number;
  reason: string;
}

export interface PaperTradeResult {
  portfolio: Portfolio;
  trade: TradeExecution;
}

/**
 * Execute a paper buy: deduct cash, add/update position, recalculate weights.
 * Pure function — caller persists the result.
 */
export function executeBuy(
  portfolio: Portfolio,
  symbol: string,
  qty: number,
  price: number,
  stopLoss?: number,
  entryReason?: string,
): PaperTradeResult {
  const cost = qty * price;
  if (cost > portfolio.cash) {
    throw new Error(
      `Insufficient cash: need $${cost.toFixed(2)} but only $${portfolio.cash.toFixed(2)} available`,
    );
  }

  const now = new Date().toISOString();
  const positions = [...portfolio.positions];
  const existing = positions.findIndex((p) => p.symbol === symbol);

  if (existing >= 0) {
    const pos = { ...positions[existing] };
    const totalShares = pos.shares + qty;
    const totalCost = pos.avg_cost * pos.shares + price * qty;
    pos.shares = totalShares;
    pos.avg_cost = totalCost / totalShares;
    pos.current_price = price;
    pos.market_value = totalShares * price;
    pos.unrealized_pnl = (price - pos.avg_cost) * totalShares;
    pos.unrealized_pnl_pct =
      pos.avg_cost > 0 ? ((price - pos.avg_cost) / pos.avg_cost) * 100 : 0;
    if (stopLoss !== undefined) pos.stop_loss = stopLoss;
    if (entryReason) pos.entry_reason = entryReason;
    positions[existing] = pos;
  } else {
    positions.push({
      symbol,
      shares: qty,
      avg_cost: price,
      current_price: price,
      market_value: qty * price,
      unrealized_pnl: 0,
      unrealized_pnl_pct: 0,
      weight_pct: 0,
      stop_loss: stopLoss,
      entry_date: now.split("T")[0],
      entry_reason: entryReason ?? "",
    });
  }

  const cash = portfolio.cash - cost;
  const positionsValue = positions.reduce((sum, p) => sum + p.market_value, 0);
  const totalValue = cash + positionsValue;

  for (const pos of positions) {
    pos.weight_pct = totalValue > 0 ? (pos.market_value / totalValue) * 100 : 0;
  }

  return {
    portfolio: {
      last_updated: now,
      cash,
      total_value: totalValue,
      positions,
    },
    trade: {
      symbol,
      side: "buy",
      qty,
      price,
      total_value: cost,
      reason: entryReason ?? "",
    },
  };
}

/**
 * Execute a paper sell: add proceeds to cash, reduce/remove position, recalculate weights.
 * Pure function — caller persists the result.
 */
export function executeSell(
  portfolio: Portfolio,
  symbol: string,
  qty: number,
  price: number,
  reason?: string,
): PaperTradeResult {
  const positions = [...portfolio.positions.map((p) => ({ ...p }))];
  const idx = positions.findIndex((p) => p.symbol === symbol);

  if (idx < 0) {
    throw new Error(`No position found for symbol '${symbol}'`);
  }

  const pos = positions[idx];
  if (qty > pos.shares) {
    throw new Error(
      `Cannot sell ${qty} shares of ${symbol} — only ${pos.shares} held`,
    );
  }

  const proceeds = qty * price;

  if (qty === pos.shares) {
    positions.splice(idx, 1);
  } else {
    pos.shares -= qty;
    pos.current_price = price;
    pos.market_value = pos.shares * price;
    pos.unrealized_pnl = (price - pos.avg_cost) * pos.shares;
    pos.unrealized_pnl_pct =
      pos.avg_cost > 0 ? ((price - pos.avg_cost) / pos.avg_cost) * 100 : 0;
  }

  const cash = portfolio.cash + proceeds;
  const positionsValue = positions.reduce((sum, p) => sum + p.market_value, 0);
  const totalValue = cash + positionsValue;

  for (const p of positions) {
    p.weight_pct = totalValue > 0 ? (p.market_value / totalValue) * 100 : 0;
  }

  return {
    portfolio: {
      last_updated: new Date().toISOString(),
      cash,
      total_value: totalValue,
      positions,
    },
    trade: {
      symbol,
      side: "sell",
      qty,
      price,
      total_value: proceeds,
      reason: reason ?? "",
    },
  };
}
