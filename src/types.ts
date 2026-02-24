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

export const scheduleSchema = z.object({
  timezone: z.string().default("UTC"),
  trading_days: z
    .array(z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]))
    .default(["MON", "TUE", "WED", "THU", "FRI"]),
  sessions: z.record(z.string(), sessionScheduleSchema).default({}),
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
      model: z.enum(["opus", "sonnet"]).default("sonnet"),
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
  claude_path: z.string().default("claude"),
  default_model: z.enum(["opus", "sonnet"]).default("sonnet"),
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

export const sessionRecordSchema = z.object({
  id: z.number().optional(),
  timestamp: z.string(),
  fund: z.string(),
  session_type: z.string(),
  duration_seconds: z.number().optional(),
  trades_executed: z.number().default(0),
  analysis_file: z.string().optional(),
  summary: z.string().optional(),
  claude_model: z.string().optional(),
});

export type SessionRecord = z.infer<typeof sessionRecordSchema>;

// ── Alpaca API Schemas ────────────────────────────────────────

export const alpacaAccountSchema = z.object({
  id: z.string(),
  account_number: z.string(),
  status: z.string(),
  currency: z.string(),
  cash: z.string(),
  portfolio_value: z.string(),
  buying_power: z.string(),
  equity: z.string(),
  last_equity: z.string(),
  long_market_value: z.string(),
  short_market_value: z.string(),
  daytrade_count: z.number(),
  pattern_day_trader: z.boolean(),
});

export type AlpacaAccount = z.infer<typeof alpacaAccountSchema>;

export const alpacaPositionSchema = z.object({
  asset_id: z.string(),
  symbol: z.string(),
  exchange: z.string(),
  asset_class: z.string(),
  avg_entry_price: z.string(),
  qty: z.string(),
  side: z.string(),
  market_value: z.string(),
  cost_basis: z.string(),
  unrealized_pl: z.string(),
  unrealized_plpc: z.string(),
  current_price: z.string(),
  lastday_price: z.string(),
  change_today: z.string(),
});

export type AlpacaPosition = z.infer<typeof alpacaPositionSchema>;

export const alpacaOrderSchema = z.object({
  id: z.string(),
  client_order_id: z.string(),
  created_at: z.string(),
  updated_at: z.string().optional(),
  submitted_at: z.string().optional(),
  filled_at: z.string().nullable().optional(),
  expired_at: z.string().nullable().optional(),
  canceled_at: z.string().nullable().optional(),
  asset_id: z.string(),
  symbol: z.string(),
  asset_class: z.string(),
  qty: z.string().nullable().optional(),
  filled_qty: z.string(),
  type: z.string(),
  side: z.string(),
  time_in_force: z.string(),
  limit_price: z.string().nullable().optional(),
  stop_price: z.string().nullable().optional(),
  filled_avg_price: z.string().nullable().optional(),
  status: z.string(),
  order_class: z.string().optional(),
});

export type AlpacaOrder = z.infer<typeof alpacaOrderSchema>;

export const alpacaBarSchema = z.object({
  t: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
  n: z.number().optional(),
  vw: z.number().optional(),
});

export type AlpacaBar = z.infer<typeof alpacaBarSchema>;

export const alpacaQuoteSchema = z.object({
  t: z.string().optional(),
  ap: z.number(),
  as: z.number(),
  bp: z.number(),
  bs: z.number(),
  ax: z.string().optional(),
  bx: z.string().optional(),
});

export type AlpacaQuote = z.infer<typeof alpacaQuoteSchema>;

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
  "risk",
  "custom",
]);

export type SubAgentType = z.infer<typeof subAgentTypeSchema>;

export const subAgentConfigSchema = z.object({
  type: subAgentTypeSchema,
  name: z.string(),
  prompt: z.string(),
  max_turns: z.number().positive().default(20),
  model: z.enum(["opus", "sonnet"]).optional(),
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
