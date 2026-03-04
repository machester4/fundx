import { readFile, writeFile, readdir, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import yaml from "js-yaml";
import {
  fundConfigSchema,
  fundTemplateSchema,
  type FundConfig,
  type FundTemplate,
} from "../types.js";
import { loadFundConfig, saveFundConfig } from "./fund.service.js";
import { initFundState } from "../state.js";
import { generateFundClaudeMd } from "../template.js";
import { SHARED_DIR, fundPaths } from "../paths.js";

// ── Template directory ───────────────────────────────────────

const TEMPLATES_DIR = join(SHARED_DIR, "templates");

async function ensureTemplatesDir(): Promise<void> {
  await mkdir(TEMPLATES_DIR, { recursive: true });
}

// ── Built-in templates ───────────────────────────────────────

function getBuiltinTemplates(): Record<string, Partial<FundConfig>> {
  return {
    runway: {
      objective: {
        type: "runway",
        target_months: 18,
        monthly_burn: 2000,
        min_reserve_months: 3,
      },
      risk: {
        profile: "moderate",
        max_drawdown_pct: 15,
        max_position_pct: 25,
        max_leverage: 1,
        stop_loss_pct: 8,
        max_daily_loss_pct: 5,
        correlation_limit: 0.8,
        custom_rules: ["Keep minimum 30% in cash or cash-equivalents"],
      },
      claude: {
        model: "sonnet",
        personality:
          "You manage capital like a fiduciary with a hard deadline. Every dollar lost is a month of runway consumed. Your default position is cash — you only deploy capital when the risk/reward is compelling and the downside is well-defined. You think in terms of survival first, returns second. A 5% gain means nothing if it required risking a 15% drawdown. You prefer high-probability, modest-return trades over speculative bets. When in doubt, do nothing — the cost of missing an opportunity is always lower than the cost of a drawdown that shortens the runway.",
        decision_framework:
          "Before every trade: (1) How many months of runway does this risk? If the max loss would reduce runway by more than 1 month, reduce size or pass. (2) What's the probability-weighted impact on the fund's survival timeline? (3) Is there a simpler, lower-risk way to achieve the same objective?",
      },
    },
    growth: {
      objective: {
        type: "growth",
        target_multiple: 2,
        timeframe_months: 24,
      },
      risk: {
        profile: "aggressive",
        max_drawdown_pct: 25,
        max_position_pct: 40,
        max_leverage: 2,
        stop_loss_pct: 10,
        max_daily_loss_pct: 7,
        correlation_limit: 0.8,
        custom_rules: [],
      },
      claude: {
        model: "sonnet",
        personality:
          "You are a conviction-driven alpha seeker. You concentrate capital in your highest-confidence ideas rather than spreading it thin across mediocre positions. You're comfortable with volatility because you understand it's the price of superior returns. You think in expected value — a trade with 40% win rate that returns 3:1 is better than a 60% win rate trade that returns 1:1. You're aggressive but disciplined — you cut losers fast and let winners run.",
        decision_framework:
          "Before every trade: (1) What's the expected value? EV = P(win) × gain - P(loss) × loss. Only proceed if EV is meaningfully positive. (2) Is this one of my top 3-5 best ideas right now? If not, the capital is better deployed elsewhere. (3) Does the timeline align with the growth target — am I compounding fast enough?",
      },
    },
    accumulation: {
      objective: {
        type: "accumulation",
        target_asset: "BTC",
        target_amount: 1.0,
      },
      risk: {
        profile: "moderate",
        max_drawdown_pct: 20,
        max_position_pct: 50,
        max_leverage: 1,
        stop_loss_pct: 15,
        max_daily_loss_pct: 8,
        correlation_limit: 0.9,
        custom_rules: ["DCA strategy preferred over lump sum"],
      },
      claude: {
        model: "sonnet",
        personality:
          "You are a patient accumulator playing a long game. Your goal isn't daily P&L — it's acquiring the target asset at the best possible average price. You love volatility because it creates buying opportunities. You use DCA as a baseline strategy but you're opportunistic — you buy more aggressively during sharp dips and less during euphoric rallies. You think in average cost per unit, not in daily portfolio value.",
        decision_framework:
          "Before every trade: (1) Does this improve my average cost? Am I buying at a discount to the recent average? (2) How much of my target have I accumulated? Am I on pace? (3) Is the macro environment creating a better-than-normal buying opportunity, or should I stick to the DCA schedule?",
      },
    },
    income: {
      objective: {
        type: "income",
        target_monthly_income: 500,
      },
      risk: {
        profile: "conservative",
        max_drawdown_pct: 10,
        max_position_pct: 20,
        max_leverage: 1,
        stop_loss_pct: 5,
        max_daily_loss_pct: 3,
        correlation_limit: 0.7,
        custom_rules: [
          "Prefer dividend-paying stocks and covered calls",
          "Reinvest dividends until target monthly income is reached",
        ],
      },
      claude: {
        model: "sonnet",
        personality:
          "You are a yield engineer building reliable income streams. You measure success in monthly cash flow, not capital appreciation. Your core holdings are selected for dividend sustainability — you'd rather own a stock yielding 3% with 20 years of dividend growth than one yielding 7% with questionable coverage. You trade defensively around core income positions, using covered calls to enhance yield and protective puts during market stress. You reinvest dividends until the target monthly income is reached.",
        decision_framework:
          "Before every trade: (1) Does this generate reliable, sustainable income? Check payout ratio, earnings coverage, and dividend growth history. (2) What's the yield-on-cost vs the risk of dividend cut? (3) How does this position affect total portfolio income — am I building toward the monthly target or drifting?",
      },
    },
  };
}

// ── Template CRUD ────────────────────────────────────────────

/** Export a fund configuration as a reusable template */
export async function exportFundTemplate(
  fundName: string,
  outputPath?: string,
): Promise<string> {
  const config = await loadFundConfig(fundName);

  const template: FundTemplate = {
    template_name: fundName,
    template_version: "1.0",
    description: `Template exported from fund '${config.fund.display_name}'`,
    created: new Date().toISOString().split("T")[0],
    source_fund: fundName,
    config,
  };

  const content = yaml.dump(template, { lineWidth: 120 });
  const filePath = outputPath ?? join(TEMPLATES_DIR, `${fundName}.yaml`);

  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

/** Import a template file and create a new fund from it */
export async function importFundTemplate(
  templatePath: string,
  newFundName?: string,
): Promise<string> {
  const raw = await readFile(templatePath, "utf-8");
  const parsed = yaml.load(raw);
  const template = fundTemplateSchema.parse(parsed);

  const fundName = newFundName ?? template.config.fund.name;

  // Override fund identity
  const config = { ...template.config };
  config.fund = {
    ...config.fund,
    name: fundName,
    created: new Date().toISOString().split("T")[0],
    status: "active",
  };

  // Always start in paper mode
  config.broker = { ...config.broker, mode: "paper" };

  const validated = fundConfigSchema.parse(config);
  await saveFundConfig(validated);
  await initFundState(
    fundName,
    validated.capital.initial,
    validated.objective.type,
  );
  await generateFundClaudeMd(validated);

  return fundName;
}

/** List available templates (built-in + user-exported) */
export async function listTemplates(): Promise<
  Array<{
    name: string;
    source: "builtin" | "user";
    description: string;
  }>
> {
  const templates: Array<{
    name: string;
    source: "builtin" | "user";
    description: string;
  }> = [];

  // Built-in templates
  const builtins = getBuiltinTemplates();
  for (const [name, config] of Object.entries(builtins)) {
    templates.push({
      name,
      source: "builtin",
      description: `${config.objective?.type ?? name} objective template`,
    });
  }

  // User templates from shared/templates/
  await ensureTemplatesDir();
  try {
    const files = await readdir(TEMPLATES_DIR);
    for (const file of files) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      try {
        const raw = await readFile(join(TEMPLATES_DIR, file), "utf-8");
        const parsed = yaml.load(raw) as Record<string, unknown>;
        templates.push({
          name: basename(file, ".yaml").replace(".yml", ""),
          source: "user",
          description:
            (parsed.description as string) ?? "User-exported template",
        });
      } catch {
        // Skip invalid template files
      }
    }
  } catch {
    // Directory may not exist
  }

  return templates;
}

/** Create a new fund from a built-in template */
export async function createFromBuiltinTemplate(
  templateName: string,
  fundName: string,
  displayName: string,
  initialCapital: number,
): Promise<string> {
  const builtins = getBuiltinTemplates();
  const template = builtins[templateName];
  if (!template) {
    throw new Error(
      `Built-in template '${templateName}' not found. Available: ${Object.keys(builtins).join(", ")}`,
    );
  }

  const config = fundConfigSchema.parse({
    fund: {
      name: fundName,
      display_name: displayName,
      description: `Created from ${templateName} template`,
      created: new Date().toISOString().split("T")[0],
      status: "active",
    },
    capital: { initial: initialCapital, currency: "USD" },
    objective: template.objective,
    risk: template.risk,
    universe: { allowed: [], forbidden: [] },
    schedule: {
      sessions: {
        pre_market: {
          time: "09:00",
          enabled: true,
          focus: "Analyze overnight developments. Plan trades.",
        },
        mid_session: {
          time: "13:00",
          enabled: true,
          focus: "Monitor positions. React to intraday moves.",
        },
        post_market: {
          time: "18:00",
          enabled: true,
          focus: "Review day. Update journal. Generate report.",
        },
      },
    },
    broker: { provider: "alpaca", mode: "paper" },
    claude: template.claude,
  });

  await saveFundConfig(config);
  await initFundState(fundName, initialCapital, config.objective.type);
  await generateFundClaudeMd(config);

  return fundName;
}

// ── Fund Clone ───────────────────────────────────────────────

/** Clone an existing fund's configuration to a new fund */
export async function cloneFund(
  sourceName: string,
  targetName: string,
): Promise<string> {
  const sourceConfig = await loadFundConfig(sourceName);

  const targetConfig = fundConfigSchema.parse({
    ...sourceConfig,
    fund: {
      ...sourceConfig.fund,
      name: targetName,
      display_name: `${sourceConfig.fund.display_name} (clone)`,
      created: new Date().toISOString().split("T")[0],
      status: "active",
    },
    broker: {
      ...sourceConfig.broker,
      mode: "paper", // Always start cloned funds in paper mode
    },
  });

  await saveFundConfig(targetConfig);
  await initFundState(
    targetName,
    targetConfig.capital.initial,
    targetConfig.objective.type,
  );
  await generateFundClaudeMd(targetConfig);

  // Copy scripts from source if any exist
  const sourcePaths = fundPaths(sourceName);
  const targetPaths = fundPaths(targetName);
  if (existsSync(sourcePaths.scripts)) {
    await cp(sourcePaths.scripts, targetPaths.scripts, { recursive: true });
  }

  return targetName;
}
