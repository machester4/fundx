import { z } from "zod";

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

const assetEntrySchema = z.object({
  type: z.string(),
  tickers: z.array(z.string()).optional(),
  sectors: z.array(z.string()).optional(),
  strategies: z.array(z.string()).optional(),
  protocols: z.array(z.string()).optional(),
});

export const universeSchema = z.object({
  allowed: z.array(assetEntrySchema).default([]),
  forbidden: z.array(assetEntrySchema).default([]),
});

// ── Schedule Schema ────────────────────────────────────────────

const sessionScheduleSchema = z.object({
  time: z.string(),
  enabled: z.boolean().default(true),
  focus: z.string(),
  max_duration_minutes: z.number().positive().default(15),
});

const specialSessionSchema = z.object({
  trigger: z.string(),
  time: z.string(),
  focus: z.string(),
  enabled: z.boolean().default(true),
  max_duration_minutes: z.number().positive().default(15),
});

export const scheduleSchema = z.object({
  timezone: z.string().default("UTC"),
  trading_days: z
    .array(z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]))
    .default(["MON", "TUE", "WED", "THU", "FRI"]),
  sessions: z.record(z.string(), sessionScheduleSchema).default({}),
  special_sessions: z.array(specialSessionSchema).default([]),
});

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
    provider: z.enum(["alpaca", "ibkr", "binance", "manual"]).default("manual"),
    mode: z.enum(["paper", "live"]).default("paper"),
  }),
  notifications: z
    .object({
      telegram: z
        .object({
          enabled: z.boolean().default(false),
          trade_alerts: z.boolean().default(true),
          stop_loss_alerts: z.boolean().default(true),
          daily_digest: z.boolean().default(true),
          weekly_digest: z.boolean().default(true),
          milestone_alerts: z.boolean().default(true),
          drawdown_alerts: z.boolean().default(true),
        })
        .default({}),
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
      model: z.string().default("sonnet"),
      personality: z.string().default(""),
      decision_framework: z.string().default(""),
    })
    .default({}),
});

export type FundConfig = z.infer<typeof fundConfigSchema>;
export type Objective = z.infer<typeof objectiveSchema>;
export type Risk = z.infer<typeof riskSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;

// ── Global Config Schema ───────────────────────────────────────

export const globalConfigSchema = z.object({
  default_model: z.string().default("sonnet"),
  max_budget_usd: z.number().positive().optional(),
  timezone: z.string().default("UTC"),
  broker: z
    .object({
      provider: z.string().default("manual"),
      api_key: z.string().optional(),
      secret_key: z.string().optional(),
      mode: z.enum(["paper", "live"]).default("paper"),
    })
    .default({}),
  telegram: z
    .object({
      bot_token: z.string().optional(),
      chat_id: z.string().optional(),
      enabled: z.boolean().default(false),
    })
    .default({}),
  market_data: z
    .object({
      provider: z.enum(["fmp", "alpaca"]).default("fmp"),
      fmp_api_key: z.string().optional(),
    })
    .default({}),
});

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

// ── Telegram Notification Schemas ─────────────────────────────

export const notificationPrioritySchema = z.enum(["low", "normal", "critical"]);

export type NotificationPriority = z.infer<typeof notificationPrioritySchema>;

export const telegramNotificationSchema = z.object({
  fund: z.string().optional(),
  message: z.string(),
  priority: notificationPrioritySchema.default("normal"),
  parse_mode: z.enum(["HTML", "MarkdownV2", "Markdown"]).default("HTML"),
});

export type TelegramNotification = z.infer<typeof telegramNotificationSchema>;

// ── Phase 4: Sub-Agent Schemas ──────────────────────────────

export const subAgentTypeSchema = z.enum([
  "macro",
  "technical",
  "sentiment",
  "news",
  "risk",
  "custom",
]);

export type SubAgentType = z.infer<typeof subAgentTypeSchema>;

export const subAgentConfigSchema = z.object({
  type: subAgentTypeSchema,
  name: z.string(),
  prompt: z.string(),
  max_turns: z.number().positive().default(20),
  model: z.string().optional(),
});

export type SubAgentConfig = z.infer<typeof subAgentConfigSchema>;

export const subAgentResultSchema = z.object({
  type: subAgentTypeSchema,
  name: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
  status: z.enum(["success", "error", "timeout"]),
  output: z.string(),
  error: z.string().optional(),
});

export type SubAgentResult = z.infer<typeof subAgentResultSchema>;

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
  max_duration_minutes: z.number().positive().default(15),
});

export type SpecialSessionTrigger = z.infer<typeof specialSessionTriggerSchema>;

// ── Phase 5: Live Trading Safety Schema ──────────────────────

export const liveTradingConfirmationSchema = z.object({
  fund: z.string(),
  confirmed_at: z.string(),
  confirmed_by: z.enum(["cli", "telegram"]),
  previous_mode: z.enum(["paper", "live"]),
  new_mode: z.enum(["paper", "live"]),
  paper_trading_days: z.number().optional(),
  total_paper_trades: z.number().optional(),
  paper_pnl: z.number().optional(),
});

export type LiveTradingConfirmation = z.infer<typeof liveTradingConfirmationSchema>;

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

// ── Phase 5: Broker Adapter Schema ───────────────────────────

export const brokerCapabilitiesSchema = z.object({
  stocks: z.boolean().default(false),
  etfs: z.boolean().default(false),
  options: z.boolean().default(false),
  crypto: z.boolean().default(false),
  forex: z.boolean().default(false),
  paper_trading: z.boolean().default(false),
  live_trading: z.boolean().default(false),
  streaming: z.boolean().default(false),
});

export type BrokerCapabilities = z.infer<typeof brokerCapabilitiesSchema>;

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

export const dashboardMarketDataSchema = z.object({
  indices: z.array(marketIndexSnapshotSchema).default([]),
  news: z.array(newsHeadlineSchema).default([]),
  marketOpen: z.boolean().default(false),
  fetchedAt: z.string(),
});

export type DashboardMarketData = z.infer<typeof dashboardMarketDataSchema>;

export const serviceStatusSchema = z.object({
  daemon: z.boolean().default(false),
  telegram: z.boolean().default(false),
  marketData: z.boolean().default(false),
  marketDataProvider: z.enum(["fmp", "alpaca", "none"]).default("none"),
});

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const nextCronInfoSchema = z.object({
  fundName: z.string(),
  sessionType: z.string(),
  time: z.string(),
  minutesUntil: z.number(),
});

export type NextCronInfo = z.infer<typeof nextCronInfoSchema>;

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
    .enum(["success", "error_max_turns", "error_max_budget", "error", "timeout"])
    .optional(),
});

export type SessionLogV2 = z.infer<typeof sessionLogV2Schema>;
