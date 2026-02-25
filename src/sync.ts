import { readPortfolio, writePortfolio } from "./state.js";
import { getAlpacaCredentials, alpacaGet } from "./alpaca-helpers.js";
import type { Portfolio } from "./types.js";

// ── Sync Logic ────────────────────────────────────────────────

interface AlpacaAccountResponse {
  cash: string;
  portfolio_value: string;
  equity: string;
}

interface AlpacaPositionResponse {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  change_today: string;
}

/**
 * Sync portfolio state from Alpaca broker.
 * Fetches current account and positions, updates portfolio.json.
 */
export async function syncPortfolio(fundName: string): Promise<Portfolio> {
  const creds = await getAlpacaCredentials(fundName);

  const [account, positions] = await Promise.all([
    alpacaGet(creds, "/v2/account") as Promise<AlpacaAccountResponse>,
    alpacaGet(creds, "/v2/positions") as Promise<AlpacaPositionResponse[]>,
  ]);

  const portfolio = await readPortfolio(fundName).catch(() => null);
  const totalValue = parseFloat(account.portfolio_value || account.equity);
  const cash = parseFloat(account.cash);

  const updatedPortfolio: Portfolio = {
    last_updated: new Date().toISOString(),
    cash,
    total_value: totalValue,
    positions: positions.map((pos) => {
      const shares = parseFloat(pos.qty);
      const avgCost = parseFloat(pos.avg_entry_price);
      const currentPrice = parseFloat(pos.current_price);
      const marketValue = parseFloat(pos.market_value);
      const unrealizedPnl = parseFloat(pos.unrealized_pl);
      const unrealizedPnlPct = parseFloat(pos.unrealized_plpc) * 100;
      const weightPct = totalValue > 0 ? (marketValue / totalValue) * 100 : 0;

      // Preserve stop_loss, entry_date, and entry_reason from existing portfolio
      const existing = portfolio?.positions.find((p) => p.symbol === pos.symbol);

      return {
        symbol: pos.symbol,
        shares,
        avg_cost: avgCost,
        current_price: currentPrice,
        market_value: marketValue,
        unrealized_pnl: unrealizedPnl,
        unrealized_pnl_pct: unrealizedPnlPct,
        weight_pct: weightPct,
        stop_loss: existing?.stop_loss,
        entry_date: existing?.entry_date ?? new Date().toISOString().split("T")[0],
        entry_reason: existing?.entry_reason ?? "",
      };
    }),
  };

  await writePortfolio(fundName, updatedPortfolio);
  return updatedPortfolio;
}
