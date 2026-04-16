import { readFile, writeFile, copyFile, rename, readdir, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import yaml from "js-yaml";
import { fundConfigSchema, type FundConfig } from "../types.js";
import type { Universe } from "../types.js";
import { FUNDS_DIR, fundPaths } from "../paths.js";
import { initFundState, clearActiveSession } from "../state.js";
import { generateFundClaudeMd } from "../template.js";
import { loadGlobalConfig } from "../config.js";
import { ensureFundSkillFiles, ensureFundRules, ensureFundMemory, BUILTIN_SKILLS } from "../skills.js";

// ── Legacy Universe Migration ─────────────────────────────────

type LegacyAssetEntry = {
  type?: string;
  tickers?: string[];
  sectors?: string[];
  strategies?: string[];
  protocols?: string[];
};
type LegacyUniverse = { allowed?: LegacyAssetEntry[]; forbidden?: LegacyAssetEntry[] };

export function isLegacyUniverse(u: unknown): boolean {
  if (typeof u !== "object" || u === null) return false;
  return "allowed" in u || "forbidden" in u;
}

export interface MigratedUniverse {
  preset: "sp500";
  include_tickers: string[];
  exclude_tickers: string[];
  exclude_sectors: string[];
}

export function migrateUniverseFromLegacy(legacy: LegacyUniverse): MigratedUniverse {
  const include = new Set<string>();
  const excludeT = new Set<string>();
  const excludeS = new Set<string>();
  for (const e of legacy.allowed ?? []) {
    for (const t of e.tickers ?? []) include.add(t.toUpperCase());
    // allowed.sectors semantics were ambiguous — dropped silently
  }
  for (const e of legacy.forbidden ?? []) {
    for (const t of e.tickers ?? []) excludeT.add(t.toUpperCase());
    for (const s of e.sectors ?? []) excludeS.add(s);
  }
  return {
    preset: "sp500",
    include_tickers: [...include].sort(),
    exclude_tickers: [...excludeT].sort(),
    exclude_sectors: [...excludeS].sort(),
  };
}

async function maybeMigrateUniverseFile(
  configPath: string,
): Promise<{ migrated: boolean; warnings: string[] }> {
  const raw = await readFile(configPath, "utf-8");
  const parsed = yaml.load(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") return { migrated: false, warnings: [] };
  if (!isLegacyUniverse((parsed as Record<string, unknown>).universe))
    return { migrated: false, warnings: [] };

  await copyFile(configPath, `${configPath}.bak`);
  const legacy = (parsed as Record<string, unknown>).universe as LegacyUniverse;
  const warnings: string[] = [];

  const hasDroppedFields =
    (legacy.allowed ?? []).some(
      (e) => (e.strategies?.length ?? 0) + (e.protocols?.length ?? 0) > 0,
    ) ||
    (legacy.forbidden ?? []).some(
      (e) => (e.strategies?.length ?? 0) + (e.protocols?.length ?? 0) > 0,
    );
  if (hasDroppedFields) {
    warnings.push(
      "Dropped unsupported fields (strategies, protocols) — these were not enforced in the old schema either.",
    );
  }
  const hasAllowedSectors = (legacy.allowed ?? []).some((e) => (e.sectors?.length ?? 0) > 0);
  if (hasAllowedSectors) {
    warnings.push(
      "Old 'allowed sectors' dropped (ambiguous semantics). Review your new universe block and add a `filters.sector` block if you want to restrict to specific sectors.",
    );
  }
  const hasNonEtfAllowed = (legacy.allowed ?? []).some(
    (e) => e.type && e.type !== "etf" && e.type !== "stock",
  );
  if (hasNonEtfAllowed) {
    warnings.push("Allowed entries with non-stock/etf types dropped. Only tickers preserved.");
  }

  (parsed as Record<string, unknown>).universe = migrateUniverseFromLegacy(legacy);
  const tmp = `${configPath}.tmp`;
  await writeFile(tmp, yaml.dump(parsed, { lineWidth: 120 }), "utf-8");
  await rename(tmp, configPath);

  return { migrated: true, warnings };
}

// ── Wizard Universe Helpers ───────────────────────────────────

export function resolveWizardUniverseChoice(
  choice: string,
  includeTickers: string[] = [],
): Universe {
  switch (choice) {
    case "sp500":
    case "nasdaq100":
    case "dow30":
      return {
        preset: choice as "sp500" | "nasdaq100" | "dow30",
        include_tickers: includeTickers,
        exclude_tickers: [],
        exclude_sectors: [],
      };
    case "tmpl-large":
      return {
        filters: {
          market_cap_min: 10_000_000_000,
          exchange: ["NYSE", "NASDAQ"],
          country: "US",
          is_actively_trading: true,
          limit: 500,
        },
        include_tickers: includeTickers,
        exclude_tickers: [],
        exclude_sectors: [],
      };
    case "tmpl-mid":
      return {
        filters: {
          market_cap_min: 2_000_000_000,
          market_cap_max: 10_000_000_000,
          exchange: ["NYSE", "NASDAQ"],
          country: "US",
          is_actively_trading: true,
          limit: 500,
        },
        include_tickers: includeTickers,
        exclude_tickers: [],
        exclude_sectors: [],
      };
    case "custom":
    default:
      return {
        filters: { is_actively_trading: true, limit: 500 },
        include_tickers: includeTickers,
        exclude_tickers: [],
        exclude_sectors: [],
      };
  }
}

export function normalizeWizardUniverse(params: {
  universeChoice?: string;
  tickers?: string;
}): Universe {
  const tickers = (params.tickers ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => t.toUpperCase());
  const choice = params.universeChoice ?? "sp500";
  return resolveWizardUniverseChoice(choice, tickers);
}

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
  universeChoice?: string;
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
    universe: normalizeWizardUniverse(params),
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
    broker: { mode: "paper" as const },
    claude: { model: globalConfig.default_model ?? "sonnet" },
  });

  await saveFundConfig(config);
  await initFundState(name, params.initialCapital, params.objectiveType);
  await generateFundClaudeMd(config);
  await ensureFundSkillFiles(fundPaths(name).claudeDir);
  await ensureFundRules(fundPaths(name).claudeDir);
  await ensureFundMemory(fundPaths(name).root, fundPaths(name).claudeDir);

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

// ── Load All Fund Configs ─────────────────────────────────────

export async function loadAllFundConfigs(): Promise<FundConfig[]> {
  const names = await listFundNames();
  const out: FundConfig[] = [];
  for (const name of names) {
    try {
      out.push(await loadFundConfig(name));
    } catch {
      // skip malformed
    }
  }
  return out;
}

// ── Fund Upgrade ──────────────────────────────────────────────

export interface UpgradeResult {
  fundName: string;
  skillCount: number;
  universeMigrated: boolean;
  warnings: string[];
}

/** Upgrade a fund: regenerate CLAUDE.md and rewrite all skills from latest code */
export async function upgradeFund(fundName: string): Promise<UpgradeResult> {
  const paths = fundPaths(fundName);

  // Migrate universe shape BEFORE loading (loadFundConfig would fail on legacy)
  const { migrated, warnings } = await maybeMigrateUniverseFile(paths.config);

  const config = await loadFundConfig(fundName);

  // Regenerate CLAUDE.md from current (potentially migrated) config
  await generateFundClaudeMd(config);

  // Wipe and rewrite all skills with latest builtin content
  await rm(paths.claudeSkillsDir, { recursive: true, force: true });
  await ensureFundSkillFiles(paths.claudeDir);

  // Write/overwrite per-fund rules
  await ensureFundRules(paths.claudeDir);
  await ensureFundMemory(paths.root, paths.claudeDir);

  // Clear stale session so next chat starts fresh with updated instructions
  await clearActiveSession(fundName);

  return { fundName, skillCount: BUILTIN_SKILLS.length, universeMigrated: migrated, warnings };
}
