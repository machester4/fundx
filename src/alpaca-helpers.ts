import { loadGlobalConfig } from "./config.js";
import { loadFundConfig } from "./fund.js";

// ── Alpaca Constants & Credentials ──────────────────────────

export const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
export const ALPACA_LIVE_URL = "https://api.alpaca.markets";
export const ALPACA_DATA_URL = "https://data.alpaca.markets";

export interface AlpacaCredentials {
  apiKey: string;
  secretKey: string;
  tradingUrl: string;
}

/** Resolve Alpaca API credentials and base URL for a fund */
export async function getAlpacaCredentials(
  fundName: string,
): Promise<AlpacaCredentials> {
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(fundName);

  const apiKey = globalConfig.broker.api_key;
  const secretKey = globalConfig.broker.secret_key;
  if (!apiKey || !secretKey) {
    throw new Error(
      "Broker API credentials not configured. Run 'fundx init' or set them in ~/.fundx/config.yaml",
    );
  }

  const mode = fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";
  const tradingUrl = mode === "live" ? ALPACA_LIVE_URL : ALPACA_PAPER_URL;

  return { apiKey, secretKey, tradingUrl };
}

/** Make an authenticated GET request to the Alpaca trading API */
export async function alpacaGet(
  creds: AlpacaCredentials,
  path: string,
): Promise<unknown> {
  const resp = await fetch(`${creds.tradingUrl}${path}`, {
    headers: {
      "APCA-API-KEY-ID": creds.apiKey,
      "APCA-API-SECRET-KEY": creds.secretKey,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Alpaca API error ${resp.status}: ${text}`);
  }
  return resp.json();
}

/** Fetch latest prices for a list of symbols from Alpaca market data */
export async function fetchLatestPrices(
  creds: AlpacaCredentials,
  symbols: string[],
): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};

  const params = new URLSearchParams({ symbols: symbols.join(",") });
  const resp = await fetch(
    `${ALPACA_DATA_URL}/v2/stocks/trades/latest?${params.toString()}`,
    {
      headers: {
        "APCA-API-KEY-ID": creds.apiKey,
        "APCA-API-SECRET-KEY": creds.secretKey,
      },
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to fetch latest prices: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    trades: Record<string, { p: number }>;
  };
  const prices: Record<string, number> = {};
  for (const [symbol, trade] of Object.entries(data.trades)) {
    prices[symbol] = trade.p;
  }
  return prices;
}

/** Place a market sell order via Alpaca */
export async function placeMarketSell(
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
    throw new Error(
      `Failed to place sell order for ${symbol}: ${resp.status} ${text}`,
    );
  }
}
