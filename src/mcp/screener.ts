#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import yaml from "js-yaml";
import {
  openWatchlistDb,
  queryWatchlist,
  getTrajectory,
  tagManually,
} from "../services/watchlist.service.js";
import { openPriceCache } from "../services/price-cache.service.js";
import {
  getHistoricalDaily,
  getSp500Constituents,
} from "../services/market.service.js";
import { runScreen } from "../services/screening.service.js";
import {
  fundConfigSchema,
  screenNameSchema,
  watchlistStatusSchema,
  type FundConfig,
} from "../types.js";
import { FUNDS_DIR } from "../paths.js";
import { loadGlobalConfig } from "../config.js";

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
  args: { screen?: string; universe?: string },
  deps: {
    fetchBars: (ticker: string) => Promise<Awaited<ReturnType<typeof getHistoricalDaily>>>;
    universeTickers: () => Promise<string[]>;
    loadFundConfigs: () => Promise<FundConfig[]>;
    now: () => number;
  },
): Promise<{ summary: Awaited<ReturnType<typeof runScreen>> }> {
  const screen = screenNameSchema.parse(args.screen ?? "momentum-12-1");
  const universeLabel = args.universe ?? "sp500";
  const universe = await deps.universeTickers();
  const fundConfigs = await deps.loadFundConfigs();
  const summary = await runScreen({
    watchlistDb: wdb,
    priceCacheDb: pcdb,
    universe,
    universeLabel,
    fetchBars: deps.fetchBars,
    fundConfigs,
    now: deps.now(),
    screenName: screen,
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

async function loadAllFundConfigs(): Promise<FundConfig[]> {
  try {
    const dirs = readdirSync(FUNDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const out: FundConfig[] = [];
    for (const name of dirs) {
      try {
        const raw = await readFile(
          `${FUNDS_DIR}/${name}/fund_config.yaml`,
          "utf-8",
        );
        out.push(fundConfigSchema.parse(yaml.load(raw)));
      } catch {
        // skip malformed
      }
    }
    return out;
  } catch {
    return [];
  }
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
    "Run a screen across the workspace universe. Updates watchlist with new scores and transitions.",
    { screen: z.string().optional(), universe: z.string().optional() },
    async (args) => {
      const res = await handleScreenRun(wdb, pcdb, args, {
        fetchBars: (ticker) => getHistoricalDaily(ticker, 273, apiKey),
        universeTickers: () => getSp500Constituents(apiKey),
        loadFundConfigs: loadAllFundConfigs,
        now: () => Date.now(),
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
