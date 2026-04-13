import { useState, useEffect, useCallback } from "react";
import { readSessionHandoff, readPortfolio, readPendingSessions, readSessionHistory } from "../state.js";
import { loadFundConfig } from "../services/fund.service.js";
import { loadGlobalConfig } from "../config.js";
import { queryArticles } from "../services/news.service.js";
import { useInterval } from "./useInterval.js";
import type { Portfolio, FundConfig, PendingSession } from "../types.js";
import type { UpcomingItem } from "../components/UpcomingPanel.js";
import type { MarketTicker } from "../components/MarketPanel.js";
import type { NewsSidebarArticle, NewsSidebarStatus } from "../components/NewsSidebarPanel.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

export interface SidebarData {
  handoff: string | null;
  portfolio: Portfolio | null;
  upcoming: UpcomingItem[];
  market: MarketTicker[];
  isMarketOpen: boolean;
  newsArticles: NewsSidebarArticle[];
  newsStatus: NewsSidebarStatus;
  newsReason?: string;
  newsNewestAgeMinutes?: number;
  isLoading: boolean;
}

interface NewsSnapshot {
  articles: NewsSidebarArticle[];
  status: NewsSidebarStatus;
  reason?: string;
  newestAgeMinutes?: number;
}

/** Fetch a compact news snapshot for the sidebar. Always resolves — never throws. */
async function fetchNewsSnapshot(limit = 3): Promise<NewsSnapshot> {
  try {
    const result = await queryArticles({ hours: 24, limit });
    if (result.status === "unavailable") {
      const isLock = /lock|read-write/i.test(result.reason);
      return {
        articles: [],
        status: isLock ? "locked" : "unavailable",
        reason: result.reason,
      };
    }
    if (result.status === "empty") {
      return { articles: [], status: "empty" };
    }
    const articles: NewsSidebarArticle[] = result.articles.map((a) => ({
      title: a.title,
      source: a.source,
      published_at: a.published_at,
    }));
    const newest = articles[0]?.published_at;
    const newestAgeMinutes = newest
      ? Math.round((Date.now() - new Date(newest).getTime()) / 60_000)
      : undefined;
    return { articles, status: "ok", newestAgeMinutes };
  } catch (err) {
    return {
      articles: [],
      status: "unavailable",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchFmpQuotes(
  symbols: string[],
  apiKey: string,
): Promise<Array<{ symbol: string; price: number; changesPercentage: number }>> {
  if (symbols.length === 0) return [];
  try {
    const resp = await fetch(
      `${FMP_BASE}/quote/${symbols.join(",")}?apikey=${apiKey}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return [];
    return (await resp.json()) as Array<{ symbol: string; price: number; changesPercentage: number }>;
  } catch {
    return [];
  }
}

function buildUpcomingItems(
  pendingSessions: PendingSession[],
  config: FundConfig,
  sessionHistory: Record<string, string>,
): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  const now = new Date();
  const today = now.toDateString();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Past sessions (ran today) from session_history
  for (const [sessionType, timestamp] of Object.entries(sessionHistory)) {
    const ran = new Date(timestamp);
    if (ran.toDateString() !== today) continue;
    const timeStr = ran.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    items.push({ time: timeStr, label: sessionType.replace(/_/g, " "), type: "past", status: "success" });
  }

  // Pending sessions (self-scheduled)
  for (const ps of pendingSessions) {
    const scheduledDate = new Date(ps.scheduled_at);
    if (scheduledDate.toDateString() !== today) continue;
    const timeStr = scheduledDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    items.push({ time: timeStr, label: ps.focus.slice(0, 30), type: "session" });
  }

  // Scheduled sessions from config (remaining today)
  for (const [name, session] of Object.entries(config.schedule.sessions)) {
    if (!session.enabled) continue;
    const [h, m] = (session.time ?? "").split(":").map(Number);
    if (h === undefined || m === undefined) continue;
    const sessionMinutes = h * 60 + m;
    if (sessionMinutes <= nowMinutes) continue; // already passed
    const timeStr = new Date(2000, 0, 1, h, m).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    items.push({ time: timeStr, label: name.replace(/_/g, " "), type: "session" });
  }

  // Sort: past first (by time), then upcoming (by time)
  const past = items.filter((i) => i.type === "past").sort((a, b) => a.time.localeCompare(b.time));
  const upcoming = items.filter((i) => i.type !== "past").sort((a, b) => a.time.localeCompare(b.time));
  return [...past, ...upcoming];
}

function isWithinMarketHours(): boolean {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export function useSidebarData(fundName: string | null): SidebarData {
  const [data, setData] = useState<SidebarData>({
    handoff: null,
    portfolio: null,
    upcoming: [],
    market: [],
    isMarketOpen: false,
    newsArticles: [],
    newsStatus: "empty",
    isLoading: true,
  });

  // Initial load
  useEffect(() => {
    if (!fundName) return;
    let cancelled = false;

    (async () => {
      try {
        const [handoff, portfolio, pending, config, globalConfig, sessionHistory, news] = await Promise.all([
          readSessionHandoff(fundName).catch(() => null),
          readPortfolio(fundName).catch(() => null),
          readPendingSessions(fundName).catch(() => []),
          loadFundConfig(fundName).catch(() => null),
          loadGlobalConfig().catch(() => null),
          readSessionHistory(fundName).catch(() => ({})),
          fetchNewsSnapshot(3),
        ]);

        if (cancelled) return;

        const upcoming = config ? buildUpcomingItems(pending, config, sessionHistory) : [];
        const isMarketOpen = isWithinMarketHours();

        // Fetch market data
        let market: MarketTicker[] = [];
        const fmpKey = globalConfig?.market_data?.fmp_api_key;
        if (fmpKey) {
          const positionSymbols = portfolio?.positions.map((p) => p.symbol) ?? [];
          const allSymbols = [...new Set(["SPY", "^VIX", ...positionSymbols])];
          const quotes = await fetchFmpQuotes(allSymbols, fmpKey);

          // Update portfolio with live prices
          if (portfolio && quotes.length > 0) {
            for (const pos of portfolio.positions) {
              const q = quotes.find((qt) => qt.symbol === pos.symbol);
              if (q) {
                pos.current_price = q.price;
                pos.market_value = pos.shares * q.price;
                pos.unrealized_pnl = (q.price - pos.avg_cost) * pos.shares;
                pos.unrealized_pnl_pct = pos.avg_cost > 0 ? ((q.price - pos.avg_cost) / pos.avg_cost) * 100 : 0;
              }
            }
            const posValue = portfolio.positions.reduce((s, p) => s + p.market_value, 0);
            portfolio.total_value = portfolio.cash + posValue;
            for (const pos of portfolio.positions) {
              pos.weight_pct = portfolio.total_value > 0 ? (pos.market_value / portfolio.total_value) * 100 : 0;
            }
          }

          market = quotes
            .filter((q) => ["SPY", "^VIX"].includes(q.symbol) || positionSymbols.includes(q.symbol))
            .map((q) => ({
              symbol: q.symbol === "^VIX" ? "VIX" : q.symbol,
              price: q.price,
              changePct: q.changesPercentage,
            }));
        }

        if (!cancelled) {
          setData({
            handoff,
            portfolio,
            upcoming,
            market,
            isMarketOpen,
            newsArticles: news.articles,
            newsStatus: news.status,
            newsReason: news.reason,
            newsNewestAgeMinutes: news.newestAgeMinutes,
            isLoading: false,
          });
        }
      } catch {
        if (!cancelled) {
          setData((prev) => ({ ...prev, isLoading: false }));
        }
      }
    })();

    return () => { cancelled = true; };
  }, [fundName]);

  // Poll market + portfolio every 5 min during market hours
  const refreshPrices = useCallback(async () => {
    if (!fundName) return;
    try {
      const [portfolio, globalConfig, news] = await Promise.all([
        readPortfolio(fundName).catch(() => null),
        loadGlobalConfig().catch(() => null),
        fetchNewsSnapshot(3),
      ]);

      // Apply news update regardless of whether market data is available
      setData((prev) => ({
        ...prev,
        newsArticles: news.articles,
        newsStatus: news.status,
        newsReason: news.reason,
        newsNewestAgeMinutes: news.newestAgeMinutes,
      }));

      const fmpKey = globalConfig?.market_data?.fmp_api_key;
      if (!fmpKey || !portfolio) return;

      const positionSymbols = portfolio.positions.map((p) => p.symbol);
      const allSymbols = [...new Set(["SPY", "^VIX", ...positionSymbols])];
      const quotes = await fetchFmpQuotes(allSymbols, fmpKey);
      if (quotes.length === 0) return;

      for (const pos of portfolio.positions) {
        const q = quotes.find((qt) => qt.symbol === pos.symbol);
        if (q) {
          pos.current_price = q.price;
          pos.market_value = pos.shares * q.price;
          pos.unrealized_pnl = (q.price - pos.avg_cost) * pos.shares;
          pos.unrealized_pnl_pct = pos.avg_cost > 0 ? ((q.price - pos.avg_cost) / pos.avg_cost) * 100 : 0;
        }
      }
      const posValue = portfolio.positions.reduce((s, p) => s + p.market_value, 0);
      portfolio.total_value = portfolio.cash + posValue;
      for (const pos of portfolio.positions) {
        pos.weight_pct = portfolio.total_value > 0 ? (pos.market_value / portfolio.total_value) * 100 : 0;
      }

      const market = quotes
        .filter((q) => ["SPY", "^VIX"].includes(q.symbol) || positionSymbols.includes(q.symbol))
        .map((q) => ({
          symbol: q.symbol === "^VIX" ? "VIX" : q.symbol,
          price: q.price,
          changePct: q.changesPercentage,
        }));

      const isMarketOpen = isWithinMarketHours();
      setData((prev) => ({ ...prev, portfolio, market, isMarketOpen }));
    } catch {
      // best effort
    }
  }, [fundName]);

  useInterval(
    useCallback(() => { void refreshPrices(); }, [refreshPrices]),
    fundName && data.isMarketOpen ? POLL_INTERVAL_MS : null,
  );

  return data;
}
