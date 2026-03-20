import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("node:child_process", () => ({
  fork: vi.fn().mockReturnValue({
    pid: 12345,
    on: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
  }),
  spawn: vi.fn().mockReturnValue({
    pid: 99999,
    unref: vi.fn(),
  }),
}));

vi.mock("../src/services/daemon.service.js", () => ({
  isDaemonRunning: vi.fn().mockResolvedValue(false),
  notifyDaemonEvent: vi.fn().mockResolvedValue(undefined),
}));

import { getBackoffDelay, shouldGiveUp } from "../src/services/supervisor.service.js";

describe("supervisor", () => {
  it("calculates exponential backoff", () => {
    expect(getBackoffDelay(0)).toBe(2000);
    expect(getBackoffDelay(1)).toBe(4000);
    expect(getBackoffDelay(2)).toBe(8000);
    expect(getBackoffDelay(3)).toBe(16000);
    expect(getBackoffDelay(4)).toBe(32000);
  });

  it("gives up after 5 restarts in 10 minutes", () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 5 }, (_, i) => now - (5 - i) * 60 * 1000);
    expect(shouldGiveUp(timestamps, now)).toBe(true);
  });

  it("does not give up with fewer than 5 restarts", () => {
    const now = Date.now();
    const timestamps = [now - 60000, now - 30000];
    expect(shouldGiveUp(timestamps, now)).toBe(false);
  });

  it("does not give up when restarts are spread over > 10 minutes", () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 5 }, (_, i) => now - (20 - i * 3) * 60 * 1000);
    expect(shouldGiveUp(timestamps, now)).toBe(false);
  });
});
