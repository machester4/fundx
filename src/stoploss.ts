import { loadGlobalConfig } from "./config.js";
import { loadFundConfig } from "./fund.js";
import { readPortfolio, writePortfolio } from "./state.js";
import { openJournal, insertTrade } from "./journal.js";
import type { Portfolio } from "./types.js";

// ── Alpaca helpers ────────────────────────────────────────────

const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
const ALPACA_LIVE_URL = "https://api.alpaca.markets";
const ALPACA_DATA_URL = "https://data.alpaca.markets";

interface AlpacaCredentials {
  apiKey: string;
  secretKey: string;
  tradingUrl: string;
}

async function getCredentials(fundName: string): Promise<AlpacaCredentials> {
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(fundName);

  const apiKey = globalConfig.broker.api_key;
  const secretKey = globalConfig.broker.secret_key;
  if (!apiKey || !secretKey) {
    throw new Error("Broker API credentials not configured");
  }

  const mode = fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";
  const tradingUrl = mode === "live" ? ALPACA_LIVE_URL : ALPACA_PAPER_URL;

  return { apiKey, secretKey, tradingUrl };
}

async function fetchLatestPrices(
  creds: AlpacaCredentials,
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const params = new URLSearchParams({ symbols: symbols.join(",") });
  const resp = await fetch(`${ALPACA_DATA_URL}/v2/stocks/trades/latest?${params.toString()}`, {
    headers: {
      "APCA-API-KEY-ID": creds.apiKey,
      "APCA-API-SECRET-KEY": creds.secretKey,
    },
  });

  if (!resp.ok) {
    throw new Error(`Failed to fetch latest prices: ${resp.status}`);
  }

  const data = (await resp.json()) as { trades: Record<string, { p: number }> };
  const prices: Record<string, number> = {};
  for (const [symbol, trade] of Object.entries(data.trades)) {
    prices[symbol] = trade.p;
  }
  return prices;
}

async function placeMarketSell(
  creds: AlpacaCredentials,
  symbol: string,
  qty: number,
): Promise<void> {
  const resp = await fetch(`${creds.tradingUrl}/v2/orders`, {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID": creds.apiKey,
      "APCA-API-SECRET-KEY": creds.secretKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side: "sell",
      type: "market",
      time_in_force: "day",
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to place sell order for ${symbol}: ${resp.status} ${text}`);
  }
}

// ── Stop-Loss Check ───────────────────────────────────────────

export interface StopLossEvent {
  symbol: string;
  shares: number;
  stopPrice: number;
  currentPrice: number;
  avgCost: number;
  loss: number;
  lossPct: number;
}

/**
 * Check all positions against their stop-loss levels.
 * Returns positions that have triggered their stop-loss.
 */
export async function checkStopLosses(
  fundName: string,
): Promise<StopLossEvent[]> {
  const portfolio = await readPortfolio(fundName);
  const positionsWithStops = portfolio.positions.filter(
    (p) => p.stop_loss !== undefined && p.stop_loss > 0 && p.shares > 0,
  );

  if (positionsWithStops.length === 0) return [];

  const creds = await getCredentials(fundName);
  const symbols = positionsWithStops.map((p) => p.symbol);
  const prices = await fetchLatestPrices(creds, symbols);

  const triggered: StopLossEvent[] = [];

  for (const pos of positionsWithStops) {
    const currentPrice = prices[pos.symbol];
    if (currentPrice === undefined) continue;

    if (currentPrice <= pos.stop_loss!) {
      const loss = (currentPrice - pos.avg_cost) * pos.shares;
      const lossPct = ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100;

      triggered.push({
        symbol: pos.symbol,
        shares: pos.shares,
        stopPrice: pos.stop_loss!,
        currentPrice,
        avgCost: pos.avg_cost,
        loss,
        lossPct,
      });
    }
  }

  return triggered;
}

/**
 * Execute stop-loss sells for triggered positions.
 * Places market sell orders and logs trades in the journal.
 */
export async function executeStopLosses(
  fundName: string,
  events: StopLossEvent[],
): Promise<void> {
  if (events.length === 0) return;

  const creds = await getCredentials(fundName);
  const db = openJournal(fundName);

  try {
    for (const event of events) {
      // Place sell order
      await placeMarketSell(creds, event.symbol, event.shares);

      // Log trade in journal
      insertTrade(db, {
        timestamp: new Date().toISOString(),
        fund: fundName,
        symbol: event.symbol,
        side: "sell",
        quantity: event.shares,
        price: event.currentPrice,
        total_value: event.currentPrice * event.shares,
        order_type: "market",
        session_type: "stop_loss",
        reasoning: `Stop-loss triggered at $${event.stopPrice.toFixed(2)}. Current price: $${event.currentPrice.toFixed(2)}. Loss: $${event.loss.toFixed(2)} (${event.lossPct.toFixed(1)}%)`,
      });
    }
  } finally {
    db.close();
  }

  // Update portfolio after stop-loss execution
  const portfolio = await readPortfolio(fundName);
  const updatedPositions = portfolio.positions.filter(
    (p) => !events.some((e) => e.symbol === p.symbol),
  );

  // Add cash from sold positions
  const cashFromSales = events.reduce(
    (sum, e) => sum + e.currentPrice * e.shares,
    0,
  );

  const updatedPortfolio: Portfolio = {
    ...portfolio,
    last_updated: new Date().toISOString(),
    cash: portfolio.cash + cashFromSales,
    positions: updatedPositions,
    total_value:
      portfolio.cash +
      cashFromSales +
      updatedPositions.reduce((sum, p) => sum + p.market_value, 0),
  };

  await writePortfolio(fundName, updatedPortfolio);
}

/**
 * Auto-apply stop-loss levels based on fund risk config.
 * Sets stop_loss for positions that don't have one.
 */
export async function applyDefaultStopLosses(fundName: string): Promise<number> {
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
