import { useState, useEffect, useCallback } from "react";
import { readSessionHandoff, readPortfolio, readPendingSessions } from "../state.js";
import { loadFundConfig } from "../services/fund.service.js";
import { loadGlobalConfig } from "../config.js";
import { useInterval } from "./useInterval.js";
import type { Portfolio, FundConfig, PendingSession } from "../types.js";
import type { UpcomingItem } from "../components/UpcomingPanel.js";
import type { MarketTicker } from "../components/MarketPanel.js";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FMP_BASE = "https://financialmodelingprep.com/api/v3";

export interface SidebarData {
  handoff: string | null;
  portfolio: Portfolio | null;
  upcoming: UpcomingItem[];
  market: MarketTicker[];
  isMarketOpen: boolean;
  isLoading: boolean;
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
): UpcomingItem[] {
  const items: UpcomingItem[] = [];
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Pending sessions (self-scheduled)
  for (const ps of pendingSessions) {
    const scheduledDate = new Date(ps.scheduled_at);
    const isToday = scheduledDate.toDateString() === now.toDateString();
    if (!isToday) continue;
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

  // Sort by time
  items.sort((a, b) => a.time.localeCompare(b.time));
  return items;
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
    isLoading: true,
  });

  // Initial load
  useEffect(() => {
    if (!fundName) return;
    let cancelled = false;

    (async () => {
      try {
        const [handoff, portfolio, pending, config, globalConfig] = await Promise.all([
          readSessionHandoff(fundName).catch(() => null),
          readPortfolio(fundName).catch(() => null),
          readPendingSessions(fundName).catch(() => []),
          loadFundConfig(fundName).catch(() => null),
          loadGlobalConfig().catch(() => null),
        ]);

        if (cancelled) return;

        const upcoming = config ? buildUpcomingItems(pending, config) : [];
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
          setData({ handoff, portfolio, upcoming, market, isMarketOpen, isLoading: false });
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
      const [portfolio, globalConfig] = await Promise.all([
        readPortfolio(fundName).catch(() => null),
        loadGlobalConfig().catch(() => null),
      ]);

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
