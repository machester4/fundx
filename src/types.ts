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
