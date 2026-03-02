import { readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import yaml from "js-yaml";
import { fundConfigSchema, type FundConfig } from "../types.js";
import { FUNDS_DIR, fundPaths } from "../paths.js";
import { initFundState } from "../state.js";
import { generateFundClaudeMd } from "../template.js";
import { loadGlobalConfig } from "../config.js";
import { ensureFundSkillFiles, BUILTIN_SKILLS } from "../skills.js";

// ── Fund CRUD ──────────────────────────────────────────────────

export async function loadFundConfig(fundName: string): Promise<FundConfig> {
  const paths = fundPaths(fundName);
  const raw = await readFile(paths.config, "utf-8");
  const parsed = yaml.load(raw);
  return fundConfigSchema.parse(parsed);
}

export async function saveFundConfig(config: FundConfig): Promise<void> {
  const paths = fundPaths(config.fund.name);
  await mkdir(paths.root, { recursive: true });
  const content = yaml.dump(config, { lineWidth: 120 });
  await writeFile(paths.config, content, "utf-8");
}

export async function listFundNames(): Promise<string[]> {
  if (!existsSync(FUNDS_DIR)) return [];
  const entries = await readdir(FUNDS_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Validate fund name: alphanumeric, hyphens, underscores only */
export function validateFundName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed)) {
    throw new Error(
      "Fund name must start with a letter/digit and contain only letters, digits, hyphens, and underscores.",
    );
  }
  return trimmed;
}

/** Risk defaults per profile */
export const RISK_DEFAULTS = {
  conservative: { max_drawdown_pct: 10, max_position_pct: 15 },
  moderate: { max_drawdown_pct: 15, max_position_pct: 25 },
  aggressive: { max_drawdown_pct: 25, max_position_pct: 40 },
} as const;

/** Objective type choices for UI rendering */
export const OBJECTIVE_CHOICES = [
  { value: "runway" as const, name: "Runway — Sustain monthly expenses" },
  { value: "growth" as const, name: "Growth — Multiply capital" },
  { value: "accumulation" as const, name: "Accumulation — Acquire an asset" },
  { value: "income" as const, name: "Income — Passive monthly income" },
  { value: "custom" as const, name: "Custom — Define your own" },
] as const;

/** Risk profile choices for UI rendering */
export const RISK_CHOICES = [
  { value: "conservative" as const, name: "Conservative (max DD: 10%)" },
  { value: "moderate" as const, name: "Moderate (max DD: 15%)" },
  { value: "aggressive" as const, name: "Aggressive (max DD: 25%)" },
] as const;

export interface CreateFundParams {
  name: string;
  displayName: string;
  description: string;
  objectiveType: string;
  initialCapital: number;
  objective: FundConfig["objective"];
  riskProfile: string;
  tickers: string;
  brokerMode: "paper" | "live";
}

/** Create a new fund from structured params (no prompts) */
export async function createFund(params: CreateFundParams): Promise<FundConfig> {
  const name = validateFundName(params.name);
  const globalConfig = await loadGlobalConfig();

  const config: FundConfig = fundConfigSchema.parse({
    fund: {
      name,
      display_name: params.displayName,
      description: params.description,
      created: new Date().toISOString().split("T")[0],
      status: "active",
    },
    capital: { initial: params.initialCapital, currency: "USD" },
    objective: params.objective,
    risk: {
      profile: params.riskProfile,
      ...RISK_DEFAULTS[params.riskProfile as keyof typeof RISK_DEFAULTS],
    },
    universe: {
      allowed: params.tickers
        ? [{ type: "etf", tickers: params.tickers.split(",").map((t) => t.trim()) }]
        : [],
    },
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
    broker: { provider: globalConfig.broker.provider, mode: params.brokerMode },
    claude: { model: globalConfig.default_model ?? "sonnet" },
  });

  await saveFundConfig(config);
  await initFundState(name, params.initialCapital, params.objectiveType);
  await generateFundClaudeMd(config);
  await ensureFundSkillFiles(fundPaths(name).claudeDir);

  return config;
}

/** Delete a fund by name */
export async function deleteFund(fundName: string): Promise<void> {
  const paths = fundPaths(fundName);
  if (!existsSync(paths.root)) {
    throw new Error(`Fund '${fundName}' not found.`);
  }
  await rm(paths.root, { recursive: true });
}

export interface FundListItem {
  name: string;
  displayName: string;
  description: string;
  status: string;
  error?: boolean;
}

/** Get structured list data for all funds */
export async function getFundListData(): Promise<FundListItem[]> {
  const names = await listFundNames();
  const items: FundListItem[] = [];
  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      items.push({
        name,
        displayName: config.fund.display_name,
        description: config.fund.description ?? "",
        status: config.fund.status,
      });
    } catch {
      items.push({
        name,
        displayName: name,
        description: "invalid config",
        status: "error",
        error: true,
      });
    }
  }
  return items;
}

export interface FundInfoData {
  config: FundConfig;
}

/** Get fund info data */
export async function getFundInfo(fundName: string): Promise<FundInfoData> {
  const config = await loadFundConfig(fundName);
  return { config };
}

// ── Fund Upgrade ──────────────────────────────────────────────

export interface UpgradeResult {
  fundName: string;
  skillCount: number;
}

/** Upgrade a fund: regenerate CLAUDE.md and rewrite all skills from latest code */
export async function upgradeFund(fundName: string): Promise<UpgradeResult> {
  const config = await loadFundConfig(fundName);
  const paths = fundPaths(fundName);

  // Regenerate CLAUDE.md from current config
  await generateFundClaudeMd(config);

  // Wipe and rewrite all skills with latest builtin content
  await rm(paths.claudeSkillsDir, { recursive: true, force: true });
  await ensureFundSkillFiles(paths.claudeDir);

  return { fundName, skillCount: BUILTIN_SKILLS.length };
}
