import { listFundNames, loadFundConfig } from "./fund.service.js";
import { readPortfolio, readTracker, readSessionLog } from "../state.js";

export interface FundStatusData {
  name: string;
  displayName: string;
  status: "active" | "paused" | "closed" | string;
  initialCapital: number;
  currentValue: number;
  pnl: number;
  pnlPct: number;
  positions: number;
  cashPct: number;
  progressPct: number | null;
  progressStatus: string | null;
  lastSession: { type: string; startedAt: string } | null;
  error?: boolean;
}

/** Get structured status data for all funds */
export async function getAllFundStatuses(): Promise<FundStatusData[]> {
  const names = await listFundNames();
  const results: FundStatusData[] = [];

  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      const portfolio = await readPortfolio(name).catch(() => null);
      const tracker = await readTracker(name).catch(() => null);
      const lastSession = await readSessionLog(name);

      const currentValue = portfolio?.total_value ?? config.capital.initial;
      const pnl = currentValue - config.capital.initial;
      const pnlPct = config.capital.initial > 0 ? (pnl / config.capital.initial) * 100 : 0;
      const cashPct =
        portfolio && portfolio.total_value > 0
          ? (portfolio.cash / portfolio.total_value) * 100
          : 100;

      results.push({
        name,
        displayName: config.fund.display_name,
        status: config.fund.status,
        initialCapital: config.capital.initial,
        currentValue,
        pnl,
        pnlPct,
        positions: portfolio?.positions.length ?? 0,
        cashPct,
        progressPct: tracker?.progress_pct ?? null,
        progressStatus: tracker?.status ?? null,
        lastSession: lastSession
          ? { type: lastSession.session_type, startedAt: lastSession.started_at }
          : null,
      });
    } catch {
      results.push({
        name,
        displayName: name,
        status: "error",
        initialCapital: 0,
        currentValue: 0,
        pnl: 0,
        pnlPct: 0,
        positions: 0,
        cashPct: 0,
        progressPct: null,
        progressStatus: null,
        lastSession: null,
        error: true,
      });
    }
  }

  return results;
}
