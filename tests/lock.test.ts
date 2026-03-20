import { describe, it, expect, vi, beforeEach } from "vitest";
import { vol } from "memfs";

vi.mock("node:fs/promises", async () => {
  const memfs = await import("memfs");
  return memfs.fs.promises;
});
vi.mock("node:fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

vi.mock("../src/paths.js", () => ({
  fundPaths: (name: string) => ({
    state: {
      lock: `/mock/.fundx/funds/${name}/state/.lock`,
    },
  }),
}));

import { acquireFundLock, releaseFundLock, isLockStale, withTimeout } from "../src/lock.js";

beforeEach(() => {
  vol.reset();
  vol.mkdirSync("/mock/.fundx/funds/test-fund/state", { recursive: true });
});

describe("acquireFundLock", () => {
  it("acquires lock when no lock file exists", async () => {
    const acquired = await acquireFundLock("test-fund", "pre_market");
    expect(acquired).toBe(true);
  });

  it("returns false when lock already held by live process", async () => {
    await acquireFundLock("test-fund", "pre_market");
    const second = await acquireFundLock("test-fund", "mid_session");
    expect(second).toBe(false);
  });
});

describe("releaseFundLock", () => {
  it("removes the lock file", async () => {
    await acquireFundLock("test-fund", "pre_market");
    await releaseFundLock("test-fund");
    const reacquired = await acquireFundLock("test-fund", "pre_market");
    expect(reacquired).toBe(true);
  });

  it("does not throw if lock does not exist", async () => {
    await expect(releaseFundLock("test-fund")).resolves.not.toThrow();
  });
});

describe("isLockStale", () => {
  it("returns false when no lock exists", async () => {
    expect(await isLockStale("test-fund")).toBe(false);
  });

  it("returns true when lock is older than 25 minutes", async () => {
    await acquireFundLock("test-fund", "pre_market");
    const oldTime = new Date(Date.now() - 26 * 60 * 1000).toISOString();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      "/mock/.fundx/funds/test-fund/state/.lock",
      JSON.stringify({ pid: process.pid, session: "pre_market", since: oldTime }),
    );
    expect(await isLockStale("test-fund")).toBe(true);
  });
});

describe("withTimeout", () => {
  it("resolves when promise completes before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });

  it("rejects when promise exceeds timeout", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5000));
    await expect(withTimeout(slow, 50)).rejects.toThrow("timed out");
  });
});
