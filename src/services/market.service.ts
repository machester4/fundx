import YahooFinance from "yahoo-finance2";
import { loadGlobalConfig } from "../config.js";
import { ALPACA_PAPER_URL, ALPACA_DATA_URL } from "../alpaca-helpers.js";
import type { MarketIndexSnapshot, NewsHeadline, SectorSnapshot, DashboardMarketData } from "../types.js";

const yf = new YahooFinance();

// ── Constants ────────────────────────────────────────────────

const FMP_BASE = "https://financialmodelingprep.com/api/v3";

const FMP_INDICES: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "NASDAQ",
  "^VIX": "VIX",
};

const SECTOR_ETFS: Record<string, string> = {
  XLK: "Tech",
  XLF: "Fin",
  XLE: "Energy",
  XLV: "Health",
  XLI: "Indust",
  XLY: "Discret",
  XLP: "Staples",
  XLU: "Utils",
  XLB: "Mats",
  XLC: "Comm",
  XLRE: "RE",
};

const ALPACA_INDICES: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "NASDAQ",
  VIXY: "VIX",
};

const YFINANCE_INDICES: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "NASDAQ",
  "^VIX": "VIX",
};

// ── Provider detection ───────────────────────────────────────

type ProviderInfo =
  | { provider: "fmp"; fmpApiKey: string }
  | { provider: "alpaca"; alpacaApiKey: string; alpacaSecretKey: string }
  | { provider: "yfinance" }
  | { provider: "none" };

async function detectProvider(): Promise<ProviderInfo> {
  try {
    const config = await loadGlobalConfig();

    const fmpKey = config.market_data?.fmp_api_key;
    if (fmpKey) {
      return { provider: "fmp", fmpApiKey: fmpKey };
    }

    const alpacaKey = config.broker.api_key;
    const alpacaSecret = config.broker.secret_key;
    if (alpacaKey && alpacaSecret) {
      return { provider: "alpaca", alpacaApiKey: alpacaKey, alpacaSecretKey: alpacaSecret };
    }

    return { provider: "yfinance" };
  } catch {
    return { provider: "yfinance" };
  }
}

// ── FMP provider ─────────────────────────────────────────────

async function fetchFmpIndices(apiKey: string): Promise<MarketIndexSnapshot[]> {
  const symbols = Object.keys(FMP_INDICES);

  // Fetch quotes and sparkline bars in parallel
  const [quotesResult, ...barResults] = await Promise.all([
    fetch(`${FMP_BASE}/quote/${symbols.join(",")}?apikey=${apiKey}`, {
      signal: AbortSignal.timeout(5000),
    }),
    ...symbols.map((s) =>
      fetch(`${FMP_BASE}/historical-chart/15min/${s}?apikey=${apiKey}`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null),
    ),
  ]);

  if (!quotesResult.ok) return [];

  const quotes = (await quotesResult.json()) as Array<{
    symbol: string;
    price: number;
    change: number;
    changesPercentage: number;
  }>;

  // Parse sparkline bars per symbol
  const sparklines = new Map<string, number[]>();
  for (let i = 0; i < symbols.length; i++) {
    const resp = barResults[i];
    if (!resp || !("ok" in resp) || !resp.ok) continue;
    try {
      const bars = (await resp.json()) as Array<{ close: number }>;
      // FMP returns newest first — reverse and take last 12
      sparklines.set(symbols[i], bars.slice(0, 12).reverse().map((b) => b.close));
    } catch { /* skip */ }
  }

  return quotes
    .filter((q) => FMP_INDICES[q.symbol])
    .map((q) => ({
      symbol: q.symbol,
      name: FMP_INDICES[q.symbol],
      price: q.price,
      change: q.change,
      changePct: q.changesPercentage,
      sparklineValues: sparklines.get(q.symbol) ?? [],
    }));
}

async function fetchFmpNews(apiKey: string, limit = 5): Promise<NewsHeadline[]> {
  try {
    const resp = await fetch(
      `${FMP_BASE}/stock_news?limit=${limit}&apikey=${apiKey}`,
      { signal: AbortSignal.timeout(5000) },
    );

    if (!resp.ok) return [];

    const data = (await resp.json()) as Array<{
      title: string;
      site: string;
      publishedDate: string;
      symbol?: string;
      url?: string;
    }>;

    return data.map((n, i) => ({
      id: String(i),
      headline: n.title,
      source: n.site,
      timestamp: n.publishedDate,
      symbols: n.symbol ? [n.symbol] : [],
      url: n.url,
    }));
  } catch {
    return [];
  }
}

async function fetchFmpMarketClock(apiKey: string): Promise<{ isOpen: boolean }> {
  try {
    const resp = await fetch(`${FMP_BASE}/is-the-market-open?apikey=${apiKey}`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) return { isOpen: false };

    const data = (await resp.json()) as { isTheStockMarketOpen: boolean };
    return { isOpen: data.isTheStockMarketOpen };
  } catch {
    return { isOpen: false };
  }
}

async function fetchFmpSectors(apiKey: string): Promise<SectorSnapshot[]> {
  const symbols = Object.keys(SECTOR_ETFS);
  try {
    const resp = await fetch(
      `${FMP_BASE}/quote/${symbols.join(",")}?apikey=${apiKey}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return [];

    const data = (await resp.json()) as Array<{
      symbol: string;
      changesPercentage: number;
    }>;

    return data
      .filter((q) => SECTOR_ETFS[q.symbol])
      .map((q) => ({
        symbol: q.symbol,
        name: SECTOR_ETFS[q.symbol],
        changePct: q.changesPercentage,
      }))
      .sort((a, b) => b.changePct - a.changePct);
  } catch {
    return [];
  }
}

// ── Yahoo Finance provider (free fallback) ────────────────────

async function fetchYFinanceIndices(): Promise<MarketIndexSnapshot[]> {
  const symbols = Object.keys(YFINANCE_INDICES);
  const quotes = await yf.quote(symbols, { return: "array" });
  const results: MarketIndexSnapshot[] = [];
  for (const q of quotes) {
    if (!q.symbol || YFINANCE_INDICES[q.symbol] === undefined) continue;
    let sparklineValues: number[] = [];
    try {
      const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const bars = await yf.historical(q.symbol, {
        period1: twoWeeksAgo,
        period2: new Date(),
        interval: "1d",
      });
      sparklineValues = bars.slice(-12).map((b) => b.close);
    } catch { /* sparklines are optional */ }
    results.push({
      symbol: q.symbol,
      name: YFINANCE_INDICES[q.symbol],
      price: q.regularMarketPrice ?? 0,
      change: q.regularMarketChange ?? 0,
      changePct: q.regularMarketChangePercent ?? 0,
      sparklineValues,
    });
  }
  return results;
}

async function fetchYFinanceSectors(): Promise<SectorSnapshot[]> {
  try {
    const symbols = Object.keys(SECTOR_ETFS);
    const quotes = await yf.quote(symbols, { return: "array" });
    return quotes
      .filter((q) => q.symbol && SECTOR_ETFS[q.symbol])
      .map((q) => ({
        symbol: q.symbol!,
        name: SECTOR_ETFS[q.symbol!],
        changePct: q.regularMarketChangePercent ?? 0,
      }))
      .sort((a, b) => b.changePct - a.changePct);
  } catch {
    return [];
  }
}

async function fetchYFinanceNews(limit = 5): Promise<NewsHeadline[]> {
  try {
    const result = await yf.search("stock market", { newsCount: limit });
    return (result.news ?? []).slice(0, limit).map((n, i) => ({
      id: String(i),
      headline: n.title,
      source: n.publisher,
      timestamp: n.providerPublishTime instanceof Date
        ? n.providerPublishTime.toISOString()
        : new Date().toISOString(),
      symbols: [],
      url: n.link,
    }));
  } catch {
    return [];
  }
}

async function fetchYFinanceMarketClock(): Promise<{ isOpen: boolean }> {
  try {
    const quote = await yf.quote("SPY");
    return { isOpen: quote.marketState === "REGULAR" };
  } catch {
    return { isOpen: false };
  }
}

// ── Alpaca provider (fallback) ───────────────────────────────

function alpacaHeaders(apiKey: string, secretKey: string): Record<string, string> {
  return {
    "APCA-API-KEY-ID": apiKey,
    "APCA-API-SECRET-KEY": secretKey,
  };
}

async function fetchAlpacaIndices(
  apiKey: string,
  secretKey: string,
): Promise<MarketIndexSnapshot[]> {
  const symbols = Object.keys(ALPACA_INDICES);
  const headers = alpacaHeaders(apiKey, secretKey);
  const results: MarketIndexSnapshot[] = [];

  try {
    const params = new URLSearchParams({ symbols: symbols.join(","), feed: "iex" });
    const snapResp = await fetch(
      `${ALPACA_DATA_URL}/v2/stocks/snapshots?${params.toString()}`,
      { headers, signal: AbortSignal.timeout(5000) },
    );
    if (!snapResp.ok) return [];

    const snapData = (await snapResp.json()) as Record<
      string,
      {
        latestTrade?: { p: number };
        dailyBar?: { c: number; o: number };
        prevDailyBar?: { c: number };
      }
    >;

    // Fetch intraday bars for sparklines
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(now.getHours() - 8, 0, 0, 0);
    const barParams = new URLSearchParams({
      symbols: symbols.join(","),
      timeframe: "15Min",
      start: startOfDay.toISOString(),
      feed: "iex",
      limit: "30",
    });

    let barData: Record<string, Array<{ c: number }>> = {};
    try {
      const barResp = await fetch(
        `${ALPACA_DATA_URL}/v2/stocks/bars?${barParams.toString()}`,
        { headers, signal: AbortSignal.timeout(5000) },
      );
      if (barResp.ok) {
        const parsed = (await barResp.json()) as { bars: Record<string, Array<{ c: number }>> };
        barData = parsed.bars ?? {};
      }
    } catch { /* sparklines are optional */ }

    for (const symbol of symbols) {
      const snap = snapData[symbol];
      if (!snap) continue;

      const price = snap.latestTrade?.p ?? snap.dailyBar?.c ?? 0;
      const prevClose = snap.prevDailyBar?.c ?? snap.dailyBar?.o ?? price;
      const change = price - prevClose;
      const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
      const sparklineValues = (barData[symbol] ?? []).map((b) => b.c);

      results.push({
        symbol,
        name: ALPACA_INDICES[symbol] ?? symbol,
        price,
        change,
        changePct,
        sparklineValues,
      });
    }
  } catch { /* return empty on network failure */ }

  return results;
}

async function fetchAlpacaSectors(
  apiKey: string,
  secretKey: string,
): Promise<SectorSnapshot[]> {
  const symbols = Object.keys(SECTOR_ETFS);
  const headers = alpacaHeaders(apiKey, secretKey);
  try {
    const params = new URLSearchParams({ symbols: symbols.join(","), feed: "iex" });
    const resp = await fetch(
      `${ALPACA_DATA_URL}/v2/stocks/snapshots?${params.toString()}`,
      { headers, signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return [];

    const snapData = (await resp.json()) as Record<
      string,
      { dailyBar?: { c: number; o: number }; prevDailyBar?: { c: number } }
    >;

    return symbols
      .filter((s) => snapData[s])
      .map((s) => {
        const snap = snapData[s];
        const price = snap.dailyBar?.c ?? 0;
        const prevClose = snap.prevDailyBar?.c ?? snap.dailyBar?.o ?? price;
        const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
        return { symbol: s, name: SECTOR_ETFS[s], changePct };
      })
      .sort((a, b) => b.changePct - a.changePct);
  } catch {
    return [];
  }
}

async function fetchAlpacaNews(
  apiKey: string,
  secretKey: string,
  limit = 5,
): Promise<NewsHeadline[]> {
  try {
    const params = new URLSearchParams({ limit: String(limit), sort: "desc" });
    const resp = await fetch(
      `${ALPACA_DATA_URL}/v1beta1/news?${params.toString()}`,
      { headers: alpacaHeaders(apiKey, secretKey), signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return [];

    const data = (await resp.json()) as {
      news: Array<{
        id: number;
        headline: string;
        source: string;
        created_at: string;
        symbols: string[];
        url?: string;
      }>;
    };

    return (data.news ?? []).map((n) => ({
      id: String(n.id),
      headline: n.headline,
      source: n.source,
      timestamp: n.created_at,
      symbols: n.symbols ?? [],
      url: n.url,
    }));
  } catch {
    return [];
  }
}

async function fetchAlpacaMarketClock(
  apiKey: string,
  secretKey: string,
): Promise<{ isOpen: boolean }> {
  try {
    const resp = await fetch(`${ALPACA_PAPER_URL}/v2/clock`, {
      headers: alpacaHeaders(apiKey, secretKey),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return { isOpen: false };

    const data = (await resp.json()) as { is_open: boolean };
    return { isOpen: data.is_open };
  } catch {
    return { isOpen: false };
  }
}

// ── Public API ───────────────────────────────────────────────

/** Fetch market index snapshots for dashboard display */
export async function fetchMarketIndices(): Promise<MarketIndexSnapshot[]> {
  const info = await detectProvider();
  if (info.provider === "fmp") {
    return fetchFmpIndices(info.fmpApiKey).catch(() => []);
  }
  if (info.provider === "alpaca") {
    return fetchAlpacaIndices(info.alpacaApiKey, info.alpacaSecretKey).catch(() => []);
  }
  if (info.provider === "yfinance") {
    return fetchYFinanceIndices().catch(() => []);
  }
  return [];
}

/** Fetch sector ETF snapshots for heatmap display */
export async function fetchSectorSnapshots(): Promise<SectorSnapshot[]> {
  const info = await detectProvider();
  if (info.provider === "fmp") {
    return fetchFmpSectors(info.fmpApiKey).catch(() => []);
  }
  if (info.provider === "alpaca") {
    return fetchAlpacaSectors(info.alpacaApiKey, info.alpacaSecretKey).catch(() => []);
  }
  if (info.provider === "yfinance") {
    return fetchYFinanceSectors().catch(() => []);
  }
  return [];
}

/** Fetch latest news headlines */
export async function fetchNewsHeadlines(limit = 8): Promise<NewsHeadline[]> {
  const info = await detectProvider();
  if (info.provider === "fmp") {
    return fetchFmpNews(info.fmpApiKey, limit).catch(() => []);
  }
  if (info.provider === "alpaca") {
    return fetchAlpacaNews(info.alpacaApiKey, info.alpacaSecretKey, limit).catch(() => []);
  }
  if (info.provider === "yfinance") {
    return fetchYFinanceNews(limit).catch(() => []);
  }
  return [];
}

/** Check if market is currently open */
export async function fetchMarketClock(): Promise<{ isOpen: boolean }> {
  const info = await detectProvider();
  if (info.provider === "fmp") {
    return fetchFmpMarketClock(info.fmpApiKey).catch(() => ({ isOpen: false }));
  }
  if (info.provider === "alpaca") {
    return fetchAlpacaMarketClock(info.alpacaApiKey, info.alpacaSecretKey).catch(() => ({ isOpen: false }));
  }
  if (info.provider === "yfinance") {
    return fetchYFinanceMarketClock().catch(() => ({ isOpen: false }));
  }
  return { isOpen: false };
}

/** Get the active market data provider name */
export async function getMarketDataProvider(): Promise<"fmp" | "alpaca" | "yfinance" | "none"> {
  const info = await detectProvider();
  return info.provider;
}

/** Aggregate all market data for the dashboard */
export async function getDashboardMarketData(): Promise<DashboardMarketData> {
  const [indices, news, sectors, clock] = await Promise.all([
    fetchMarketIndices().catch(() => [] as MarketIndexSnapshot[]),
    fetchNewsHeadlines().catch(() => [] as NewsHeadline[]),
    fetchSectorSnapshots().catch(() => [] as SectorSnapshot[]),
    fetchMarketClock().catch(() => ({ isOpen: false })),
  ]);

  return {
    indices,
    news,
    sectors,
    marketOpen: clock.isOpen,
    fetchedAt: new Date().toISOString(),
  };
}
