import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import {
  openWatchlistDb,
  queryWatchlist,
  getTrajectory,
  tagManually,
} from "../services/watchlist.service.js";
import { openPriceCache } from "../services/price-cache.service.js";
import {
  getHistoricalDaily,
  getScreenerResultsRaw,
  getCompanyProfile,
  type ScreenerResult,
} from "../services/market.service.js";
import { resolveUniverse } from "../services/universe.service.js";
import { runScreen, scoreMomentum121 } from "../services/screening.service.js";
import { readBars, isFresh, writeBars } from "../services/price-cache.service.js";
import {
  screenNameSchema,
  watchlistStatusSchema,
  fmpScreenerFiltersSchema,
  type FundConfig,
  type FmpScreenerFilters,
} from "../types.js";
import { loadGlobalConfig } from "../config.js";
import { loadAllFundConfigs } from "../services/fund.service.js";

const watchlistQueryArgs = z.object({
  fund: z.string().optional(),
  status: z.array(watchlistStatusSchema).optional(),
  screen: screenNameSchema.optional(),
  ticker: z.string().optional(),
  limit: z.number().int().positive().max(200).default(50),
});

export async function handleScreenRun(
  wdb: Database.Database,
  pcdb: Database.Database,
  args: { screen?: string; fund?: string },
  deps: {
    fetchBars: (ticker: string) => Promise<Awaited<ReturnType<typeof getHistoricalDaily>>>;
    resolveFundUniverse: (fundName: string) => Promise<import("../types.js").UniverseResolution>;
    loadFundConfigs: () => Promise<FundConfig[]>;
    now: () => number;
    getSector?: (ticker: string) => Promise<string | null>;
  },
): Promise<{ summary: Awaited<ReturnType<typeof runScreen>> }> {
  const screen = screenNameSchema.parse(args.screen ?? "momentum-12-1");
  const fundConfigs = await deps.loadFundConfigs();
  if (fundConfigs.length === 0) throw new Error("no funds configured");
  const activeConfigs = fundConfigs.filter((c) => c.fund.status === "active");
  if (activeConfigs.length === 0) throw new Error("no active funds configured");
  const fundName = args.fund ?? activeConfigs[0].fund.name;
  const target = activeConfigs.find((c) => c.fund.name === fundName);
  if (!target) throw new Error(`fund not found or not active: ${fundName}`);

  const resolution = await deps.resolveFundUniverse(fundName);
  const universeLabel =
    resolution.source.kind === "preset"
      ? `${resolution.source.preset} (${resolution.resolved_from})`
      : `filters (${resolution.resolved_from})`;

  const summary = await runScreen({
    watchlistDb: wdb,
    priceCacheDb: pcdb,
    universe: resolution.final_tickers,
    universeLabel,
    fetchBars: deps.fetchBars,
    fundConfigs: [target],
    resolutions: new Map([[fundName, resolution]]),
    now: deps.now(),
    screenName: screen,
    getSector: deps.getSector,
  });
  return { summary };
}

export interface DiscoverResultEntry {
  ticker: string;
  score: number;
  return_12_1: number;
  adv_usd_30d: number;
  last_price: number;
  missing_days: number;
  companyName?: string;
  sector?: string;
  market_cap?: number;
  exchange?: string;
  is_etf?: boolean;
}

export interface DiscoverResult {
  candidates_fetched: number;
  candidates_scored: number;
  candidates_passed: number;
  duration_ms: number;
  results: DiscoverResultEntry[];
}

const MIN_PRICE = 5;
const MIN_ADV_USD = 10_000_000;

export async function handleScreenDiscover(
  pcdb: Database.Database,
  args: { filters: FmpScreenerFilters; screen?: string },
  deps: {
    fetchCandidates: (filters: FmpScreenerFilters) => Promise<ScreenerResult[]>;
    fetchBars: (ticker: string) => Promise<import("../types.js").DailyBar[]>;
    now: () => number;
  },
): Promise<DiscoverResult> {
  const started = Date.now();
  const now = deps.now();

  let candidates: ScreenerResult[];
  try {
    candidates = await deps.fetchCandidates(args.filters);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("empty") || msg.includes("invalid body")) {
      return { candidates_fetched: 0, candidates_scored: 0, candidates_passed: 0, duration_ms: 0, results: [] };
    }
    throw err;
  }

  if (candidates.length === 0) {
    return { candidates_fetched: 0, candidates_scored: 0, candidates_passed: 0, duration_ms: 0, results: [] };
  }

  const metaMap = new Map<string, ScreenerResult>(candidates.map((c) => [c.symbol, c]));

  let candidates_scored = 0;
  let candidates_passed = 0;
  const scored: DiscoverResultEntry[] = [];

  for (const candidate of candidates) {
    const ticker = candidate.symbol;
    let bars: import("../types.js").DailyBar[];

    if (isFresh(pcdb, ticker, now)) {
      bars = readBars(pcdb, ticker);
    } else {
      try {
        bars = await deps.fetchBars(ticker);
        writeBars(pcdb, ticker, bars, now);
      } catch {
        continue;
      }
    }

    const ms = scoreMomentum121(bars);
    if (!ms) continue;
    candidates_scored++;

    if (ms.last_price < MIN_PRICE) continue;
    if (ms.adv_usd_30d < MIN_ADV_USD) continue;
    candidates_passed++;

    const meta = metaMap.get(ticker);
    scored.push({
      ticker,
      score: ms.score,
      return_12_1: ms.return_12_1,
      adv_usd_30d: ms.adv_usd_30d,
      last_price: ms.last_price,
      missing_days: ms.missing_days,
      companyName: meta?.companyName,
      sector: meta?.sector,
      market_cap: meta?.marketCap,
      exchange: meta?.exchange,
      is_etf: meta?.isEtf,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    candidates_fetched: candidates.length,
    candidates_scored,
    candidates_passed,
    duration_ms: Date.now() - started,
    results: scored,
  };
}

export async function handleWatchlistQuery(
  wdb: Database.Database,
  args: z.infer<typeof watchlistQueryArgs>,
): Promise<{ entries: ReturnType<typeof queryWatchlist> }> {
  const parsed = watchlistQueryArgs.parse(args);
  const entries = queryWatchlist(wdb, {
    fund: parsed.fund,
    status: parsed.status,
    screen: parsed.screen,
    ticker: parsed.ticker,
    limit: parsed.limit,
  });
  return { entries };
}

export async function handleWatchlistTrajectory(
  wdb: Database.Database,
  args: { ticker: string },
) {
  return getTrajectory(wdb, args.ticker);
}

export async function handleWatchlistTag(
  wdb: Database.Database,
  args: { ticker: string; status: string; reason: string },
) {
  const status = watchlistStatusSchema.parse(args.status);
  tagManually(wdb, args.ticker, status, `manual:mcp:${args.reason}`, Date.now());
  return { ok: true };
}

async function main() {
  const wdb = openWatchlistDb();
  const pcdb = openPriceCache();
  const config = await loadGlobalConfig();
  const apiKey = config.market_data?.fmp_api_key ?? "";

  const server = new McpServer(
    { name: "screener", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "screen_run",
    "Run a screen for a specific fund using its configured universe. Updates watchlist with scores and transitions. Defaults to the first active fund if not specified.",
    { screen: z.string().optional(), fund: z.string().optional() },
    async (args) => {
      const res = await handleScreenRun(wdb, pcdb, args, {
        fetchBars: (ticker) => getHistoricalDaily(ticker, 273, apiKey),
        resolveFundUniverse: async (fundName) => {
          const configs = await loadAllFundConfigs();
          const cfg = configs.find((c) => c.fund.name === fundName);
          if (!cfg) throw new Error(`fund not found: ${fundName}`);
          return resolveUniverse(fundName, cfg.universe, apiKey);
        },
        loadFundConfigs: loadAllFundConfigs,
        now: () => Date.now(),
        getSector: async (ticker) => {
          const profile = await getCompanyProfile(ticker, apiKey);
          return profile?.sector ?? null;
        },
      });
      return {
        content: [{ type: "text", text: JSON.stringify(res.summary, null, 2) }],
      };
    },
  );

  server.tool(
    "screen_discover",
    "Discover assets using arbitrary FMP screener filters and score them with momentum-12-1. Results are ephemeral — not written to the watchlist. Use watchlist_tag to persist any ticker worth tracking.",
    {
      filters: fmpScreenerFiltersSchema,
      screen: z.string().optional(),
    },
    async (args) => {
      const res = await handleScreenDiscover(pcdb, args as { filters: FmpScreenerFilters; screen?: string }, {
        fetchCandidates: (filters) => getScreenerResultsRaw(filters, apiKey),
        fetchBars: (ticker) => getHistoricalDaily(ticker, 273, apiKey),
        now: () => Date.now(),
      });
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.tool(
    "watchlist_query",
    "Query current watchlist. Filter by fund, status, screen, or ticker.",
    {
      fund: z.string().optional(),
      status: z.array(watchlistStatusSchema).optional(),
      screen: screenNameSchema.optional(),
      ticker: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async (args) => {
      const res = await handleWatchlistQuery(
        wdb,
        args as z.infer<typeof watchlistQueryArgs>,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(res.entries, null, 2) }],
      };
    },
  );

  server.tool(
    "watchlist_trajectory",
    "Return full score history and status transitions for one ticker.",
    { ticker: z.string() },
    async (args) => {
      const res = await handleWatchlistTrajectory(wdb, args);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.tool(
    "watchlist_tag",
    "Manually override a ticker's watchlist status. Reason is recorded.",
    {
      ticker: z.string(),
      status: watchlistStatusSchema,
      reason: z.string(),
    },
    async (args) => {
      const res = await handleWatchlistTag(wdb, args);
      return { content: [{ type: "text", text: JSON.stringify(res) }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[screener] fatal:", err);
    process.exit(1);
  });
}
