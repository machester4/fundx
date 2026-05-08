import { describe, it, expect } from "vitest";
import { evaluateHeartbeatStaleness } from "../src/services/supervisor.service.js";

const NOW = 1_000_000_000_000;

describe("evaluateHeartbeatStaleness", () => {
  it("returns notStale when heartbeat is fresh (< 3 min old)", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: NOW - 60_000,  // 1 min old
      heartbeatExists: true,
      daemonLaunchedAt: NOW - 600_000,
      daemonRunning: true,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(false);
    expect(result.shouldRecover).toBe(false);
  });

  it("returns shouldAlert when heartbeat is stale (> 3 min) and not previously alerted", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: NOW - 4 * 60_000,  // 4 min old
      heartbeatExists: true,
      daemonLaunchedAt: NOW - 600_000,
      daemonRunning: true,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(true);
    expect(result.shouldRecover).toBe(false);
    expect(result.ageMs).toBe(4 * 60_000);
  });

  it("does not re-alert when already alerted", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: NOW - 4 * 60_000,
      heartbeatExists: true,
      daemonLaunchedAt: NOW - 600_000,
      daemonRunning: true,
      previouslyAlerted: true,
    });
    expect(result.shouldAlert).toBe(false);
    expect(result.shouldRecover).toBe(false);
  });

  it("returns shouldRecover when stale flag was set but heartbeat is now fresh", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: NOW - 60_000,
      heartbeatExists: true,
      daemonLaunchedAt: NOW - 600_000,
      daemonRunning: true,
      previouslyAlerted: true,
    });
    expect(result.shouldAlert).toBe(false);
    expect(result.shouldRecover).toBe(true);
  });

  it("does not alert when heartbeat missing but daemon recently launched (grace period)", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: 0,
      heartbeatExists: false,
      daemonLaunchedAt: NOW - 60_000,  // launched 1 min ago
      daemonRunning: true,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(false);
  });

  it("alerts when heartbeat missing and daemon running > 3 min", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: 0,
      heartbeatExists: false,
      daemonLaunchedAt: NOW - 4 * 60_000,
      daemonRunning: true,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(true);
  });

  it("does not alert when daemon is not running", () => {
    const result = evaluateHeartbeatStaleness({
      now: NOW,
      heartbeatMtimeMs: 0,
      heartbeatExists: false,
      daemonLaunchedAt: NOW - 4 * 60_000,
      daemonRunning: false,
      previouslyAlerted: false,
    });
    expect(result.shouldAlert).toBe(false);
  });
});
