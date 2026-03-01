import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root workspace: ~/.fundx */
export const WORKSPACE = join(homedir(), ".fundx");

/** Global config file */
export const GLOBAL_CONFIG = join(WORKSPACE, "config.yaml");

/** Directory containing all funds */
export const FUNDS_DIR = join(WORKSPACE, "funds");

/** Daemon PID file */
export const DAEMON_PID = join(WORKSPACE, "daemon.pid");

/** Daemon log file */
export const DAEMON_LOG = join(WORKSPACE, "daemon.log");

/** Shared directory */
export const SHARED_DIR = join(WORKSPACE, "shared");

/** MCP server executables (resolved from dist/mcp at runtime) */
export const MCP_SERVERS = {
  brokerAlpaca: join(__dirname, "mcp", "broker-alpaca.js"),
  marketData: join(__dirname, "mcp", "market-data.js"),
  telegramNotify: join(__dirname, "mcp", "telegram-notify.js"),
};

/** Paths relative to a fund directory */
export function fundPaths(fundName: string) {
  const root = join(FUNDS_DIR, fundName);
  return {
    root,
    config: join(root, "fund_config.yaml"),
    claudeMd: join(root, "CLAUDE.md"),
    claudeDir: join(root, ".claude"),
    claudeSettings: join(root, ".claude", "settings.json"),
    state: {
      dir: join(root, "state"),
      portfolio: join(root, "state", "portfolio.json"),
      tracker: join(root, "state", "objective_tracker.json"),
      journal: join(root, "state", "trade_journal.sqlite"),
      sessionLog: join(root, "state", "session_log.json"),
      activeSession: join(root, "state", "active_session.json"),
      chatHistory: join(root, "state", "chat_history.json"),
    },
    analysis: join(root, "analysis"),
    scripts: join(root, "scripts"),
    reports: join(root, "reports"),
  };
}
