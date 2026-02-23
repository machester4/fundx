import { homedir } from "node:os";
import { join } from "node:path";

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

/** Paths relative to a fund directory */
export function fundPaths(fundName: string) {
  const root = join(FUNDS_DIR, fundName);
  return {
    root,
    config: join(root, "fund_config.yaml"),
    claudeMd: join(root, "CLAUDE.md"),
    state: {
      dir: join(root, "state"),
      portfolio: join(root, "state", "portfolio.json"),
      tracker: join(root, "state", "objective_tracker.json"),
      journal: join(root, "state", "trade_journal.sqlite"),
      sessionLog: join(root, "state", "session_log.json"),
    },
    analysis: join(root, "analysis"),
    scripts: join(root, "scripts"),
    reports: join(root, "reports"),
  };
}
