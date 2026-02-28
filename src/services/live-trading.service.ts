import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadFundConfig, saveFundConfig } from "./fund.service.js";
import { readPortfolio, readTracker } from "../state.js";
import { openJournal, getTradeSummary } from "../journal.js";
import { fundPaths, WORKSPACE } from "../paths.js";
import type { LiveTradingConfirmation } from "../types.js";

const MIN_PAPER_TRADES = 5;

export interface SafetyCheckResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
}

export async function runSafetyChecks(
  fundName: string,
): Promise<SafetyCheckResult> {
  const checks: SafetyCheckResult["checks"] = [];

  try {
    const config = await loadFundConfig(fundName);
    checks.push({
      name: "Fund configuration valid",
      passed: true,
      detail: `Fund '${config.fund.display_name}' found`,
    });
  } catch {
    checks.push({
      name: "Fund configuration valid",
      passed: false,
      detail: `Could not load fund '${fundName}'`,
    });
    return { passed: false, checks };
  }

  try {
    await readPortfolio(fundName);
    checks.push({
      name: "Portfolio state exists",
      passed: true,
      detail: "portfolio.json found and valid",
    });
  } catch {
    checks.push({
      name: "Portfolio state exists",
      passed: false,
      detail: "portfolio.json missing or invalid",
    });
  }

  try {
    await readTracker(fundName);
    checks.push({
      name: "Objective tracker exists",
      passed: true,
      detail: "objective_tracker.json found",
    });
  } catch {
    checks.push({
      name: "Objective tracker exists",
      passed: false,
      detail: "objective_tracker.json missing",
    });
  }

  try {
    const db = openJournal(fundName);
    try {
      const summary = getTradeSummary(db, fundName);
      checks.push({
        name: `Minimum trade history (>=${MIN_PAPER_TRADES})`,
        passed: summary.total_trades >= MIN_PAPER_TRADES,
        detail: `${summary.total_trades} closed trades recorded`,
      });
    } finally {
      db.close();
    }
  } catch {
    checks.push({
      name: `Minimum trade history (>=${MIN_PAPER_TRADES})`,
      passed: false,
      detail: "No trade journal found",
    });
  }

  const paths = fundPaths(fundName);
  const hasClaude = existsSync(paths.claudeMd);
  checks.push({
    name: "CLAUDE.md constitution exists",
    passed: hasClaude,
    detail: hasClaude ? "Fund has AI constitution" : "CLAUDE.md missing",
  });

  try {
    const { loadGlobalConfig } = await import("../config.js");
    const global = await loadGlobalConfig();
    const hasCreds = !!(global.broker.api_key && global.broker.secret_key);
    checks.push({
      name: "Broker credentials configured",
      passed: hasCreds,
      detail: hasCreds
        ? `Provider: ${global.broker.provider}`
        : "No API credentials in global config",
    });
  } catch {
    checks.push({
      name: "Broker credentials configured",
      passed: false,
      detail: "Could not read global config",
    });
  }

  const passed = checks.every((c) => c.passed);
  return { passed, checks };
}

export async function switchTradingMode(
  fundName: string,
  targetMode: "paper" | "live",
): Promise<LiveTradingConfirmation> {
  const config = await loadFundConfig(fundName);
  const previousMode = config.broker.mode;

  if (previousMode === targetMode) {
    throw new Error(`Fund '${fundName}' is already in ${targetMode} mode`);
  }

  config.broker.mode = targetMode;
  await saveFundConfig(config);

  const confirmation: LiveTradingConfirmation = {
    fund: fundName,
    confirmed_at: new Date().toISOString(),
    confirmed_by: "cli",
    previous_mode: previousMode,
    new_mode: targetMode,
  };

  const logDir = join(WORKSPACE, "logs");
  await mkdir(logDir, { recursive: true });
  const logFile = join(logDir, "mode_changes.jsonl");
  const logLine = JSON.stringify(confirmation) + "\n";

  try {
    const existing = existsSync(logFile)
      ? await readFile(logFile, "utf-8")
      : "";
    await writeFile(logFile, existing + logLine, "utf-8");
  } catch {
    await writeFile(logFile, logLine, "utf-8");
  }

  return confirmation;
}

export interface TradingModeStatus {
  name: string;
  displayName: string;
  mode: "paper" | "live" | string;
  provider: string;
  error?: boolean;
}

/** Get trading mode status for all funds */
export async function getTradingModeStatuses(): Promise<TradingModeStatus[]> {
  const { listFundNames } = await import("./fund.service.js");
  const names = await listFundNames();
  const results: TradingModeStatus[] = [];

  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      results.push({
        name,
        displayName: config.fund.display_name,
        mode: config.broker.mode,
        provider: config.broker.provider,
      });
    } catch {
      results.push({
        name,
        displayName: name,
        mode: "unknown",
        provider: "unknown",
        error: true,
      });
    }
  }

  return results;
}
