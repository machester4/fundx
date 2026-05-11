/**
 * Integration test: daemon real subprocess with accelerated cron tick
 *
 * Spawns a real `node dist/index.js --_daemon-mode` child process in an
 * isolated workspace (HOME override redirects homedir() to a tmpdir).
 * Validates:
 *  1. Daemon writes daemon.pid and daemon.heartbeat after startup
 *  2. Cron tick fires within seconds (using tick_interval_ms: 1000)
 *  3. Heartbeat mtime advances between samples (tick loop is alive)
 *  4. SIGTERM cleans up the PID file
 *
 * Isolation approach: HOME env override (Approach A)
 *   Node's os.homedir() respects the HOME env var, so setting HOME to a
 *   tmpdir in the spawned subprocess redirects all paths.ts WORKSPACE paths
 *   to the isolated directory without any code change to paths.ts.
 *
 * Prerequisite: dist/index.js must be built (`pnpm build`).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import yaml from "js-yaml";

describe("integration: daemon real subprocess + accelerated cron tick", () => {
  let workspace: string;
  let fundxHome: string;
  let daemon: ChildProcess | null = null;

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "fundx-daemon-int-"));
    fundxHome = path.join(workspace, ".fundx");
    await mkdir(fundxHome, { recursive: true });

    // Global config: fast tick interval so we don't wait 60s for the normal
    // cron to fire. daemon.tick_interval_ms: 1000 → setInterval every 1s.
    await writeFile(
      path.join(fundxHome, "config.yaml"),
      yaml.dump({
        default_model: "sonnet",
        daemon: { tick_interval_ms: 1000 },
        market_data: { provider: "yfinance" },
        // No telegram config → gateway.startGateway() returns null (safe)
      }),
      "utf-8",
    );
  });

  afterAll(async () => {
    // Ensure daemon is killed even if the test assertion throws
    if (daemon && !daemon.killed) {
      daemon.kill("SIGTERM");
      // Give it a moment to clean up before we wipe the directory
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (workspace) await rm(workspace, { recursive: true, force: true });
  });

  it(
    "daemon writes pid + heartbeat; tick fires; SIGTERM cleans up",
    async () => {
      const distEntry = path.join(process.cwd(), "dist/index.js");

      // Guard: if dist is missing, fail with a clear hint rather than a cryptic
      // ENOENT from spawn.
      if (!existsSync(distEntry)) {
        throw new Error(
          `dist/index.js not found — run 'pnpm build' before executing integration tests.\n` +
          `Expected: ${distEntry}`,
        );
      }

      // HOME override redirects homedir() → workspace so all paths.ts WORKSPACE
      // constants resolve to the isolated fundxHome directory.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: workspace,
        // Suppress news IPC and zvec writes to the isolated dir (NEWS_DIR defaults
        // to WORKSPACE/news; NEWS_IPC_SOCKET defaults to WORKSPACE/news.sock).
        // These are already isolated via HOME, but we also set FUNDX_NEWS_SOCKET
        // to ensure the socket path lands inside the isolated dir.
        FUNDX_NEWS_SOCKET: path.join(fundxHome, "news.sock"),
        FUNDX_NEWS_DIR: path.join(fundxHome, "news"),
        // Watchlist DB also isolated
        FUNDX_WATCHLIST_DB_PATH: path.join(fundxHome, "state", "watchlist.sqlite"),
      };

      daemon = spawn("node", [distEntry, "--_daemon-mode"], {
        env,
        stdio: "pipe",
        detached: false,
      });

      // Capture stderr for debugging on failure (not printed during normal runs)
      const stderrLines: string[] = [];
      daemon.stderr?.on("data", (chunk: Buffer) => {
        stderrLines.push(chunk.toString());
      });

      const pidPath = path.join(fundxHome, "daemon.pid");
      const heartbeatPath = path.join(fundxHome, "daemon.heartbeat");

      // ── 1. Wait for daemon.pid (max 8s, poll every 100ms) ────────────────
      let pidExists = false;
      for (let i = 0; i < 80; i++) {
        if (existsSync(pidPath)) {
          pidExists = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(pidExists, `daemon.pid should exist within 8s\nstderr:\n${stderrLines.join("")}`).toBe(true);

      // ── 2. Wait for daemon.heartbeat (max 5s) ────────────────────────────
      let heartbeatExists = false;
      for (let i = 0; i < 50; i++) {
        if (existsSync(heartbeatPath)) {
          heartbeatExists = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(
        heartbeatExists,
        `daemon.heartbeat should exist within 5s\nstderr:\n${stderrLines.join("")}`,
      ).toBe(true);

      // Sample heartbeat mtime before waiting for tick
      const heartbeatStat1 = await stat(heartbeatPath);

      // ── 3. Wait 3s — tick interval is 1000ms, heartbeat is updated every
      //       tick via updateHeartbeat(). Expect mtime to advance at least once.
      await new Promise((r) => setTimeout(r, 3000));
      const heartbeatStat2 = await stat(heartbeatPath);
      expect(
        heartbeatStat2.mtimeMs,
        "Heartbeat mtime should advance between samples (tick loop alive)",
      ).toBeGreaterThan(heartbeatStat1.mtimeMs);

      // ── 4. SIGTERM → cleanup removes daemon.pid ───────────────────────────
      daemon.kill("SIGTERM");
      // Wait for cleanup() which calls unlink(DAEMON_PID) then process.exit(0)
      await new Promise((r) => setTimeout(r, 2500));
      expect(
        existsSync(pidPath),
        `daemon.pid should be removed after SIGTERM\nstderr:\n${stderrLines.join("")}`,
      ).toBe(false);

      // Mark as killed so afterAll doesn't try again
      daemon = null;
    },
    20_000, // 20s total budget
  );
});
