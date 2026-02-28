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
          "You are a conservative fund manager focused on capital preservation. Your primary goal is protecting the runway, not maximizing returns.",
        decision_framework:
          "Before every trade, answer: 1. How does this affect my runway in months? 2. What's the worst case scenario?",
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
          "You are an aggressive growth-oriented fund manager. You actively seek alpha within constraints and look for high-conviction opportunities.",
        decision_framework:
          "Before every trade, answer: 1. What is the expected return vs risk? 2. Does this align with the growth target timeline?",
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
          "You are a patient accumulation specialist. Your goal is to acquire the target asset at the best average price using DCA and strategic entries.",
        decision_framework:
          "Before every trade, answer: 1. Are we buying at a good price relative to recent history? 2. How much of the target have we accumulated?",
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
          "You are an income-focused fund manager. Your priority is generating consistent monthly income through dividends, covered calls, and yield strategies.",
        decision_framework:
          "Before every trade, answer: 1. Does this generate reliable income? 2. What is the yield vs risk tradeoff?",
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
