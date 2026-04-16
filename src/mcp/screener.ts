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
import { getHistoricalDaily } from "../services/market.service.js";
import { resolveUniverse } from "../services/universe.service.js";
import { runScreen } from "../services/screening.service.js";
import { getCompanyProfile } from "../services/market.service.js";
import {
  screenNameSchema,
  watchlistStatusSchema,
  type FundConfig,
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
