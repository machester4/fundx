import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { WORKSPACE, GLOBAL_CONFIG, FUNDS_DIR, DAEMON_PID, DAEMON_LOG, fundPaths } from "../src/paths.js";

describe("path constants", () => {
  const home = homedir();

  it("WORKSPACE points to ~/.fundx", () => {
    expect(WORKSPACE).toBe(join(home, ".fundx"));
  });

  it("GLOBAL_CONFIG points to ~/.fundx/config.yaml", () => {
    expect(GLOBAL_CONFIG).toBe(join(home, ".fundx", "config.yaml"));
  });

  it("FUNDS_DIR points to ~/.fundx/funds", () => {
    expect(FUNDS_DIR).toBe(join(home, ".fundx", "funds"));
  });

  it("DAEMON_PID points to ~/.fundx/daemon.pid", () => {
    expect(DAEMON_PID).toBe(join(home, ".fundx", "daemon.pid"));
  });

  it("DAEMON_LOG points to ~/.fundx/daemon.log", () => {
    expect(DAEMON_LOG).toBe(join(home, ".fundx", "daemon.log"));
  });
});

describe("fundPaths", () => {
  const home = homedir();

  it("returns correct paths for a fund", () => {
    const paths = fundPaths("my-fund");
    expect(paths.root).toBe(join(home, ".fundx", "funds", "my-fund"));
    expect(paths.config).toBe(join(home, ".fundx", "funds", "my-fund", "fund_config.yaml"));
    expect(paths.claudeMd).toBe(join(home, ".fundx", "funds", "my-fund", "CLAUDE.md"));
  });

  it("returns correct state paths", () => {
    const paths = fundPaths("test");
    const fundRoot = join(home, ".fundx", "funds", "test");
    expect(paths.state.dir).toBe(join(fundRoot, "state"));
    expect(paths.state.portfolio).toBe(join(fundRoot, "state", "portfolio.json"));
    expect(paths.state.tracker).toBe(join(fundRoot, "state", "objective_tracker.json"));
    expect(paths.state.journal).toBe(join(fundRoot, "state", "trade_journal.sqlite"));
    expect(paths.state.sessionLog).toBe(join(fundRoot, "state", "session_log.json"));
  });

  it("returns correct auxiliary paths", () => {
    const paths = fundPaths("alpha");
    const fundRoot = join(home, ".fundx", "funds", "alpha");
    expect(paths.analysis).toBe(join(fundRoot, "analysis"));
    expect(paths.scripts).toBe(join(fundRoot, "scripts"));
    expect(paths.reports).toBe(join(fundRoot, "reports"));
  });
});
