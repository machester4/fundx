import { z } from "zod";
import { loadGlobalConfig } from "./config.js";
import { loadFundConfig } from "./services/fund.service.js";
import { ALPACA_PAPER_URL, ALPACA_LIVE_URL } from "./alpaca-helpers.js";
import type { BrokerCapabilities } from "./types.js";

// ── Broker Adapter Interface ─────────────────────────────────

export interface BrokerAccount {
  cash: number;
  portfolio_value: number;
  buying_power: number;
  equity: number;
  currency: string;
}

export interface BrokerPosition {
  symbol: string;
  shares: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  side: "long" | "short";
}

export interface BrokerOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit" | "stop" | "stop_limit";
  status: string;
  limit_price?: number;
  stop_price?: number;
  filled_qty?: number;
  filled_avg_price?: number;
  created_at: string;
}

export interface PlaceOrderParams {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit";
  limit_price?: number;
  stop_price?: number;
  time_in_force?: "day" | "gtc" | "ioc" | "fok";
}

export interface BrokerAdapter {
  readonly name: string;
  readonly capabilities: BrokerCapabilities;

  getAccount(): Promise<BrokerAccount>;
  getPositions(): Promise<BrokerPosition[]>;
  getPosition(symbol: string): Promise<BrokerPosition | null>;
  placeOrder(params: PlaceOrderParams): Promise<BrokerOrder>;
  cancelOrder(orderId: string): Promise<void>;
  getOrders(status?: "open" | "closed" | "all"): Promise<BrokerOrder[]>;
}

// ── Alpaca API Response Schemas ──────────────────────────────

const alpacaAccountSchema = z.object({
  cash: z.string(),
  portfolio_value: z.string(),
  buying_power: z.string(),
  equity: z.string(),
  currency: z.string().default("USD"),
});

const alpacaPositionSchema = z.object({
  symbol: z.string(),
  qty: z.string(),
  avg_entry_price: z.string(),
  current_price: z.string(),
  market_value: z.string(),
  unrealized_pl: z.string(),
  unrealized_plpc: z.string(),
  side: z.string(),
});

const alpacaOrderSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  side: z.string(),
  qty: z.string().nullable().default("0"),
  type: z.string(),
  status: z.string(),
  limit_price: z.string().nullable().optional(),
  stop_price: z.string().nullable().optional(),
  filled_qty: z.string().nullable().optional(),
  filled_avg_price: z.string().nullable().optional(),
  created_at: z.string(),
});

// ── Alpaca Adapter ───────────────────────────────────────────

export class AlpacaAdapter implements BrokerAdapter {
  readonly name = "alpaca";
  readonly capabilities: BrokerCapabilities = {
    stocks: true,
    etfs: true,
    options: true,
    crypto: true,
    forex: false,
    paper_trading: true,
    live_trading: true,
    streaming: true,
  };

  constructor(
    private apiKey: string,
    private secretKey: string,
    private baseUrl: string,
  ) {}

  private async request(path: string, options?: RequestInit): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        "APCA-API-KEY-ID": this.apiKey,
        "APCA-API-SECRET-KEY": this.secretKey,
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Alpaca API error ${resp.status}: ${text}`);
    }

    return resp.json();
  }

  async getAccount(): Promise<BrokerAccount> {
    const data = alpacaAccountSchema.parse(await this.request("/v2/account"));
    return {
      cash: parseFloat(data.cash),
      portfolio_value: parseFloat(data.portfolio_value),
      buying_power: parseFloat(data.buying_power),
      equity: parseFloat(data.equity),
      currency: data.currency,
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const data = z.array(alpacaPositionSchema).parse(await this.request("/v2/positions"));
    return data.map((p) => ({
      symbol: p.symbol,
      shares: parseFloat(p.qty),
      avg_cost: parseFloat(p.avg_entry_price),
      current_price: parseFloat(p.current_price),
      market_value: parseFloat(p.market_value),
      unrealized_pnl: parseFloat(p.unrealized_pl),
      unrealized_pnl_pct: parseFloat(p.unrealized_plpc) * 100,
      side: p.side === "short" ? "short" : "long",
    }));
  }

  async getPosition(symbol: string): Promise<BrokerPosition | null> {
    try {
      const p = alpacaPositionSchema.parse(
        await this.request(`/v2/positions/${symbol}`),
      );
      return {
        symbol: p.symbol,
        shares: parseFloat(p.qty),
        avg_cost: parseFloat(p.avg_entry_price),
        current_price: parseFloat(p.current_price),
        market_value: parseFloat(p.market_value),
        unrealized_pnl: parseFloat(p.unrealized_pl),
        unrealized_pnl_pct: parseFloat(p.unrealized_plpc) * 100,
        side: p.side === "short" ? "short" : "long",
      };
    } catch {
      return null;
    }
  }

  async placeOrder(params: PlaceOrderParams): Promise<BrokerOrder> {
    const body: Record<string, string | number | undefined> = {
      symbol: params.symbol,
      qty: String(params.qty),
      side: params.side,
      type: params.type,
      time_in_force: params.time_in_force ?? "day",
    };
    if (params.limit_price !== undefined)
      body.limit_price = String(params.limit_price);
    if (params.stop_price !== undefined)
      body.stop_price = String(params.stop_price);

    const data = alpacaOrderSchema.parse(
      await this.request("/v2/orders", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );

    return {
      id: data.id,
      symbol: data.symbol,
      side: data.side === "sell" ? "sell" : "buy",
      qty: parseFloat(data.qty ?? "0"),
      type: (["market", "limit", "stop", "stop_limit"].includes(data.type)
        ? data.type
        : "market") as BrokerOrder["type"],
      status: data.status,
      limit_price: data.limit_price ? parseFloat(data.limit_price) : undefined,
      stop_price: data.stop_price ? parseFloat(data.stop_price) : undefined,
      filled_qty: data.filled_qty ? parseFloat(data.filled_qty) : undefined,
      filled_avg_price: data.filled_avg_price
        ? parseFloat(data.filled_avg_price)
        : undefined,
      created_at: data.created_at,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request(`/v2/orders/${orderId}`, { method: "DELETE" });
  }

  async getOrders(status?: "open" | "closed" | "all"): Promise<BrokerOrder[]> {
    const params = status ? `?status=${status}` : "";
    const data = z
      .array(alpacaOrderSchema)
      .parse(await this.request(`/v2/orders${params}`));

    return data.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: (o.side === "sell" ? "sell" : "buy") as BrokerOrder["side"],
      qty: parseFloat(o.qty ?? "0"),
      type: (["market", "limit", "stop", "stop_limit"].includes(o.type)
        ? o.type
        : "market") as BrokerOrder["type"],
      status: o.status,
      limit_price: o.limit_price ? parseFloat(o.limit_price) : undefined,
      stop_price: o.stop_price ? parseFloat(o.stop_price) : undefined,
      filled_qty: o.filled_qty ? parseFloat(o.filled_qty) : undefined,
      filled_avg_price: o.filled_avg_price
        ? parseFloat(o.filled_avg_price)
        : undefined,
      created_at: o.created_at,
    }));
  }
}

// ── Adapter Factory ──────────────────────────────────────────

/**
 * Create a broker adapter for a fund based on its configuration.
 *
 * Currently only Alpaca is implemented. IBKR and Binance adapters
 * will be added when those integrations are built.
 */
export async function createBrokerAdapter(
  fundName: string,
): Promise<BrokerAdapter> {
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(fundName);

  const provider = fundConfig.broker.provider;
  const mode = fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";

  switch (provider) {
    case "alpaca": {
      const apiKey = globalConfig.broker.api_key;
      const secretKey = globalConfig.broker.secret_key;
      if (!apiKey || !secretKey) {
        throw new Error(
          "Alpaca API credentials not configured. Run 'fundx init' or update ~/.fundx/config.yaml",
        );
      }
      const baseUrl = mode === "live" ? ALPACA_LIVE_URL : ALPACA_PAPER_URL;
      return new AlpacaAdapter(apiKey, secretKey, baseUrl);
    }

    case "ibkr":
      throw new Error(
        "IBKR adapter is not yet implemented. Use Alpaca for now.",
      );

    case "binance":
      throw new Error(
        "Binance adapter is not yet implemented. Use Alpaca for now.",
      );

    case "manual":
      throw new Error(
        "Manual broker does not support automated trading. Use a real broker.",
      );

    default:
      throw new Error(`Unknown broker provider: ${provider}`);
  }
}

