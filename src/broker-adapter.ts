import { createHmac } from "node:crypto";
import { loadGlobalConfig } from "./config.js";
import { loadFundConfig } from "./fund.js";
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

// ── Alpaca Adapter ───────────────────────────────────────────

const ALPACA_PAPER_URL = "https://paper-api.alpaca.markets";
const ALPACA_LIVE_URL = "https://api.alpaca.markets";

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
    const data = (await this.request("/v2/account")) as Record<string, string>;
    return {
      cash: parseFloat(data.cash),
      portfolio_value: parseFloat(data.portfolio_value),
      buying_power: parseFloat(data.buying_power),
      equity: parseFloat(data.equity),
      currency: data.currency ?? "USD",
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const data = (await this.request("/v2/positions")) as Array<
      Record<string, string>
    >;
    return data.map((p) => ({
      symbol: p.symbol,
      shares: parseFloat(p.qty),
      avg_cost: parseFloat(p.avg_entry_price),
      current_price: parseFloat(p.current_price),
      market_value: parseFloat(p.market_value),
      unrealized_pnl: parseFloat(p.unrealized_pl),
      unrealized_pnl_pct: parseFloat(p.unrealized_plpc) * 100,
      side: p.side === "short" ? ("short" as const) : ("long" as const),
    }));
  }

  async getPosition(symbol: string): Promise<BrokerPosition | null> {
    try {
      const p = (await this.request(
        `/v2/positions/${symbol}`,
      )) as Record<string, string>;
      return {
        symbol: p.symbol,
        shares: parseFloat(p.qty),
        avg_cost: parseFloat(p.avg_entry_price),
        current_price: parseFloat(p.current_price),
        market_value: parseFloat(p.market_value),
        unrealized_pnl: parseFloat(p.unrealized_pl),
        unrealized_pnl_pct: parseFloat(p.unrealized_plpc) * 100,
        side: p.side === "short" ? ("short" as const) : ("long" as const),
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

    const data = (await this.request("/v2/orders", {
      method: "POST",
      body: JSON.stringify(body),
    })) as Record<string, string | null>;

    return {
      id: data.id!,
      symbol: data.symbol!,
      side: data.side as "buy" | "sell",
      qty: parseFloat(data.qty ?? "0"),
      type: data.type as BrokerOrder["type"],
      status: data.status!,
      limit_price: data.limit_price ? parseFloat(data.limit_price) : undefined,
      stop_price: data.stop_price ? parseFloat(data.stop_price) : undefined,
      filled_qty: data.filled_qty ? parseFloat(data.filled_qty) : undefined,
      filled_avg_price: data.filled_avg_price
        ? parseFloat(data.filled_avg_price)
        : undefined,
      created_at: data.created_at!,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request(`/v2/orders/${orderId}`, { method: "DELETE" });
  }

  async getOrders(status?: "open" | "closed" | "all"): Promise<BrokerOrder[]> {
    const params = status ? `?status=${status}` : "";
    const data = (await this.request(
      `/v2/orders${params}`,
    )) as Array<Record<string, string | null>>;

    return data.map((o) => ({
      id: o.id!,
      symbol: o.symbol!,
      side: o.side as "buy" | "sell",
      qty: parseFloat(o.qty ?? "0"),
      type: o.type as BrokerOrder["type"],
      status: o.status!,
      limit_price: o.limit_price ? parseFloat(o.limit_price) : undefined,
      stop_price: o.stop_price ? parseFloat(o.stop_price) : undefined,
      filled_qty: o.filled_qty ? parseFloat(o.filled_qty) : undefined,
      filled_avg_price: o.filled_avg_price
        ? parseFloat(o.filled_avg_price)
        : undefined,
      created_at: o.created_at!,
    }));
  }
}

// ── IBKR Adapter (stub for extensibility) ────────────────────

export class IBKRAdapter implements BrokerAdapter {
  readonly name = "ibkr";
  readonly capabilities: BrokerCapabilities = {
    stocks: true,
    etfs: true,
    options: true,
    crypto: false,
    forex: true,
    paper_trading: true,
    live_trading: true,
    streaming: true,
  };

  constructor(
    private host: string,
    private port: number,
  ) {}

  private async request(path: string, options?: RequestInit): Promise<unknown> {
    const resp = await fetch(`https://${this.host}:${this.port}/v1/api${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`IBKR API error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async getAccount(): Promise<BrokerAccount> {
    const data = (await this.request("/portfolio/accounts")) as Array<
      Record<string, unknown>
    >;
    if (data.length === 0) throw new Error("No IBKR accounts found");
    const acct = data[0];
    return {
      cash: Number(acct.cash ?? 0),
      portfolio_value: Number(acct.netliquidation ?? 0),
      buying_power: Number(acct.buyingpower ?? 0),
      equity: Number(acct.equity ?? 0),
      currency: String(acct.currency ?? "USD"),
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const data = (await this.request(
      "/portfolio/positions/0",
    )) as Array<Record<string, unknown>>;
    return data.map((p) => ({
      symbol: String(p.ticker ?? p.contractDesc ?? ""),
      shares: Number(p.position ?? 0),
      avg_cost: Number(p.avgCost ?? 0),
      current_price: Number(p.mktPrice ?? 0),
      market_value: Number(p.mktValue ?? 0),
      unrealized_pnl: Number(p.unrealizedPnl ?? 0),
      unrealized_pnl_pct: Number(p.unrealizedPnlPct ?? 0),
      side: Number(p.position ?? 0) >= 0 ? ("long" as const) : ("short" as const),
    }));
  }

  async getPosition(symbol: string): Promise<BrokerPosition | null> {
    const positions = await this.getPositions();
    return positions.find((p) => p.symbol === symbol) ?? null;
  }

  async placeOrder(params: PlaceOrderParams): Promise<BrokerOrder> {
    const body = {
      acctId: "default",
      conid: 0, // Would need contract lookup
      orderType: params.type.toUpperCase(),
      side: params.side.toUpperCase(),
      quantity: params.qty,
      price: params.limit_price,
      auxPrice: params.stop_price,
      tif: (params.time_in_force ?? "DAY").toUpperCase(),
    };
    const data = (await this.request("/iserver/account/orders", {
      method: "POST",
      body: JSON.stringify({ orders: [body] }),
    })) as Array<Record<string, string>>;

    const order = data[0] ?? {};
    return {
      id: order.order_id ?? "",
      symbol: params.symbol,
      side: params.side,
      qty: params.qty,
      type: params.type,
      status: order.order_status ?? "submitted",
      limit_price: params.limit_price,
      stop_price: params.stop_price,
      created_at: new Date().toISOString(),
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request(`/iserver/account/order/${orderId}`, {
      method: "DELETE",
    });
  }

  async getOrders(_status?: "open" | "closed" | "all"): Promise<BrokerOrder[]> {
    const data = (await this.request("/iserver/account/orders")) as {
      orders: Array<Record<string, string>>;
    };
    return (data.orders ?? []).map((o) => ({
      id: o.orderId ?? "",
      symbol: o.ticker ?? "",
      side: (o.side?.toLowerCase() ?? "buy") as "buy" | "sell",
      qty: parseFloat(o.totalQuantity ?? "0"),
      type: (o.orderType?.toLowerCase() ?? "market") as BrokerOrder["type"],
      status: o.status ?? "unknown",
      created_at: o.lastExecutionTime ?? new Date().toISOString(),
    }));
  }
}

// ── Binance Adapter (stub for extensibility) ─────────────────

export class BinanceAdapter implements BrokerAdapter {
  readonly name = "binance";
  readonly capabilities: BrokerCapabilities = {
    stocks: false,
    etfs: false,
    options: false,
    crypto: true,
    forex: false,
    paper_trading: true,
    live_trading: true,
    streaming: true,
  };

  constructor(
    private apiKey: string,
    private secretKey: string,
    private testnet: boolean = false,
  ) {}

  private get baseUrl(): string {
    return this.testnet
      ? "https://testnet.binance.vision"
      : "https://api.binance.com";
  }

  private createSignature(queryString: string): string {
    return createHmac("sha256", this.secretKey)
      .update(queryString)
      .digest("hex");
  }

  private async request(
    path: string,
    signed: boolean = false,
    options?: RequestInit,
  ): Promise<unknown> {
    let url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "X-MBX-APIKEY": this.apiKey,
      "Content-Type": "application/json",
    };

    if (signed) {
      const timestamp = Date.now();
      const separator = url.includes("?") ? "&" : "?";
      const queryString = `timestamp=${timestamp}`;
      const signature = this.createSignature(queryString);
      url += `${separator}${queryString}&signature=${signature}`;
    }

    const resp = await fetch(url, {
      ...options,
      headers: { ...headers, ...options?.headers },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Binance API error ${resp.status}: ${text}`);
    }

    return resp.json();
  }

  async getAccount(): Promise<BrokerAccount> {
    const data = (await this.request(
      "/api/v3/account",
      true,
    )) as Record<string, unknown>;
    const balances = (data.balances ?? []) as Array<{
      asset: string;
      free: string;
      locked: string;
    }>;

    let totalValue = 0;
    let cash = 0;
    for (const b of balances) {
      const free = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      if (b.asset === "USDT" || b.asset === "BUSD" || b.asset === "USD") {
        cash += free + locked;
      }
      totalValue += free + locked;
    }

    return {
      cash,
      portfolio_value: totalValue,
      buying_power: cash,
      equity: totalValue,
      currency: "USDT",
    };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const data = (await this.request(
      "/api/v3/account",
      true,
    )) as Record<string, unknown>;
    const balances = (data.balances ?? []) as Array<{
      asset: string;
      free: string;
      locked: string;
    }>;

    return balances
      .filter((b) => {
        const total = parseFloat(b.free) + parseFloat(b.locked);
        return total > 0 && !["USDT", "BUSD", "USD"].includes(b.asset);
      })
      .map((b) => ({
        symbol: b.asset,
        shares: parseFloat(b.free) + parseFloat(b.locked),
        avg_cost: 0, // Binance doesn't track avg cost
        current_price: 0,
        market_value: 0,
        unrealized_pnl: 0,
        unrealized_pnl_pct: 0,
        side: "long" as const,
      }));
  }

  async getPosition(symbol: string): Promise<BrokerPosition | null> {
    const positions = await this.getPositions();
    return positions.find((p) => p.symbol === symbol) ?? null;
  }

  async placeOrder(params: PlaceOrderParams): Promise<BrokerOrder> {
    const body: Record<string, string | number> = {
      symbol: params.symbol,
      side: params.side.toUpperCase(),
      type: params.type.toUpperCase(),
      quantity: params.qty,
    };
    if (params.limit_price !== undefined) body.price = params.limit_price;
    if (params.stop_price !== undefined) body.stopPrice = params.stop_price;
    if (params.type === "limit" || params.type === "stop_limit") {
      body.timeInForce = (params.time_in_force ?? "gtc").toUpperCase();
    }

    const data = (await this.request("/api/v3/order", true, {
      method: "POST",
      body: JSON.stringify(body),
    })) as Record<string, string>;

    return {
      id: data.orderId ?? "",
      symbol: data.symbol ?? params.symbol,
      side: params.side,
      qty: params.qty,
      type: params.type,
      status: data.status ?? "NEW",
      limit_price: params.limit_price,
      stop_price: params.stop_price,
      created_at: new Date().toISOString(),
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request(
      `/api/v3/order?orderId=${orderId}`,
      true,
      { method: "DELETE" },
    );
  }

  async getOrders(_status?: "open" | "closed" | "all"): Promise<BrokerOrder[]> {
    const data = (await this.request(
      "/api/v3/openOrders",
      true,
    )) as Array<Record<string, string>>;

    return data.map((o) => ({
      id: o.orderId ?? "",
      symbol: o.symbol ?? "",
      side: (o.side?.toLowerCase() ?? "buy") as "buy" | "sell",
      qty: parseFloat(o.origQty ?? "0"),
      type: (o.type?.toLowerCase() ?? "market") as BrokerOrder["type"],
      status: o.status ?? "unknown",
      limit_price: o.price ? parseFloat(o.price) : undefined,
      stop_price: o.stopPrice ? parseFloat(o.stopPrice) : undefined,
      created_at: o.time ? new Date(Number(o.time)).toISOString() : new Date().toISOString(),
    }));
  }
}

// ── Adapter Factory ──────────────────────────────────────────

/**
 * Create a broker adapter for a fund based on its configuration.
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

    case "ibkr": {
      const host = process.env.IBKR_HOST ?? "localhost";
      const port = parseInt(process.env.IBKR_PORT ?? "5000", 10);
      return new IBKRAdapter(host, port);
    }

    case "binance": {
      const apiKey = process.env.BINANCE_API_KEY ?? globalConfig.broker.api_key;
      const secretKey =
        process.env.BINANCE_SECRET_KEY ?? globalConfig.broker.secret_key;
      if (!apiKey || !secretKey) {
        throw new Error("Binance API credentials not configured");
      }
      const testnet = mode === "paper";
      return new BinanceAdapter(apiKey, secretKey, testnet);
    }

    case "manual":
      throw new Error(
        "Manual broker does not support automated trading. Use a real broker.",
      );

    default:
      throw new Error(`Unknown broker provider: ${provider}`);
  }
}

