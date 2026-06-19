import { z } from "zod";
import {
  FMP_EXCHANGES_ALL,
  FMP_SECTORS,
  UNIVERSE_PRESETS,
} from "./constants/fmp-enums.js";

// ── Objective Schemas ──────────────────────────────────────────

const runwayObjectiveSchema = z.object({
  type: z.literal("runway"),
  target_months: z.number().positive(),
  monthly_burn: z.number().positive(),
  min_reserve_months: z.number().nonnegative().default(3),
});

const growthObjectiveSchema = z.object({
  type: z.literal("growth"),
  target_multiple: z.number().positive().optional(),
  target_amount: z.number().positive().optional(),
  timeframe_months: z.number().positive().optional(),
});

const accumulationObjectiveSchema = z.object({
  type: z.literal("accumulation"),
  target_asset: z.string(),
  target_amount: z.number().positive(),
  deadline: z.string().optional(),
});

const incomeObjectiveSchema = z.object({
  type: z.literal("income"),
  target_monthly_income: z.number().positive(),
  income_assets: z.array(z.string()).optional(),
});

const customObjectiveSchema = z.object({
  type: z.literal("custom"),
  description: z.string(),
  success_criteria: z.string().optional(),
  constraints: z.string().optional(),
});

export const objectiveSchema = z.discriminatedUnion("type", [
  runwayObjectiveSchema,
  growthObjectiveSchema,
  accumulationObjectiveSchema,
  incomeObjectiveSchema,
  customObjectiveSchema,
]);

// ── Risk Schema ────────────────────────────────────────────────

export const riskSchema = z.object({
  profile: z.enum(["conservative", "moderate", "aggressive", "custom"]),
  max_drawdown_pct: z.number().positive().default(15),
  max_position_pct: z.number().positive().default(25),
  max_leverage: z.number().nonnegative().default(1),
  stop_loss_pct: z.number().positive().default(8),
  max_daily_loss_pct: z.number().positive().default(5),
  correlation_limit: z.number().min(0).max(1).default(0.8),
  custom_rules: z.array(z.string()).default([]),
});

// ── Universe Schema ────────────────────────────────────────────

export const universePresetSchema = z.enum(UNIVERSE_PRESETS);
export type UniversePreset = z.infer<typeof universePresetSchema>;

export const fmpExchangeSchema = z.enum(FMP_EXCHANGES_ALL);
export const fmpSectorSchema = z.enum(FMP_SECTORS);

export const fmpScreenerFiltersSchema = z
  .object({
    market_cap_min: z.number().nonnegative().optional(),
    market_cap_max: z.number().positive().optional(),
    price_min: z.number().nonnegative().optional(),
    price_max: z.number().positive().optional(),
    beta_min: z.number().optional(),
    beta_max: z.number().optional(),
    dividend_min: z.number().nonnegative().optional(),
    dividend_max: z.number().nonnegative().optional(),
    volume_min: z.number().nonnegative().optional(),
    volume_max: z.number().positive().optional(),
    sector: z.array(fmpSectorSchema).optional(),
    industry: z.string().optional(),
    exchange: z.array(fmpExchangeSchema).optional(),
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    is_etf: z.boolean().optional(),
    is_fund: z.boolean().optional(),
    is_actively_trading: z.boolean().default(true),
    include_all_share_classes: z.boolean().optional(),
    limit: z.number().int().min(1).max(10_000).default(500),
  })
  .refine(
    (f) => !(f.market_cap_min != null && f.market_cap_max != null) || f.market_cap_min < f.market_cap_max,
    { message: "market_cap_min must be < market_cap_max" },
  )
  .refine(
    (f) => !(f.price_min != null && f.price_max != null) || f.price_min < f.price_max,
    { message: "price_min must be < price_max" },
  )
  .refine(
    (f) => !(f.beta_min != null && f.beta_max != null) || f.beta_min < f.beta_max,
    { message: "beta_min must be < beta_max" },
  )
  .refine(
    (f) => !(f.dividend_min != null && f.dividend_max != null) || f.dividend_min < f.dividend_max,
    { message: "dividend_min must be < dividend_max" },
  )
  .refine(
    (f) => !(f.volume_min != null && f.volume_max != null) || f.volume_min < f.volume_max,
    { message: "volume_min must be < volume_max" },
  );

export type FmpScreenerFilters = z.infer<typeof fmpScreenerFiltersSchema>;

export const universeSchema = z
  .object({
    preset: universePresetSchema.optional(),
    filters: fmpScreenerFiltersSchema.optional(),
    include_tickers: z.array(z.string().transform((s) => s.toUpperCase())).default([]),
    exclude_tickers: z.array(z.string().transform((s) => s.toUpperCase())).default([]),
    exclude_sectors: z.array(fmpSectorSchema).default([]),
  })
  .refine(
    (u) => (u.preset != null) !== (u.filters != null),
    { message: "universe must have exactly one of `preset` or `filters`" },
  );

export type Universe = z.infer<typeof universeSchema>;

// ── Schedule Schema ────────────────────────────────────────────

const sessionScheduleSchema = z.object({
  time: z.string(),
  enabled: z.boolean().default(true),
  focus: z.string(),
  max_duration_minutes: z.number().positive().default(60),
});

const specialSessionSchema = z.object({
  trigger: z.string(),
  time: z.string(),
  focus: z.string(),
  enabled: z.boolean().default(true),
  max_duration_minutes: z.number().positive().default(60),
});

export const scheduleSchema = z.object({
  timezone: z.string().default("UTC"),
  trading_days: z
    .array(z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]))
    .default(["MON", "TUE", "WED", "THU", "FRI"]),
  sessions: z.record(z.string(), sessionScheduleSchema).default({}),
  special_sessions: z.array(specialSessionSchema).default([]),
});

// ── Budget Schema ──────────────────────────────────────────────

export const budgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxUsd: z.number().positive(),
});

export type Budget = z.infer<typeof budgetSchema>;

export const fundBudgetConfigSchema = z
  .object({
    default: budgetSchema.optional(),
    perSessionType: z.record(z.string(), budgetSchema).optional(),
    /** Daily aggregate USD cap per fund. When the sum of cost_usd across
     *  today's sessions reaches this value, further sessions are skipped
     *  with status "skipped_daily_cap" until 00:00 UTC. */
    dailyCapUsd: z.number().positive().optional(),
  })
  .optional();

export type FundBudgetConfig = z.infer<typeof fundBudgetConfigSchema>;

// ── Fund Config Schema ─────────────────────────────────────────

export const fundConfigSchema = z.object({
  fund: z.object({
    name: z.string(),
    display_name: z.string(),
    description: z.string().default(""),
    created: z.string(),
    status: z.enum(["active", "paused", "closed"]).default("active"),
  }),
  capital: z.object({
    initial: z.number().positive(),
    currency: z.string().default("USD"),
  }),
  objective: objectiveSchema,
  risk: riskSchema,
  universe: universeSchema,
  schedule: scheduleSchema,
  broker: z.object({
    mode: z.literal("paper").default("paper"),
  }).passthrough(),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      quiet_hours: z
        .object({
          enabled: z.boolean().default(true),
          start: z.string().default("23:00"),
          end: z.string().default("07:00"),
          allow_critical: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),
  claude: z
    .object({
      model: z.string().default("claude-opus-4-8"),
      personality: z.string().default(""),
      decision_framework: z.string().default(""),
    })
    .default({}),
  budget: fundBudgetConfigSchema,
}).strip();

export type FundConfig = z.infer<typeof fundConfigSchema>;
export type Objective = z.infer<typeof objectiveSchema>;
export type Risk = z.infer<typeof riskSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;

// ── News Sources Schemas ─────────────────────────────────────

export const newsFeedSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  category: z.string().default("market"),
});

export type NewsFeed = z.infer<typeof newsFeedSchema>;

const DEFAULT_NEWS_FEEDS: z.infer<typeof newsFeedSchema>[] = [
  { name: "Bloomberg", url: "https://feeds.bloomberg.com/markets/news.rss", category: "macro" },
  { name: "Reuters", url: "https://news.google.com/rss/search?q=reuters+finance&hl=en-US", category: "macro" },
  { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", category: "market" },
  { name: "MarketWatch", url: "https://feeds.marketwatch.com/marketwatch/topstories", category: "market" },
];

export const newsConfigSchema = z.object({
  feeds: z.array(newsFeedSchema).default(DEFAULT_NEWS_FEEDS),
  fetch_interval_minutes: z.number().positive().default(5),
  max_articles_per_feed: z.number().positive().default(20),
  retention_days: z.number().positive().default(7),
});

export type NewsConfig = z.infer<typeof newsConfigSchema>;

export const newsArticleSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  category: z.string(),
  url: z.string(),
  published_at: z.string(),
  fetched_at: z.string(),
  symbols: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  alerted: z.boolean().default(false),
});

export type NewsArticle = z.infer<typeof newsArticleSchema>;

// ── Global Config Schema ───────────────────────────────────────

export const globalConfigSchema = z.object({
  default_model: z.string().default("claude-opus-4-8"),
  max_budget_usd: z.number().positive().optional(),
  timezone: z.string().default("UTC"),
  broker: z
    .object({})
    .passthrough()
    .default({}),
  notifications: z
    .object({
      enabled: z.boolean().default(true),
      quiet_hours: z
        .object({
          enabled: z.boolean().default(true),
          start: z.string().default("23:00"),
          end: z.string().default("07:00"),
          allow_critical: z.boolean().default(true),
        })
        .default({}),
    })
    .default({}),
  market_data: z
    .object({
      provider: z.enum(["fmp", "yfinance"]).default("fmp"),
      fmp_api_key: z.string().optional(),
    })
    .default({}),
  sws: z
    .object({
      auth_token: z.string().optional(),
      token_expires_at: z.string().optional(),
    })
    .optional(),
  news: newsConfigSchema.optional(),
  daemon: z
    .object({
      tick_interval_ms: z.number().int().positive().optional(),
      /** Hard cap on concurrent Claude SDK sessions launched by the daemon.
       *  Default 3. Lower this on rate-limited plans; raise it (with care) on
       *  hosts with plenty of memory and a higher Claude/FMP quota. */
      max_concurrent_sessions: z.number().int().positive().optional(),
    })
    .optional(),
  budget: fundBudgetConfigSchema,
}).strip();

export type GlobalConfig = z.infer<typeof globalConfigSchema>;

// ── State Schemas ──────────────────────────────────────────────

const positionSchema = z.object({
  symbol: z.string(),
  shares: z.number(),
  avg_cost: z.number(),
  current_price: z.number(),
  market_value: z.number(),
  unrealized_pnl: z.number(),
  unrealized_pnl_pct: z.number(),
  weight_pct: z.number(),
  stop_loss: z.number().optional(),
  entry_date: z.string(),
  entry_reason: z.string().default(""),
});

export const portfolioSchema = z.object({
  last_updated: z.string(),
  cash: z.number(),
  total_value: z.number(),
  positions: z.array(positionSchema).default([]),
});

export type Portfolio = z.infer<typeof portfolioSchema>;

export const objectiveTrackerSchema = z.object({
  type: z.string(),
  initial_capital: z.number(),
  current_value: z.number(),
  progress_pct: z.number(),
  status: z.enum(["on_track", "behind", "ahead", "completed"]),
});

export type ObjectiveTracker = z.infer<typeof objectiveTrackerSchema>;

export const dailySnapshotSchema = z.object({
  date: z.string(),
  total_value: z.number(),
});

export type DailySnapshot = z.infer<typeof dailySnapshotSchema>;

export const notifiedMilestonesSchema = z.object({
  thresholds_notified: z.array(z.number()).default([]),
  peak_value: z.number().default(0),
  drawdown_thresholds_notified: z.array(z.number()).default([]),
  last_checked: z.string().default(""),
});

export type NotifiedMilestones = z.infer<typeof notifiedMilestonesSchema>;

export const sessionLogSchema = z.object({
  fund: z.string(),
  session_type: z.string(),
  started_at: z.string(),
  ended_at: z.string().optional(),
  trades_executed: z.number().default(0),
  analysis_file: z.string().optional(),
  summary: z.string().default(""),
});

export type SessionLog = z.infer<typeof sessionLogSchema>;

// ── Trade Journal Schemas ─────────────────────────────────────

export const tradeRecordSchema = z.object({
  id: z.number().optional(),
  timestamp: z.string(),
  fund: z.string(),
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().positive(),
  price: z.number().positive(),
  total_value: z.number(),
  order_type: z.enum(["market", "limit", "stop", "stop_limit", "trailing_stop"]),
  session_type: z.string().optional(),
  reasoning: z.string().optional(),
  analysis_ref: z.string().optional(),
  closed_at: z.string().optional(),
  close_price: z.number().optional(),
  pnl: z.number().optional(),
  pnl_pct: z.number().optional(),
  lessons_learned: z.string().optional(),
  market_context: z.string().optional(),
});

export type TradeRecord = z.infer<typeof tradeRecordSchema>;

// ── Phase 4: Trade Similarity Search Schema ─────────────────

export const similarTradeResultSchema = z.object({
  trade_id: z.number(),
  symbol: z.string(),
  side: z.enum(["buy", "sell"]),
  timestamp: z.string(),
  reasoning: z.string().optional(),
  market_context: z.string().optional(),
  lessons_learned: z.string().optional(),
  pnl: z.number().optional(),
  pnl_pct: z.number().optional(),
  rank: z.number(),
  score: z.number(),
});

export type SimilarTradeResult = z.infer<typeof similarTradeResultSchema>;

// ── Phase 5: Special Sessions Schema ─────────────────────────

export const specialSessionTriggerSchema = z.object({
  trigger: z.string(),
  time: z.string(),
  focus: z.string(),
  enabled: z.boolean().default(true),
  max_duration_minutes: z.number().positive().default(60),
});

export type SpecialSessionTrigger = z.infer<typeof specialSessionTriggerSchema>;

// ── Phase 5: Fund Template Schema ────────────────────────────

export const fundTemplateSchema = z.object({
  template_name: z.string(),
  template_version: z.string().default("1.0"),
  description: z.string().default(""),
  created: z.string(),
  source_fund: z.string().optional(),
  config: fundConfigSchema,
});

export type FundTemplate = z.infer<typeof fundTemplateSchema>;

// ── Phase 5: Correlation Schema ──────────────────────────────

export const correlationEntrySchema = z.object({
  fund_a: z.string(),
  fund_b: z.string(),
  correlation: z.number().min(-1).max(1),
  period_days: z.number(),
  computed_at: z.string(),
  overlapping_symbols: z.array(z.string()).default([]),
  warning: z.string().optional(),
});

export type CorrelationEntry = z.infer<typeof correlationEntrySchema>;

// ── Phase 5: Monte Carlo Projection Schema ───────────────────

export const monteCarloResultSchema = z.object({
  fund: z.string(),
  simulations: z.number(),
  horizon_months: z.number(),
  computed_at: z.string(),
  percentiles: z.object({
    p5: z.number(),
    p10: z.number(),
    p25: z.number(),
    p50: z.number(),
    p75: z.number(),
    p90: z.number(),
    p95: z.number(),
  }),
  runway_months: z
    .object({
      p5: z.number(),
      p25: z.number(),
      p50: z.number(),
      p75: z.number(),
      p95: z.number(),
    })
    .optional(),
  probability_of_ruin: z.number().min(0).max(1),
  mean_final_value: z.number(),
  std_final_value: z.number(),
  monthly_return_mean: z.number(),
  monthly_return_std: z.number(),
});

export type MonteCarloResult = z.infer<typeof monteCarloResultSchema>;

// ── Dashboard Market Data Schemas ────────────────────────────

export const marketIndexSnapshotSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  price: z.number(),
  change: z.number(),
  changePct: z.number(),
  sparklineValues: z.array(z.number()).default([]),
});

export type MarketIndexSnapshot = z.infer<typeof marketIndexSnapshotSchema>;

export const newsHeadlineSchema = z.object({
  id: z.string(),
  headline: z.string(),
  source: z.string(),
  timestamp: z.string(),
  symbols: z.array(z.string()).default([]),
  url: z.string().optional(),
});

export type NewsHeadline = z.infer<typeof newsHeadlineSchema>;

export const sectorSnapshotSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  changePct: z.number(),
});

export type SectorSnapshot = z.infer<typeof sectorSnapshotSchema>;

export const dashboardMarketDataSchema = z.object({
  indices: z.array(marketIndexSnapshotSchema).default([]),
  news: z.array(newsHeadlineSchema).default([]),
  sectors: z.array(sectorSnapshotSchema).default([]),
  marketOpen: z.boolean().default(false),
  fetchedAt: z.string(),
});

export type DashboardMarketData = z.infer<typeof dashboardMarketDataSchema>;

export const serviceStatusSchema = z.object({
  daemon: z.boolean().default(false),
  marketData: z.boolean().default(false),
  marketDataProvider: z.enum(["fmp", "yfinance", "none"]).default("none"),
});

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const nextCronInfoSchema = z.object({
  fundName: z.string(),
  sessionType: z.string(),
  time: z.string(),
  minutesUntil: z.number(),
});

export type NextCronInfo = z.infer<typeof nextCronInfoSchema>;

// ── Chat History Schema ──────────────────────────────────────

export const chatMessageRecordSchema = z.object({
  id: z.number(),
  sender: z.enum(["you", "claude", "system"]),
  content: z.string(),
  timestamp: z.string().datetime(),
  cost: z.number().optional(),
  turns: z.number().optional(),
});

// Schema for messages written to disk — excludes ephemeral system messages
const persistedChatMessageSchema = chatMessageRecordSchema.extend({
  sender: z.enum(["you", "claude"]),
});

export const chatHistorySchema = z.object({
  session_id: z.string().min(1),
  messages: z.array(persistedChatMessageSchema),
  updated_at: z.string().datetime(),
});

export type ChatMessageRecord = z.infer<typeof chatMessageRecordSchema>;
export type ChatHistory = z.infer<typeof chatHistorySchema>;

// ── Active Session Schema ────────────────────────────────────

export const activeSessionSchema = z.object({
  session_id: z.string().min(1),
  updated_at: z.string().datetime(),
  source: z.enum(["chat", "daemon"]),
});

export type ActiveSession = z.infer<typeof activeSessionSchema>;

// ── Phase 6: Agent SDK Schemas ──────────────────────────────

/** Extended session log with SDK cost/token metadata */
export const sessionLogV2Schema = sessionLogSchema.extend({
  cost_usd: z.number().optional(),
  tokens_in: z.number().optional(),
  tokens_out: z.number().optional(),
  model_used: z.string().optional(),
  num_turns: z.number().optional(),
  session_id: z.string().optional(),
  status: z
    .enum(["success", "error_max_turns", "error_max_budget", "error", "timeout", "skipped_daily_cap", "watchdog_killed"])
    .optional(),
  budget_resolved: budgetSchema.optional(),
  handoff_written: z.boolean().optional(),
});

export type SessionLogV2 = z.infer<typeof sessionLogV2Schema>;

// ── SWS (Simply Wall St) Schemas ──────────────────────────────

export const swsSnowflakeSchema = z.object({
  value: z.number(),
  future: z.number(),
  health: z.number(),
  past: z.number(),
  dividend: z.number(),
});

export type SwsSnowflake = z.infer<typeof swsSnowflakeSchema>;

export const swsCompanySchema = z.object({
  id: z.number(),
  name: z.string(),
  tickerSymbol: z.string(),
  uniqueSymbol: z.string(),
  exchangeSymbol: z.string(),
  score: swsSnowflakeSchema,
  primaryIndustry: z.object({
    id: z.number(),
    name: z.string(),
    slug: z.string(),
  }),
  analysisValue: z
    .object({
      return1d: z.number().nullable().optional(),
      return7d: z.number().nullable().optional(),
      return1yAbs: z.number().nullable().optional(),
      marketCap: z.number().nullable().optional(),
      lastSharePrice: z.number().nullable().optional(),
      priceTarget: z.number().nullable().optional(),
      pe: z.number().nullable().optional(),
      pb: z.number().nullable().optional(),
      priceToSales: z.number().nullable().optional(),
    })
    .optional(),
  analysisFuture: z
    .object({
      netIncomeGrowth3Y: z.number().nullable().optional(),
      netIncomeGrowthAnnual: z.number().nullable().optional(),
      revenueGrowthAnnual: z.number().nullable().optional(),
    })
    .optional(),
  analysisDividend: z
    .object({
      dividendYield: z.number().nullable().optional(),
    })
    .optional(),
  analysisMisc: z
    .object({
      analystCount: z.number().nullable().optional(),
    })
    .optional(),
  info: z
    .object({
      shortDescription: z.string().nullable().optional(),
      logoUrl: z.string().nullable().optional(),
      yearFounded: z.number().nullable().optional(),
    })
    .optional(),
});

export type SwsCompany = z.infer<typeof swsCompanySchema>;

export const swsScreenerResultSchema = z.object({
  totalHits: z.number(),
  companies: z.array(swsCompanySchema).default([]),
});

export type SwsScreenerResult = z.infer<typeof swsScreenerResultSchema>;

export const swsSearchResultSchema = z.object({
  id: z.number(),
  name: z.string(),
  tickerSymbol: z.string(),
  uniqueSymbol: z.string(),
  exchangeSymbol: z.string(),
  score: swsSnowflakeSchema.optional(),
});

export type SwsSearchResult = z.infer<typeof swsSearchResultSchema>;

// ── Daemon Resilience Schemas ────────────────────────────────

export const sessionHistorySchema = z.record(z.string(), z.string());
export type SessionHistory = z.infer<typeof sessionHistorySchema>;

export const daemonPidInfoSchema = z.object({
  pid: z.number(),
  startedAt: z.string(),
  version: z.string(),
});
export type DaemonPidInfo = z.infer<typeof daemonPidInfoSchema>;

// ── Proactive Agent Schemas ──────────────────────────────────

export const pendingSessionSchema = z.object({
  id: z.string(),
  type: z.enum(["news_reaction", "agent_followup"]),
  focus: z.string(),
  scheduled_at: z.string(),
  created_at: z.string(),
  source: z.enum(["news", "agent"]),
  max_turns: z.number().positive().max(25).default(10),
  max_duration_minutes: z.number().positive().max(60).default(5),
  priority: z.enum(["high", "normal"]).default("normal"),
});

export type PendingSession = z.infer<typeof pendingSessionSchema>;

// ── Verdict Persistence (pre-trade gate, 24h TTL) ─────────────

export const persistedVerdictSchema = z.object({
  ticker: z.string(),
  side: z.enum(["buy", "sell"]),
  source: z.enum(["trade-evaluator", "risk-guardian"]),
  recommendation: z.enum(["PROCEED", "RECONSIDER", "REJECT", "APPROVED", "REJECTED"]),
  approved: z.boolean(),
  observedAt: z.number(),
});

export type PersistedVerdict = z.infer<typeof persistedVerdictSchema>;

// ── Quota Backoff (workspace-level, subscription usage exhaustion) ──

export const quotaBackoffSchema = z.object({ last_quota_error_at: z.string() });
export type QuotaBackoffState = z.infer<typeof quotaBackoffSchema>;

export const sessionCountsSchema = z.object({
  date: z.string(),
  agent: z.number().default(0),
  news: z.number().default(0),
  last_agent_at: z.string().optional(),
  last_news_at: z.string().optional(),
});

export type SessionCounts = z.infer<typeof sessionCountsSchema>;

// ─────────── Screening / watchlist ───────────

export const screenNameSchema = z.enum(["momentum-12-1"]);
export type ScreenName = z.infer<typeof screenNameSchema>;

export const watchlistStatusSchema = z.enum([
  "candidate",
  "watching",
  "fading",
  "stale",
  "rejected",
]);
export type WatchlistStatus = z.infer<typeof watchlistStatusSchema>;

export const dailyBarSchema = z.object({
  date: z.string(),
  close: z.number(),
  volume: z.number(),
});
export type DailyBar = z.infer<typeof dailyBarSchema>;

export const scoreMetadataSchema = z.object({
  return_12_1: z.number(),
  adv_usd_30d: z.number(),
  last_price: z.number(),
  missing_days: z.number(),
});
export type ScoreMetadata = z.infer<typeof scoreMetadataSchema>;

export const screenRunSchema = z.object({
  id: z.number().int().positive(),
  screen_name: screenNameSchema,
  universe: z.string(),
  ran_at: z.number().int().positive(),
  tickers_scored: z.number().int().nonnegative(),
  tickers_passed: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  parameters_json: z.string(),
});
export type ScreenRun = z.infer<typeof screenRunSchema>;

export const scoreRowSchema = z.object({
  id: z.number().int().positive(),
  run_id: z.number().int().positive(),
  ticker: z.string(),
  screen_name: screenNameSchema,
  score: z.number(),
  passed: z.boolean(),
  metadata: scoreMetadataSchema,
  scored_at: z.number().int().positive(),
});
export type ScoreRow = z.infer<typeof scoreRowSchema>;

export const watchlistEntrySchema = z.object({
  ticker: z.string(),
  status: watchlistStatusSchema,
  first_surfaced_at: z.number().int().positive(),
  last_evaluated_at: z.number().int().positive(),
  current_screens: z.array(screenNameSchema),
  peak_score: z.number().nullable(),
  peak_score_at: z.number().int().nullable(),
  notes: z.string().nullable(),
});
export type WatchlistEntry = z.infer<typeof watchlistEntrySchema>;

export const statusTransitionSchema = z.object({
  id: z.number().int().positive(),
  ticker: z.string(),
  from_status: watchlistStatusSchema.nullable(),
  to_status: watchlistStatusSchema,
  reason: z.string(),
  transitioned_at: z.number().int().positive(),
});
export type StatusTransition = z.infer<typeof statusTransitionSchema>;

export const watchlistFundTagSchema = z.object({
  ticker: z.string(),
  fund_name: z.string(),
  compatible: z.boolean(),
  tagged_at: z.number().int().positive(),
});
export type WatchlistFundTag = z.infer<typeof watchlistFundTagSchema>;

// ── Universe Resolution Schema ────────────────────────────────

export const universeResolutionSchema = z.object({
  resolved_at: z.number().int().positive(),
  config_hash: z.string(),
  resolved_from: z.enum(["fmp", "stale_cache", "static_fallback"]),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("preset"), preset: universePresetSchema }),
    z.object({ kind: z.literal("filters") }),
  ]),
  base_tickers: z.array(z.string()),
  final_tickers: z.array(z.string()),
  include_applied: z.array(z.string()),
  exclude_tickers_applied: z.array(z.string()),
  exclude_sectors_applied: z.array(z.string()),
  exclude_tickers_config: z.array(z.string()),
  exclude_sectors_config: z.array(z.string()),
  count: z.number().int().nonnegative(),
});
export type UniverseResolution = z.infer<typeof universeResolutionSchema>;

// ── screen_discover ───────────────────────────────────────────────────────────

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

// ── Eval harness schemas ──────────────────────────────────────────

export const evalFundStateSchema = z.object({
  base: z.string().optional(),
  fund_config: z.object({
    objective: z.enum(["runway", "growth", "accumulation", "income", "custom"]).optional(),
    risk_profile: z.enum(["conservative", "moderate", "aggressive"]).optional(),
    initial_capital: z.number().positive().optional(),
  }).default({}),
  portfolio: z.object({
    cash: z.number().nonnegative(),
    positions: z.array(z.object({
      symbol: z.string(),
      shares: z.number().positive(),
      avg_cost: z.number().positive(),
      current_price: z.number().positive(),
      entry_reason: z.string().default("seeded for eval"),
    })).default([]),
  }),
  tracker: z.object({
    progress_pct: z.number().default(0),
    status: z.enum(["on_track", "at_risk", "behind"]).default("on_track"),
  }).default({}),
  watchlist: z.array(z.object({
    ticker: z.string(),
    status: z.enum(["candidate", "watching", "fading", "rejected"]),
    peak_score: z.number().nullable().default(null),
    screens: z.array(z.string()).default(["momentum-12-1"]),
    first_surfaced_days_ago: z.number().int().nonnegative().default(7),
  })).default([]),
  /** Current session-handoff.md content. Seeded to state/session-handoff.md so
   *  the autonomous state_snapshot envelope carries it into the session (and the
   *  chat freshness line reflects it). Used by surface=autonomous to reproduce
   *  inherited-context behavior (e.g. an accumulated entry-gate framework). */
  handoff_current: z.string().optional(),
  /** Archived handoff files to seed into state/handoffs/ for meta_reflection evals. */
  handoffs: z.array(z.object({
    /** ISO timestamp used to derive the archive filename and mtime. */
    timestamp: z.string(),
    /** Session type label embedded in the filename (e.g. "pre_market"). */
    session_type: z.string(),
    /** Full markdown content of the handoff. */
    content: z.string(),
  })).default([]),
  /** Closed trade rows to seed into the trade journal for meta_reflection evals. */
  journal: z.array(z.object({
    symbol: z.string(),
    /** "buy" or "sell" */
    side: z.string(),
    timestamp: z.string(),
    closed_at: z.string().optional(),
    price: z.number(),
    close_price: z.number().optional(),
    pnl_pct: z.number().optional(),
    reasoning: z.string().default(""),
    lessons_learned: z.string().default(""),
  })).default([]),
});
export type EvalFundState = z.infer<typeof evalFundStateSchema>;

// ── LLM-judge schemas (Phase 3b) ────────────────────────────────

export const judgeDimSchema = z.enum([
  "data_grounding",
  "task_completion",
  // meta_reflection judge dims
  "specificity",
  "non_duplication",
  "routing",
  "format",
  "restraint",
  // autonomous decision-quality dim
  "decision_discipline",
]);
export type JudgeDim = z.infer<typeof judgeDimSchema>;

export const judgeConfigSchema = z.object({
  /** Per-dimension threshold (1-5). A run passes the judge if every declared
   *  dimension scores >= its threshold. */
  dims: z.record(judgeDimSchema, z.number().int().min(1).max(5)),
});
export type JudgeConfig = z.infer<typeof judgeConfigSchema>;

export const judgeResultSchema = z.object({
  scores: z.record(judgeDimSchema, z.number().int().min(1).max(5)),
  /** One-sentence justification per dim, from the judge. */
  rationale: z.record(judgeDimSchema, z.string()),
  /** Cost of the judge call itself (USD), tracked separately from run cost. */
  judge_cost_usd: z.number().min(0),
});
export type JudgeResult = z.infer<typeof judgeResultSchema>;

export const evalAssertionsSchema = z.object({
  must_invoke: z.array(z.string()).default([]),
  must_not_invoke: z.array(z.string()).default([]),
  max_turns: z.number().int().positive().optional(),
  max_tokens_out: z.number().int().positive().optional(),
  judge: judgeConfigSchema.optional(),
});
export type EvalAssertions = z.infer<typeof evalAssertionsSchema>;

export const evalCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be lowercase kebab-case"),
  description: z.string(),
  /** User prompt to send. Optional only for surface=meta_reflection which has
   *  no interactive user prompt — the session is driven by the prompt builder. */
  prompt: z.string().min(1).optional(),
  language: z.enum(["es", "en"]).default("es"),
  surface: z.enum(["chat", "ask", "meta_reflection", "autonomous"]).default("chat"),
  /** Session type to run for surface=autonomous (must exist in the seeded
   *  fund's schedule). Ignored for other surfaces. */
  autonomous_session_type: z.string().default("pre_market"),
  fund_state: evalFundStateSchema,
  expect: evalAssertionsSchema,
  runs: z.number().int().min(1).max(10).default(3),
  threshold: z.number().int().min(1).default(2),
}).refine((c) => c.threshold <= c.runs, { message: "threshold must be ≤ runs" })
  .refine(
    (c) =>
      c.surface === "meta_reflection" ||
      c.surface === "autonomous" ||
      (c.prompt !== undefined && c.prompt.length > 0),
    { message: "prompt is required for surface chat and ask" },
  );
export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalFailureSchema = z.object({
  type: z.enum(["must_invoke", "must_not_invoke", "max_turns", "max_tokens_out", "run_errored", "judge_below_threshold", "judge_invocation_error"]),
  detail: z.string(),
  expected: z.string(),
  actual: z.string(),
});
export type EvalFailure = z.infer<typeof evalFailureSchema>;

export const evalRunCaptureSchema = z.object({
  run_index: z.number().int().positive(),
  passed: z.boolean(),
  tool_history: z.array(z.object({
    name: z.string(),
    elapsed: z.number(),
  })),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  num_turns: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  final_response: z.string(),
  error: z.string().nullable(),
  failures: z.array(evalFailureSchema),
  judge: judgeResultSchema.optional(),
});
export type EvalRunCapture = z.infer<typeof evalRunCaptureSchema>;

export const evalCaseResultSchema = z.object({
  id: z.string(),
  description: z.string(),
  passed: z.boolean(),
  passing_runs: z.number().int().nonnegative(),
  total_runs: z.number().int().positive(),
  threshold: z.number().int().positive(),
  runs: z.array(evalRunCaptureSchema),
  total_duration_ms: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
  total_judge_cost_usd: z.number().nonnegative().optional(),
});
export type EvalCaseResult = z.infer<typeof evalCaseResultSchema>;

export const evalReportSchema = z.object({
  schema_version: z.literal(1),
  timestamp: z.string(),
  model: z.string(),
  total_cost_usd: z.number().nonnegative(),
  total_duration_ms: z.number().int().nonnegative(),
  summary: z.object({
    cases_passed: z.number().int().nonnegative(),
    cases_failed: z.number().int().nonnegative(),
    runs_passed: z.number().int().nonnegative(),
    runs_failed: z.number().int().nonnegative(),
  }),
  cases: z.array(evalCaseResultSchema),
  total_judge_cost_usd: z.number().nonnegative().optional(),
});
export type EvalReport = z.infer<typeof evalReportSchema>;

// ── Last Consolidation State (meta_reflection tracker) ─────────

export const lastConsolidationStateSchema = z.object({
  cursor_iso: z.string().datetime(),
  last_run_iso: z.string().datetime(),
  status: z.enum(["success", "no_data", "skipped_daily_cap", "error"]),
  n_handoffs_processed: z.number().int().min(0),
  n_journal_entries: z.number().int().min(0),
  n_lessons_written: z.number().int().min(0),
  cost_usd: z.number().min(0),
  error: z.string().optional(),
});

export type LastConsolidationState = z.infer<typeof lastConsolidationStateSchema>;
