import { loadGlobalConfig } from "./config.js";
import { readPortfolio, writePortfolio } from "./state.js";
import { openJournal, insertTrade } from "./journal.js";
import { executeSell } from "./paper-trading.js";
import { notifyStopLoss } from "./services/notify.service.js";

const FMP_BASE = "https://financialmodelingprep.com/api/v3";

// ── Stop-Loss Check ───────────────────────────────────────────

export interface StopLossEvent {
  symbol: string;
  shares: number;
  stopPrice: number;
  currentPrice: number;
  avgCost: number;
  pnl: number;
  pnlPct: number;
}

async function fetchPricesFromFmp(symbols: string[]): Promise<Record<string, number>> {
  const config = await loadGlobalConfig();
  const apiKey = config.market_data?.fmp_api_key;
  if (!apiKey) throw new Error("FMP_API_KEY not configured for stop-loss monitoring");

  const resp = await fetch(
    `${FMP_BASE}/quote/${symbols.join(",")}?apikey=${apiKey}`,
    { signal: AbortSignal.timeout(5000) },
  );
  if (!resp.ok) throw new Error(`FMP API error ${resp.status}`);
  const data = (await resp.json()) as Array<{ symbol: string; price: number }>;
  const result: Record<string, number> = {};
  for (const item of data) result[item.symbol] = item.price;
  return result;
}

export async function checkStopLosses(
  fundName: string,
): Promise<StopLossEvent[]> {
  const portfolio = await readPortfolio(fundName);
  const positionsWithStops = portfolio.positions.filter(
    (p): p is typeof p & { stop_loss: number } =>
      p.stop_loss !== undefined && p.stop_loss > 0 && p.shares > 0,
  );

  if (positionsWithStops.length === 0) return [];

  const symbols = positionsWithStops.map((p) => p.symbol);
  const prices = await fetchPricesFromFmp(symbols);

  const triggered: StopLossEvent[] = [];

  for (const pos of positionsWithStops) {
    const currentPrice = prices[pos.symbol];
    if (currentPrice === undefined) continue;

    if (currentPrice <= pos.stop_loss) {
      const pnl = (currentPrice - pos.avg_cost) * pos.shares;
      const pnlPct = ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100;

      triggered.push({
        symbol: pos.symbol,
        shares: pos.shares,
        stopPrice: pos.stop_loss,
        currentPrice,
        avgCost: pos.avg_cost,
        pnl,
        pnlPct,
      });
    }
  }

  return triggered;
}

export async function executeStopLosses(
  fundName: string,
  events: StopLossEvent[],
): Promise<void> {
  if (events.length === 0) return;

  let portfolio = await readPortfolio(fundName);
  const db = openJournal(fundName);

  try {
    for (const event of events) {
      const pnlLabel = event.pnl >= 0 ? "Gain" : "Loss";
      const pctSign = event.pnlPct >= 0 ? "+" : "";
      const reason = `Stop-loss triggered at $${event.stopPrice.toFixed(2)}. Current price: $${event.currentPrice.toFixed(2)}. ${pnlLabel}: $${Math.abs(event.pnl).toFixed(2)} (${pctSign}${event.pnlPct.toFixed(1)}%)`;

      const result = executeSell(
        portfolio,
        event.symbol,
        event.shares,
        event.currentPrice,
        reason,
      );

      portfolio = result.portfolio;

      const now = new Date().toISOString();
      insertTrade(db, {
        timestamp: now,
        fund: fundName,
        symbol: event.symbol,
        side: "sell",
        quantity: event.shares,
        price: event.currentPrice,
        total_value: event.currentPrice * event.shares,
        order_type: "market",
        session_type: "stop_loss",
        reasoning: result.trade.reason,
        closed_at: now,
        close_price: event.currentPrice,
        pnl: event.pnl,
        pnl_pct: event.pnlPct,
      });

      notifyStopLoss(
        fundName,
        event.symbol,
        event.stopPrice,
        `sold ${event.shares} @ $${event.currentPrice.toFixed(2)}`,
      );
    }
  } finally {
    db.close();
  }

  await writePortfolio(fundName, portfolio);
}

export async function applyDefaultStopLosses(fundName: string): Promise<number> {
  const { loadFundConfig } = await import("./services/fund.service.js");
  const config = await loadFundConfig(fundName);
  const portfolio = await readPortfolio(fundName);
  const stopLossPct = config.risk.stop_loss_pct;

  let updated = 0;
  for (const pos of portfolio.positions) {
    if (pos.stop_loss === undefined || pos.stop_loss === 0) {
      pos.stop_loss = pos.avg_cost * (1 - stopLossPct / 100);
      updated++;
    }
  }

  if (updated > 0) {
    await writePortfolio(fundName, portfolio);
  }

  return updated;
}
