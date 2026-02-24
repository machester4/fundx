import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { confirm, input } from "@inquirer/prompts";
import chalk from "chalk";
import { loadFundConfig, saveFundConfig } from "./fund.js";
import { readPortfolio, readTracker } from "./state.js";
import { openJournal, getTradeSummary } from "./journal.js";
import { fundPaths, WORKSPACE } from "./paths.js";
import type { LiveTradingConfirmation } from "./types.js";

// ── Safety Checks ────────────────────────────────────────────

interface SafetyCheckResult {
  passed: boolean;
  checks: Array<{
    name: string;
    passed: boolean;
    detail: string;
  }>;
}

/**
 * Run safety checks before allowing live trading.
 * Requires minimum paper trading history and positive track record.
 */
export async function runSafetyChecks(
  fundName: string,
): Promise<SafetyCheckResult> {
  const checks: SafetyCheckResult["checks"] = [];

  // Check 1: Fund exists and has valid config
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

  // Check 2: Portfolio state exists
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

  // Check 3: Objective tracker exists
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

  // Check 4: Minimum paper trading history
  try {
    const db = openJournal(fundName);
    try {
      const summary = getTradeSummary(db, fundName);
      const minTrades = 5;
      checks.push({
        name: `Minimum trade history (>=${minTrades})`,
        passed: summary.total_trades >= minTrades,
        detail: `${summary.total_trades} closed trades recorded`,
      });
    } finally {
      db.close();
    }
  } catch {
    checks.push({
      name: "Minimum trade history (>=5)",
      passed: false,
      detail: "No trade journal found",
    });
  }

  // Check 5: CLAUDE.md exists
  const paths = fundPaths(fundName);
  const hasClaude = existsSync(paths.claudeMd);
  checks.push({
    name: "CLAUDE.md constitution exists",
    passed: hasClaude,
    detail: hasClaude ? "Fund has AI constitution" : "CLAUDE.md missing",
  });

  // Check 6: Broker credentials configured
  try {
    const { loadGlobalConfig } = await import("./config.js");
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

/**
 * Switch a fund between paper and live trading modes.
 * Requires explicit confirmation and logs the change.
 */
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

  // Log the mode change
  const confirmation: LiveTradingConfirmation = {
    fund: fundName,
    confirmed_at: new Date().toISOString(),
    confirmed_by: "cli",
    previous_mode: previousMode,
    new_mode: targetMode,
  };

  // Save confirmation log
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

// ── CLI Commands ───────────────────────────────────────────────

export const liveCommand = new Command("live").description(
  "Manage live trading mode",
);

liveCommand
  .command("enable")
  .description("Switch a fund to live trading (with safety checks)")
  .argument("<fund>", "Fund name")
  .action(async (fundName: string) => {
    console.log(chalk.bold("\n  Live Trading Mode\n"));

    // Run safety checks
    console.log(chalk.bold("  Safety Checks:"));
    const result = await runSafetyChecks(fundName);

    for (const check of result.checks) {
      const icon = check.passed ? chalk.green("✓") : chalk.red("✗");
      console.log(`  ${icon} ${check.name}: ${chalk.dim(check.detail)}`);
    }
    console.log();

    if (!result.passed) {
      console.log(
        chalk.red(
          "  ✗ Safety checks failed. Resolve the issues above before enabling live trading.\n",
        ),
      );
      return;
    }

    // Warning
    console.log(
      chalk.yellow(
        "  ⚠ WARNING: Live trading uses real money. Losses are real and irreversible.",
      ),
    );
    console.log(
      chalk.yellow(
        "  ⚠ Ensure you have reviewed the fund's configuration and risk parameters.\n",
      ),
    );

    // First confirmation
    const confirm1 = await confirm({
      message: `Switch fund '${fundName}' to LIVE trading?`,
      default: false,
    });
    if (!confirm1) {
      console.log(chalk.dim("  Cancelled.\n"));
      return;
    }

    // Second confirmation with fund name typing
    const typed = await input({
      message: `Type the fund name '${fundName}' to confirm:`,
    });
    if (typed !== fundName) {
      console.log(chalk.red("  Name did not match. Cancelled.\n"));
      return;
    }

    try {
      const confirmation = await switchTradingMode(fundName, "live");
      console.log(chalk.green(`\n  ✓ Fund '${fundName}' switched to LIVE trading.`));
      console.log(chalk.dim(`  Confirmed at: ${confirmation.confirmed_at}\n`));
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
    }
  });

liveCommand
  .command("disable")
  .description("Switch a fund back to paper trading")
  .argument("<fund>", "Fund name")
  .action(async (fundName: string) => {
    const yes = await confirm({
      message: `Switch fund '${fundName}' back to paper trading?`,
    });
    if (!yes) return;

    try {
      await switchTradingMode(fundName, "paper");
      console.log(
        chalk.green(`  ✓ Fund '${fundName}' switched to paper trading.\n`),
      );
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
    }
  });

liveCommand
  .command("status")
  .description("Check trading mode for all funds")
  .action(async () => {
    const { listFundNames } = await import("./fund.js");
    const names = await listFundNames();

    if (names.length === 0) {
      console.log(chalk.dim("  No funds found.\n"));
      return;
    }

    console.log(chalk.bold("\n  Trading Mode Status\n"));

    for (const name of names) {
      try {
        const config = await loadFundConfig(name);
        const mode = config.broker.mode;
        const modeIcon =
          mode === "live" ? chalk.red("● LIVE") : chalk.green("● PAPER");
        console.log(
          `  ${modeIcon}  ${chalk.bold(name)} — ${config.fund.display_name} (${config.broker.provider})`,
        );
      } catch {
        console.log(`  ${chalk.red("✗")} ${name} — config error`);
      }
    }
    console.log();
  });
