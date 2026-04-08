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

/** Supervisor PID file */
export const SUPERVISOR_PID = join(WORKSPACE, "supervisor.pid");

/** Daemon heartbeat file */
export const DAEMON_HEARTBEAT = join(WORKSPACE, "daemon.heartbeat");

/** Max daemon log size before rotation (5 MB) */
export const DAEMON_LOG_MAX_SIZE = 5 * 1024 * 1024;

/** Max number of rotated log files to keep */
export const DAEMON_LOG_MAX_FILES = 3;

/** News cache directory (zvec database) */
export const NEWS_DIR = join(WORKSPACE, "news");

/** Shared directory */
export const SHARED_DIR = join(WORKSPACE, "shared");

/** Workspace-level CLAUDE.md (loaded automatically by Agent SDK via settingSources: ["project"]) */
export const WORKSPACE_CLAUDE_MD = join(WORKSPACE, "CLAUDE.md");

/** Workspace-level .claude directory */
export const WORKSPACE_CLAUDE_DIR = join(WORKSPACE, ".claude");

/** Workspace-level skills directory (.claude/skills/<name>/SKILL.md) */
export const WORKSPACE_SKILLS_DIR = join(WORKSPACE, ".claude", "skills");

/** Workspace-level rules directory (.claude/rules/*.md) */
export const WORKSPACE_RULES_DIR = join(WORKSPACE, ".claude", "rules");

/**
 * Whether we're running in dev mode (tsx) vs production (compiled JS).
 * In dev, __dirname is src/ and MCP files are .ts; in prod, __dirname is dist/ and files are .js.
 */
export const IS_DEV = __dirname.endsWith("/src") || __dirname.endsWith("\\src");

/** MCP server executables (resolved relative to __dirname) */
export const MCP_SERVERS = {
  brokerLocal: join(__dirname, "mcp", IS_DEV ? "broker-local.ts" : "broker-local.js"),
  marketData: join(__dirname, "mcp", IS_DEV ? "market-data.ts" : "market-data.js"),
  telegramNotify: join(__dirname, "mcp", IS_DEV ? "telegram-notify.ts" : "telegram-notify.js"),
  sws: join(__dirname, "mcp", IS_DEV ? "sws.ts" : "sws.js"),
};

/** Command to run MCP server files (tsx for .ts in dev, node for .js in prod) */
export const MCP_COMMAND = IS_DEV
  ? join(__dirname, "..", "node_modules", ".bin", "tsx")
  : "node";

/** Paths relative to a fund directory */
export function fundPaths(fundName: string) {
  const root = join(FUNDS_DIR, fundName);
  return {
    root,
    config: join(root, "fund_config.yaml"),
    claudeMd: join(root, "CLAUDE.md"),
    claudeDir: join(root, ".claude"),
    claudeSettings: join(root, ".claude", "settings.json"),
    claudeSkillsDir: join(root, ".claude", "skills"),
    claudeRulesDir: join(root, ".claude", "rules"),
    state: {
      dir: join(root, "state"),
      portfolio: join(root, "state", "portfolio.json"),
      tracker: join(root, "state", "objective_tracker.json"),
      journal: join(root, "state", "trade_journal.sqlite"),
      sessionLog: join(root, "state", "session_log.json"),
      activeSession: join(root, "state", "active_session.json"),
      chatHistory: join(root, "state", "chat_history.json"),
      sessionHistory: join(root, "state", "session_history.json"),
      lock: join(root, "state", ".lock"),
      pendingSessions: join(root, "state", "pending_sessions.json"),
      sessionCounts: join(root, "state", "session_counts.json"),
      sessionHandoff: join(root, "state", "session-handoff.md"),
    },
    analysis: join(root, "analysis"),
    scripts: join(root, "scripts"),
    reports: join(root, "reports"),
    memory: join(root, "memory"),
  };
}
