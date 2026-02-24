import { writeFile, mkdir } from "node:fs/promises";
import { loadFundConfig } from "./fund.js";
import { loadGlobalConfig } from "./config.js";
import { fundPaths, MCP_SERVERS } from "./paths.js";

/**
 * Write .claude/settings.json for a fund so Claude Code can use MCP servers.
 * Called before each session to ensure config is up-to-date.
 *
 * Extracted to its own module to avoid circular dependencies between
 * session.ts and subagent.ts.
 */
export async function writeMcpSettings(fundName: string): Promise<void> {
  const paths = fundPaths(fundName);
  const globalConfig = await loadGlobalConfig();
  const fundConfig = await loadFundConfig(fundName);

  const brokerEnv: Record<string, string> = {};
  if (globalConfig.broker.api_key) brokerEnv.ALPACA_API_KEY = globalConfig.broker.api_key;
  if (globalConfig.broker.secret_key) brokerEnv.ALPACA_SECRET_KEY = globalConfig.broker.secret_key;
  brokerEnv.ALPACA_MODE = fundConfig.broker.mode ?? globalConfig.broker.mode ?? "paper";

  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    "broker-alpaca": {
      command: "node",
      args: [MCP_SERVERS.brokerAlpaca],
      env: brokerEnv,
    },
    "market-data": {
      command: "node",
      args: [MCP_SERVERS.marketData],
      env: brokerEnv,
    },
  };

  // Add telegram-notify MCP server if Telegram is configured
  if (
    globalConfig.telegram.bot_token &&
    globalConfig.telegram.chat_id &&
    fundConfig.notifications.telegram.enabled
  ) {
    const telegramEnv: Record<string, string> = {
      TELEGRAM_BOT_TOKEN: globalConfig.telegram.bot_token,
      TELEGRAM_CHAT_ID: globalConfig.telegram.chat_id,
    };
    if (fundConfig.notifications.quiet_hours.enabled) {
      telegramEnv.QUIET_HOURS_START = fundConfig.notifications.quiet_hours.start;
      telegramEnv.QUIET_HOURS_END = fundConfig.notifications.quiet_hours.end;
    }
    mcpServers["telegram-notify"] = {
      command: "node",
      args: [MCP_SERVERS.telegramNotify],
      env: telegramEnv,
    };
  }

  const settings = { mcpServers };

  await mkdir(paths.claudeDir, { recursive: true });
  await writeFile(paths.claudeSettings, JSON.stringify(settings, null, 2), "utf-8");
}
