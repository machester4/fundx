import YahooFinance from "yahoo-finance2";
import { loadGlobalConfig } from "../config.js";
import { queryArticles } from "./news.service.js";
import type { MarketIndexSnapshot, NewsHeadline, SectorSnapshot, DashboardMarketData, DailyBar, FmpScreenerFilters } from "../types.js";
import { SP500_FALLBACK } from "../constants/sp500.js";

const yf = new YahooFinance();

// ── Constants ────────────────────────────────────────────────

const FMP_BASE = "https://financialmodelingprep.com/api/v3";
const FMP_STABLE_BASE = "https://financialmodelingprep.com/stable";

const FMP_INDICES: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "NASDAQ",
  "^VIX": "VIX",
  "XAUUSD": "Gold",
  "XAGUSD": "Silver",
  "BTCUSD": "BTC",
  "CLUSD": "WTI",
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

const YFINANCE_INDICES: Record<string, string> = {
  "^GSPC": "S&P 500",
  "^IXIC": "NASDAQ",
  "^VIX": "VIX",
  "GC=F": "Gold",
  "SI=F": "Silver",
  "BTC-USD": "BTC",
  "CL=F": "WTI",
};

// ── Provider detection ───────────────────────────────────────

type ProviderInfo =
  | { provider: "fmp"; fmpApiKey: string }
  | { provider: "yfinance" }
  | { provider: "none" };

async function detectProvider(): Promise<ProviderInfo> {
  try {
    const config = await loadGlobalConfig();

    const fmpKey = config.market_data?.fmp_api_key;
    if (fmpKey) {
      return { provider: "fmp", fmpApiKey: fmpKey };
    }

    return { provider: "yfinance" };
  } catch (err) {
    const isNotFound =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      console.error("[market] Failed to load global config for provider detection:", err);
    }
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

  if (!quotesResult.ok) {
    console.error(`[market] FMP quotes request failed: HTTP ${quotesResult.status}`);
    return [];
  }

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
      // FMP returns newest first — take the 12 most recent bars then reverse to chronological order
      sparklines.set(symbols[i], bars.slice(0, 12).reverse().map((b) => b.close));
    } catch { /* sparklines are optional */ }
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

    if (!resp.ok) {
      console.error(`[market] FMP news request failed: HTTP ${resp.status}`);
      return [];
    }

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

    if (!resp.ok) {
      console.error(`[market] FMP market clock request failed: HTTP ${resp.status}`);
      return { isOpen: false };
    }

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
    if (!resp.ok) {
      console.error(`[market] FMP sectors request failed: HTTP ${resp.status}`);
      return [];
    }

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
  try {
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
  } catch (err) {
    console.error("[market] YFinance indices fetch failed:", err);
    return [];
  }
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

// ── Ordering ─────────────────────────────────────────────────

const INDEX_ORDER = ["S&P 500", "NASDAQ", "BTC", "VIX", "Gold", "Silver", "WTI"];

function sortIndices(indices: MarketIndexSnapshot[]): MarketIndexSnapshot[] {
  return [...indices].sort((a, b) => {
    const ai = INDEX_ORDER.indexOf(a.name);
    const bi = INDEX_ORDER.indexOf(b.name);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

// ── Public API ───────────────────────────────────────────────

/** Fetch market index snapshots for dashboard display */
export async function fetchMarketIndices(): Promise<MarketIndexSnapshot[]> {
  const info = await detectProvider();
  let results: MarketIndexSnapshot[] = [];
  if (info.provider === "fmp") {
    results = await fetchFmpIndices(info.fmpApiKey).catch(() => []);
  } else if (info.provider === "yfinance") {
    results = await fetchYFinanceIndices().catch(() => []);
  }
  return sortIndices(results);
}

/** Fetch sector ETF snapshots for heatmap display */
export async function fetchSectorSnapshots(): Promise<SectorSnapshot[]> {
  const info = await detectProvider();
  if (info.provider === "fmp") {
    return fetchFmpSectors(info.fmpApiKey).catch(() => []);
  }
  if (info.provider === "yfinance") {
    return fetchYFinanceSectors().catch(() => []);
  }
  return [];
}

/** Fetch latest news headlines from FMP/YFinance (live) */
export async function fetchNewsHeadlines(limit = 8): Promise<NewsHeadline[]> {
  const info = await detectProvider();
  if (info.provider === "fmp") {
    return fetchFmpNews(info.fmpApiKey, limit).catch(() => []);
  }
  if (info.provider === "yfinance") {
    return fetchYFinanceNews(limit).catch(() => []);
  }
  return [];
}

/**
 * Dashboard headline source. Prefers the RSS cache (same data the agent sees),
 * falls back to live FMP/YFinance fetch when the cache is empty or unavailable.
 */
export async function fetchDashboardHeadlines(limit = 8): Promise<NewsHeadline[]> {
  const result = await queryArticles({ hours: 24, limit });
  if (result.status === "ok") {
    return result.articles.map((a) => ({
      id: a.id,
      headline: a.title,
      source: a.source,
      timestamp: a.published_at,
      symbols: a.symbols,
      url: a.url || undefined,
    }));
  }
  // empty or unavailable → try live fetch so the panel isn't blank
  return fetchNewsHeadlines(limit);
}

/** Check if market is currently open */
export async function fetchMarketClock(): Promise<{ isOpen: boolean }> {
  const info = await detectProvider();
  if (info.provider === "fmp") {
    return fetchFmpMarketClock(info.fmpApiKey).catch(() => ({ isOpen: false }));
  }
  if (info.provider === "yfinance") {
    return fetchYFinanceMarketClock().catch(() => ({ isOpen: false }));
  }
  return { isOpen: false };
}

/** Get the active market data provider name */
export async function getMarketDataProvider(): Promise<"fmp" | "yfinance" | "none"> {
  const info = await detectProvider();
  return info.provider;
}

/** Aggregate all market data for the dashboard */
export async function getDashboardMarketData(): Promise<DashboardMarketData> {
  const [indices, news, sectors, clock] = await Promise.all([
    fetchMarketIndices().catch(() => [] as MarketIndexSnapshot[]),
    fetchDashboardHeadlines().catch(() => [] as NewsHeadline[]),
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

// ── Screening helpers ────────────────────────────────────────

/**
 * Fetch daily OHLCV bars for a single ticker from FMP.
 * Returns bars in chronological order (oldest first).
 */
export async function getHistoricalDaily(
  ticker: string,
  days: number,
  apiKey: string,
): Promise<DailyBar[]> {
  const url =
    `${FMP_BASE}/historical-price-full/${encodeURIComponent(ticker)}` +
    `?timeseries=${days}&apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(
      `FMP /historical-price-full failed for ${ticker}: ${resp.status}`,
    );
  }
  const body = (await resp.json()) as {
    historical?: Array<{ date: string; adjClose?: number; close: number; volume: number }>;
  };
  const historical = body.historical ?? [];
  // FMP returns newest first; reverse for chronological order.
  return historical
    .slice()
    .reverse()
    .map((r) => ({
      date: r.date,
      close: r.adjClose ?? r.close,
      volume: r.volume,
    }));
}

// ── Universe endpoints (raw + safe variants) ─────────────────
// Raw variants throw on HTTP error or empty response — used by
// universe.service.ts which manages its own fallback chain.
// Non-raw variants are the safe public API for callers that want
// silent degradation.

/** Fetch S&P 500 constituents. Throws on HTTP error or empty/invalid body. */
export async function getSp500ConstituentsRaw(apiKey: string): Promise<string[]> {
  const url = `${FMP_BASE}/sp500_constituent?apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`FMP /sp500_constituent returned ${resp.status}`);
  const body = (await resp.json()) as Array<{ symbol: string }>;
  if (!Array.isArray(body) || body.length === 0) throw new Error("FMP /sp500_constituent returned empty/invalid body");
  return body.map((r) => r.symbol);
}

/**
 * Fetch the current S&P 500 constituent list from FMP.
 * Falls back to the static SP500_FALLBACK list when the API call fails
 * or returns an empty/unexpected response.
 */
export async function getSp500Constituents(apiKey: string): Promise<string[]> {
  try {
    return await getSp500ConstituentsRaw(apiKey);
  } catch (err) {
    console.warn(`[market] sp500 constituent fetch failed: ${err instanceof Error ? err.message : err}; using fallback list`);
    return [...SP500_FALLBACK];
  }
}

/** Fetch Nasdaq 100 constituents. Throws on HTTP error or empty/invalid body. */
export async function getNasdaq100ConstituentsRaw(apiKey: string): Promise<string[]> {
  const url = `${FMP_BASE}/nasdaq_constituent?apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`FMP /nasdaq_constituent returned ${resp.status}`);
  const body = (await resp.json()) as Array<{ symbol: string }>;
  if (!Array.isArray(body) || body.length === 0) throw new Error("FMP /nasdaq_constituent returned empty/invalid body");
  return body.map((r) => r.symbol);
}

/**
 * Fetch the current Nasdaq 100 constituent list from FMP.
 * Returns [] on error — caller decides fallback behavior.
 */
export async function getNasdaq100Constituents(apiKey: string): Promise<string[]> {
  try {
    return await getNasdaq100ConstituentsRaw(apiKey);
  } catch (err) {
    console.warn(`[market] FMP /nasdaq_constituent failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/** Fetch Dow 30 constituents. Throws on HTTP error or empty/invalid body. */
export async function getDow30ConstituentsRaw(apiKey: string): Promise<string[]> {
  const url = `${FMP_BASE}/dowjones_constituent?apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`FMP /dowjones_constituent returned ${resp.status}`);
  const body = (await resp.json()) as Array<{ symbol: string }>;
  if (!Array.isArray(body) || body.length === 0) throw new Error("FMP /dowjones_constituent returned empty/invalid body");
  return body.map((r) => r.symbol);
}

/**
 * Fetch the current Dow 30 constituent list from FMP.
 * Returns [] on error — caller decides fallback behavior.
 */
export async function getDow30Constituents(apiKey: string): Promise<string[]> {
  try {
    return await getDow30ConstituentsRaw(apiKey);
  } catch (err) {
    console.warn(`[market] FMP /dowjones_constituent failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// Translate snake_case filter keys to FMP camelCase query params
const FMP_SCREENER_PARAM_MAP: Record<string, string> = {
  market_cap_min: "marketCapMoreThan",
  market_cap_max: "marketCapLowerThan",
  price_min: "priceMoreThan",
  price_max: "priceLowerThan",
  beta_min: "betaMoreThan",
  beta_max: "betaLowerThan",
  dividend_min: "dividendMoreThan",
  dividend_max: "dividendLowerThan",
  volume_min: "volumeMoreThan",
  volume_max: "volumeLowerThan",
  industry: "industry",
  country: "country",
  is_etf: "isEtf",
  is_fund: "isFund",
  is_actively_trading: "isActivelyTrading",
  include_all_share_classes: "includeAllShareClasses",
  limit: "limit",
};

function buildScreenerQuery(filters: FmpScreenerFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null) continue;
    // Array keys: sector[] and exchange[] — FMP accepts repeated params
    if (Array.isArray(v)) {
      const fmpKey = k === "sector" ? "sector" : k === "exchange" ? "exchange" : k;
      for (const item of v) params.append(fmpKey, String(item));
      continue;
    }
    const fmpKey = FMP_SCREENER_PARAM_MAP[k];
    if (!fmpKey) continue;
    params.append(fmpKey, String(v));
  }
  // URLSearchParams encodes spaces as "+", but HTTP convention for path params
  // is "%20". Replace so URL assertions in tests and real FMP requests are consistent.
  return params.toString().replace(/\+/g, "%20");
}

export interface ScreenerResult {
  symbol: string;
  companyName?: string;
  marketCap?: number;
  sector?: string;
  industry?: string;
  exchange?: string;
  price?: number;
  beta?: number;
  volume?: number;
  country?: string;
  isEtf?: boolean;
  isFund?: boolean;
  isActivelyTrading?: boolean;
}

/** Call FMP /stable/company-screener. Throws on HTTP error or non-array body. */
export async function getScreenerResultsRaw(
  filters: FmpScreenerFilters,
  apiKey: string,
): Promise<ScreenerResult[]> {
  const query = buildScreenerQuery(filters);
  const url = `${FMP_STABLE_BASE}/company-screener?${query}&apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`FMP /company-screener returned HTTP ${resp.status}`);
  const body = (await resp.json()) as ScreenerResult[];
  if (!Array.isArray(body) || body.length === 0) throw new Error("FMP screener returned empty/invalid body");
  return body;
}

/**
 * Call FMP /stable/company-screener with the given filters.
 * Returns [] on error — caller decides fallback behavior.
 */
export async function getScreenerResults(
  filters: FmpScreenerFilters,
  apiKey: string,
): Promise<ScreenerResult[]> {
  try {
    return await getScreenerResultsRaw(filters, apiKey);
  } catch (err) {
    console.warn(`[market] FMP /company-screener failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

// ── Company profile (with LRU cache) ─────────────────────────
// In-memory LRU, size 500, TTL 24h. Shared across the process.
// Used by universe resolver, check_universe tool, and broker gate.

export interface CompanyProfile {
  symbol: string;
  companyName?: string;
  sector?: string;
  industry?: string;
  exchange?: string;
  country?: string;
  marketCap?: number;
}

interface CacheEntry { at: number; profile: CompanyProfile | null }
const PROFILE_CACHE_SIZE = 500;
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const profileCache = new Map<string, CacheEntry>();

function getCached(key: string, now: number): CompanyProfile | null | undefined {
  const hit = profileCache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > PROFILE_CACHE_TTL_MS) {
    profileCache.delete(key);
    return undefined;
  }
  // LRU: move to end
  profileCache.delete(key);
  profileCache.set(key, hit);
  return hit.profile;
}

function setCached(key: string, profile: CompanyProfile | null, now: number): void {
  profileCache.set(key, { at: now, profile });
  if (profileCache.size > PROFILE_CACHE_SIZE) {
    const oldest = profileCache.keys().next().value;
    if (oldest) profileCache.delete(oldest);
  }
}

/** For tests only. */
export function _resetProfileCacheForTests(): void {
  profileCache.clear();
}

/**
 * Fetch a company's profile (sector, industry, exchange) from FMP.
 * Cached in-memory for 24h. Returns null when the ticker is unknown.
 */
export async function getCompanyProfile(
  ticker: string,
  apiKey: string,
  opts?: { now?: number },
): Promise<CompanyProfile | null> {
  const key = ticker.toUpperCase();
  const now = opts?.now ?? Date.now();
  const cached = getCached(key, now);
  if (cached !== undefined) return cached;

  const url = `${FMP_BASE}/profile/${key}?apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    console.warn(`[market] FMP /profile/${key} returned ${resp.status}`);
    return null;
  }
  const body = (await resp.json()) as CompanyProfile[];
  const profile = Array.isArray(body) && body.length > 0 ? body[0] : null;
  setCached(key, profile, now);
  return profile;
}
