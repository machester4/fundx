import { readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { input, select, number, checkbox, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import yaml from "js-yaml";
import { fundConfigSchema, type FundConfig } from "./types.js";
import { FUNDS_DIR, fundPaths } from "./paths.js";
import { initFundState } from "./state.js";
import { generateFundClaudeMd } from "./template.js";

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

// ── CLI Commands ───────────────────────────────────────────────

export const fundCommand = new Command("fund").description(
  "Manage investment funds",
);

fundCommand
  .command("create")
  .description("Interactive fund creation wizard")
  .action(async () => {
    console.log(chalk.bold("\n  New Fund\n"));

    const name = await input({ message: "Fund name (slug):" });
    const displayName = await input({ message: "Display name:" });
    const description = await input({ message: "Description:" });

    const objectiveType = await select({
      message: "Goal type:",
      choices: [
        { value: "runway", name: "Runway — Sustain monthly expenses" },
        { value: "growth", name: "Growth — Multiply capital" },
        { value: "accumulation", name: "Accumulation — Acquire an asset" },
        { value: "income", name: "Income — Passive monthly income" },
        { value: "custom", name: "Custom — Define your own" },
      ],
    });

    const initialCapital =
      (await number({ message: "Initial capital (USD):" })) ?? 0;

    const objective = await promptObjective(objectiveType, initialCapital);

    const riskProfile = await select({
      message: "Risk tolerance:",
      choices: [
        { value: "conservative", name: "Conservative (max DD: 10%)" },
        { value: "moderate", name: "Moderate (max DD: 15%)" },
        { value: "aggressive", name: "Aggressive (max DD: 25%)" },
      ],
    });

    const riskDefaults = {
      conservative: { max_drawdown_pct: 10, max_position_pct: 15 },
      moderate: { max_drawdown_pct: 15, max_position_pct: 25 },
      aggressive: { max_drawdown_pct: 25, max_position_pct: 40 },
    };

    const tickers = await input({
      message: "Allowed tickers (comma separated, empty = any):",
    });

    const brokerMode = await select({
      message: "Broker mode:",
      choices: [
        { value: "paper" as const, name: "Paper trading" },
        { value: "live" as const, name: "Live trading" },
      ],
    });

    const config: FundConfig = fundConfigSchema.parse({
      fund: {
        name,
        display_name: displayName,
        description,
        created: new Date().toISOString().split("T")[0],
        status: "active",
      },
      capital: { initial: initialCapital, currency: "USD" },
      objective,
      risk: {
        profile: riskProfile,
        ...riskDefaults[riskProfile as keyof typeof riskDefaults],
      },
      universe: {
        allowed: tickers
          ? [{ type: "etf", tickers: tickers.split(",").map((t) => t.trim()) }]
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
      broker: { provider: "alpaca", mode: brokerMode },
      claude: { model: "sonnet" },
    });

    await saveFundConfig(config);
    await initFundState(name, initialCapital, objectiveType);
    await generateFundClaudeMd(config);

    console.log(chalk.green(`\n  ✓ Fund '${name}' created`));
    console.log(chalk.dim(`  Start trading: fundx start ${name}\n`));
  });

fundCommand
  .command("list")
  .description("List all funds")
  .action(async () => {
    const names = await listFundNames();
    if (names.length === 0) {
      console.log(chalk.dim("  No funds yet. Run 'fundx fund create'."));
      return;
    }
    for (const name of names) {
      try {
        const config = await loadFundConfig(name);
        const status = config.fund.status === "active" ? chalk.green("●") : chalk.yellow("◐");
        console.log(`  ${status} ${chalk.bold(name)} — ${config.fund.display_name}`);
      } catch {
        console.log(`  ${chalk.red("✗")} ${name} — invalid config`);
      }
    }
  });

fundCommand
  .command("info")
  .description("Show fund details")
  .argument("<name>", "Fund name")
  .action(async (name: string) => {
    const config = await loadFundConfig(name);
    console.log(chalk.bold(`\n  ${config.fund.display_name}`));
    console.log(`  ${config.fund.description}`);
    console.log(`  Status: ${config.fund.status}`);
    console.log(`  Capital: $${config.capital.initial} ${config.capital.currency}`);
    console.log(`  Objective: ${config.objective.type}`);
    console.log(`  Risk: ${config.risk.profile}`);
    console.log(`  Broker: ${config.broker.provider} (${config.broker.mode})`);
    console.log();
  });

fundCommand
  .command("delete")
  .description("Delete a fund")
  .argument("<name>", "Fund name")
  .action(async (name: string) => {
    const paths = fundPaths(name);
    if (!existsSync(paths.root)) {
      console.log(chalk.red(`  Fund '${name}' not found.`));
      return;
    }
    const yes = await confirm({ message: `Delete fund '${name}'? This cannot be undone.` });
    if (!yes) return;
    await rm(paths.root, { recursive: true });
    console.log(chalk.green(`  ✓ Fund '${name}' deleted.`));
  });

// ── Objective prompts ──────────────────────────────────────────

async function promptObjective(type: string, capital: number) {
  switch (type) {
    case "runway": {
      const monthly = (await number({ message: "Monthly burn rate (USD):" })) ?? 2000;
      const months = (await number({ message: "Target months of runway:" })) ?? 18;
      const reserve = (await number({ message: "Min cash reserve (months):", default: 3 })) ?? 3;
      return { type: "runway" as const, monthly_burn: monthly, target_months: months, min_reserve_months: reserve };
    }
    case "growth": {
      const multiple = (await number({ message: "Target multiple (e.g. 2 for 2x):" })) ?? 2;
      return { type: "growth" as const, target_multiple: multiple };
    }
    case "accumulation": {
      const asset = await input({ message: "Target asset (e.g. BTC):" });
      const amount = (await number({ message: "Target amount:" })) ?? 1;
      return { type: "accumulation" as const, target_asset: asset, target_amount: amount };
    }
    case "income": {
      const monthly = (await number({ message: "Target monthly income (USD):" })) ?? 500;
      return { type: "income" as const, target_monthly_income: monthly };
    }
    default: {
      const desc = await input({ message: "Describe your objective:" });
      return { type: "custom" as const, description: desc };
    }
  }
}
