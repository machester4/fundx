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

  // ── OS suspension detection ─────────────────────────────────
  // When the laptop sleeps, BOTH supervisor and daemon are suspended.
  // On wake, the heartbeat looks ancient but the daemon will catch up on
  // its next cron tick. Suppress the (false) alert on the wake-up tick.
  describe("OS suspension suppression", () => {
    it("flags suspectedSuspension and suppresses alert when wallClockDeltaMs exceeds threshold", () => {
      const result = evaluateHeartbeatStaleness({
        now: NOW,
        heartbeatMtimeMs: NOW - 30 * 60_000, // 30 min old
        heartbeatExists: true,
        daemonLaunchedAt: NOW - 60 * 60_000,
        daemonRunning: true,
        previouslyAlerted: false,
        wallClockDeltaMs: 30 * 60_000, // tick took 30 min → process was suspended
        intervalMs: 60_000,
      });
      expect(result.suspectedSuspension).toBe(true);
      expect(result.stale).toBe(true);
      expect(result.shouldAlert).toBe(false); // alert suppressed
    });

    it("still alerts when wallClockDelta is normal (no suspension) and heartbeat is stale", () => {
      const result = evaluateHeartbeatStaleness({
        now: NOW,
        heartbeatMtimeMs: NOW - 5 * 60_000,
        heartbeatExists: true,
        daemonLaunchedAt: NOW - 60 * 60_000,
        daemonRunning: true,
        previouslyAlerted: false,
        wallClockDeltaMs: 60_000, // normal tick — supervisor was awake
        intervalMs: 60_000,
      });
      expect(result.suspectedSuspension).toBe(false);
      expect(result.shouldAlert).toBe(true);
    });

    it("suspension threshold is exactly 2x interval (strictly greater triggers)", () => {
      // At exactly 2x interval: NOT suspended
      const atThreshold = evaluateHeartbeatStaleness({
        now: NOW,
        heartbeatMtimeMs: NOW - 5 * 60_000,
        heartbeatExists: true,
        daemonLaunchedAt: NOW - 60 * 60_000,
        daemonRunning: true,
        previouslyAlerted: false,
        wallClockDeltaMs: 120_000,
        intervalMs: 60_000,
      });
      expect(atThreshold.suspectedSuspension).toBe(false);

      // Just above 2x interval: suspended
      const aboveThreshold = evaluateHeartbeatStaleness({
        now: NOW,
        heartbeatMtimeMs: NOW - 5 * 60_000,
        heartbeatExists: true,
        daemonLaunchedAt: NOW - 60 * 60_000,
        daemonRunning: true,
        previouslyAlerted: false,
        wallClockDeltaMs: 120_001,
        intervalMs: 60_000,
      });
      expect(aboveThreshold.suspectedSuspension).toBe(true);
    });

    it("legacy callers (no wallClockDeltaMs) keep current behaviour — no suppression", () => {
      const result = evaluateHeartbeatStaleness({
        now: NOW,
        heartbeatMtimeMs: NOW - 4 * 60_000,
        heartbeatExists: true,
        daemonLaunchedAt: NOW - 60 * 60_000,
        daemonRunning: true,
        previouslyAlerted: false,
        // no wallClockDeltaMs / intervalMs
      });
      expect(result.suspectedSuspension).toBe(false);
      expect(result.shouldAlert).toBe(true);
    });

    it("does NOT block recovery: still recovers from previouslyAlerted on a fresh heartbeat even mid-suspension flag", () => {
      const result = evaluateHeartbeatStaleness({
        now: NOW,
        heartbeatMtimeMs: NOW - 30_000, // fresh
        heartbeatExists: true,
        daemonLaunchedAt: NOW - 60 * 60_000,
        daemonRunning: true,
        previouslyAlerted: true,
        wallClockDeltaMs: 30 * 60_000, // we were suspended
        intervalMs: 60_000,
      });
      expect(result.suspectedSuspension).toBe(true);
      expect(result.shouldRecover).toBe(true);
    });
  });
});
