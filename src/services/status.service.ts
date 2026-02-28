import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { listFundNames, loadFundConfig } from "./fund.service.js";
import { readPortfolio, readTracker, readSessionLog } from "../state.js";
import { getHistoryData } from "./chart.service.js";
import { getPerformanceData } from "./performance.service.js";
import { computeCorrelationMatrix } from "./correlation.service.js";
import { checkSpecialSessions, KNOWN_EVENTS } from "./special-sessions.service.js";
import { loadGlobalConfig } from "../config.js";
import { ALPACA_PAPER_URL } from "../alpaca-helpers.js";
import { DAEMON_PID } from "../paths.js";
import { getMarketDataProvider } from "./market.service.js";
import type { FundConfig, ServiceStatus, NextCronInfo } from "../types.js";

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

// ── Dashboard Helpers ─────────────────────────────────────────

async function getDaemonStatus(): Promise<{ running: boolean; pid?: number }> {
  if (!existsSync(DAEMON_PID)) return { running: false };
  try {
    const pid = parseInt(await readFile(DAEMON_PID, "utf-8"), 10);
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getObjectiveLabel(config: FundConfig): string {
  const t = config.objective.type;
  if (t === "runway")
    return `Runway (${(config.objective as { target_months: number }).target_months}mo)`;
  if (t === "growth") {
    const m = (config.objective as { target_multiple?: number }).target_multiple;
    return m ? `Growth (${m}x)` : "Growth";
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── Dashboard Data ────────────────────────────────────────────

export interface FundExtras {
  sparklineValues: number[];
  topHoldings: Array<{ symbol: string; weightPct: number }>;
  objectiveType: string;
  objectiveLabel: string;
  nextSession: string | null;
  lastSessionAgo: string | null;
  tradesInLastSession: number;
}

export interface DashboardAlerts {
  overweight: Array<{ fund: string; symbol: string; weightPct: number; maxPct: number }>;
  highCorrelations: Array<{ fundA: string; fundB: string; correlation: number }>;
  upcomingEvents: Array<{ name: string; trigger: string }>;
}

export interface DashboardData {
  funds: FundStatusData[];
  fundExtras: Map<string, FundExtras>;
  alerts: DashboardAlerts;
  daemonRunning: boolean;
  services: ServiceStatus;
  nextCron: NextCronInfo | null;
}

/** Check if Telegram is configured */
async function checkTelegramStatus(): Promise<boolean> {
  try {
    const config = await loadGlobalConfig();
    return !!(config.telegram.enabled && config.telegram.bot_token && config.telegram.chat_id);
  } catch {
    return false;
  }
}

/** Check if the active market data provider is reachable */
async function checkMarketDataStatus(): Promise<{ ok: boolean; provider: "fmp" | "alpaca" | "none" }> {
  const provider = await getMarketDataProvider();

  if (provider === "fmp") {
    try {
      const config = await loadGlobalConfig();
      const apiKey = config.market_data?.fmp_api_key;
      if (!apiKey) return { ok: false, provider };
      const resp = await fetch(
        `https://financialmodelingprep.com/api/v3/is-the-market-open?apikey=${apiKey}`,
        { signal: AbortSignal.timeout(3000) },
      );
      return { ok: resp.ok, provider };
    } catch {
      return { ok: false, provider };
    }
  }

  if (provider === "alpaca") {
    try {
      const config = await loadGlobalConfig();
      if (!config.broker.api_key || !config.broker.secret_key) return { ok: false, provider };
      const resp = await fetch(`${ALPACA_PAPER_URL}/v2/account`, {
        headers: {
          "APCA-API-KEY-ID": config.broker.api_key,
          "APCA-API-SECRET-KEY": config.broker.secret_key,
        },
        signal: AbortSignal.timeout(3000),
      });
      return { ok: resp.ok, provider };
    } catch {
      return { ok: false, provider };
    }
  }

  return { ok: false, provider: "none" };
}

/** Get the next scheduled cron session across all funds */
async function getNextCron(): Promise<NextCronInfo | null> {
  try {
    const names = await listFundNames();
    const now = new Date();
    let nearest: NextCronInfo | null = null;

    for (const name of names) {
      try {
        const config = await loadFundConfig(name);
        if (config.fund.status !== "active") continue;

        for (const [sessionType, session] of Object.entries(config.schedule.sessions)) {
          if (!session.enabled) continue;

          // Parse HH:MM time
          const [hours, minutes] = session.time.split(":").map(Number);
          if (isNaN(hours) || isNaN(minutes)) continue;

          const sessionTime = new Date(now);
          sessionTime.setHours(hours, minutes, 0, 0);

          // If time already passed today, try tomorrow
          if (sessionTime <= now) {
            sessionTime.setDate(sessionTime.getDate() + 1);
          }

          const minutesUntil = Math.round((sessionTime.getTime() - now.getTime()) / 60_000);

          if (!nearest || minutesUntil < nearest.minutesUntil) {
            nearest = {
              fundName: name,
              sessionType,
              time: session.time,
              minutesUntil,
            };
          }
        }
      } catch { /* skip */ }
    }

    return nearest;
  } catch {
    return null;
  }
}

/** Get service statuses for the dashboard */
export async function getServiceStatuses(): Promise<ServiceStatus> {
  const [daemon, telegram, marketStatus] = await Promise.all([
    getDaemonStatus().then((d) => d.running),
    checkTelegramStatus(),
    checkMarketDataStatus(),
  ]);
  return { daemon, telegram, marketData: marketStatus.ok, marketDataProvider: marketStatus.provider };
}

/** Aggregate all dashboard data in a single call */
export async function getDashboardData(): Promise<DashboardData> {
  const funds = await getAllFundStatuses();
  const fundExtras = new Map<string, FundExtras>();
  const alerts: DashboardAlerts = {
    overweight: [],
    highCorrelations: [],
    upcomingEvents: [],
  };

  // Gather per-fund extras
  for (const fund of funds) {
    if (fund.error) {
      fundExtras.set(fund.name, {
        sparklineValues: [],
        topHoldings: [],
        objectiveType: "unknown",
        objectiveLabel: "Error",
        nextSession: null,
        lastSessionAgo: null,
        tradesInLastSession: 0,
      });
      continue;
    }

    let sparklineValues: number[] = [];
    let topHoldings: Array<{ symbol: string; weightPct: number }> = [];
    let objectiveType = "unknown";
    let objectiveLabel = "Unknown";
    let nextSession: string | null = null;
    let lastSessionAgo: string | null = null;
    let tradesInLastSession = 0;

    try {
      const config = await loadFundConfig(fund.name);
      objectiveType = config.objective.type;
      objectiveLabel = getObjectiveLabel(config);

      // Next session from schedule
      const sessions = Object.entries(config.schedule.sessions).filter(([, s]) => s.enabled);
      if (sessions.length > 0) {
        const [name, s] = sessions[0];
        nextSession = `${name} ${s.time}`;
      }

      // Upcoming events
      const matching = checkSpecialSessions(config);
      for (const m of matching) {
        const known = KNOWN_EVENTS.find((e) => e.trigger === m.trigger);
        alerts.upcomingEvents.push({ name: known?.name ?? m.trigger, trigger: m.trigger });
      }
    } catch { /* skip */ }

    try {
      const history = await getHistoryData(fund.name, 30);
      if (history) {
        sparklineValues = history.volumes;
      }
    } catch { /* skip */ }

    try {
      const portfolio = await readPortfolio(fund.name);
      topHoldings = portfolio.positions
        .sort((a, b) => b.weight_pct - a.weight_pct)
        .slice(0, 4)
        .map((p) => ({ symbol: p.symbol, weightPct: p.weight_pct }));
    } catch { /* skip */ }

    try {
      const perf = await getPerformanceData(fund.name);
      for (const ow of perf.overweightPositions) {
        alerts.overweight.push({ fund: fund.name, ...ow });
      }
    } catch { /* skip */ }

    if (fund.lastSession) {
      lastSessionAgo = timeAgo(fund.lastSession.startedAt);
    }

    try {
      const session = await readSessionLog(fund.name);
      if (session) tradesInLastSession = session.trades_executed;
    } catch { /* skip */ }

    fundExtras.set(fund.name, {
      sparklineValues,
      topHoldings,
      objectiveType,
      objectiveLabel,
      nextSession,
      lastSessionAgo,
      tradesInLastSession,
    });
  }

  // Cross-fund correlations
  try {
    const correlations = await computeCorrelationMatrix(30);
    for (const c of correlations) {
      if (Math.abs(c.correlation) > 0.7) {
        alerts.highCorrelations.push({
          fundA: c.fund_a,
          fundB: c.fund_b,
          correlation: c.correlation,
        });
      }
    }
  } catch { /* skip */ }

  const [daemon, services, nextCron] = await Promise.all([
    getDaemonStatus(),
    getServiceStatuses(),
    getNextCron(),
  ]);

  return {
    funds,
    fundExtras,
    alerts,
    daemonRunning: daemon.running,
    services,
    nextCron,
  };
}
