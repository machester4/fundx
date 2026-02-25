import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { input, select, password } from "@inquirer/prompts";
import chalk from "chalk";
import { WORKSPACE, FUNDS_DIR, SHARED_DIR } from "./paths.js";
import { saveGlobalConfig } from "./config.js";
import type { GlobalConfig } from "./types.js";

export const initCommand = new Command("init")
  .description("Initialize FundX workspace")
  .action(async () => {
    console.log(chalk.bold("\n  FundX — Workspace Setup\n"));

    if (existsSync(WORKSPACE)) {
      console.log(
        chalk.yellow(`  Workspace already exists at ${WORKSPACE}\n`),
      );
      return;
    }

    const timezone = await input({
      message: "Default timezone:",
      default: "UTC",
    });

    const defaultModel = await select({
      message: "Default Claude model:",
      choices: [
        { value: "sonnet", name: "Sonnet (balanced)" },
        { value: "opus", name: "Opus (most capable)" },
        { value: "haiku", name: "Haiku (fastest, cheapest)" },
      ],
    });

    const brokerProvider = await select({
      message: "Default broker:",
      choices: [
        { value: "alpaca", name: "Alpaca (stocks, ETFs)" },
        { value: "ibkr", name: "Interactive Brokers" },
        { value: "binance", name: "Binance (crypto)" },
        { value: "manual", name: "Manual (no auto-execution)" },
      ],
    });

    let apiKey: string | undefined;
    let secretKey: string | undefined;
    if (brokerProvider !== "manual") {
      apiKey = await password({ message: `${brokerProvider} API key:` });
      secretKey = await password({ message: `${brokerProvider} secret key:` });
    }

    const botToken = await password({
      message: "Telegram bot token (empty to skip):",
    });
    const chatId = botToken
      ? await input({ message: "Your Telegram chat ID:" })
      : undefined;

    const config: GlobalConfig = {
      default_model: defaultModel,
      timezone,
      broker: {
        provider: brokerProvider,
        api_key: apiKey,
        secret_key: secretKey,
        mode: "paper",
      },
      telegram: {
        bot_token: botToken || undefined,
        chat_id: chatId,
        enabled: !!botToken,
      },
    };

    await mkdir(WORKSPACE, { recursive: true });
    await mkdir(FUNDS_DIR, { recursive: true });
    await mkdir(join(SHARED_DIR, "templates"), { recursive: true });
    await saveGlobalConfig(config);

    console.log(chalk.green(`\n  ✓ Workspace initialized at ${WORKSPACE}`));
    console.log(
      chalk.dim("  Next: Run 'fundx fund create' to create your first fund.\n"),
    );
  });
