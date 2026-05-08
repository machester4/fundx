import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FUND = "fundx-cap-integration";
let tmpRoot: string;

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => {
      const root = join(tmpRoot, "funds", name);
      return {
        ...actual.fundPaths(name),
        root,
        state: {
          ...actual.fundPaths(name).state,
          dir: join(root, "state"),
          sessionLogJsonl: join(root, "state", "session_log.jsonl"),
          dailyCapState: join(root, "state", "daily_cap_state.json"),
        },
      };
    },
  };
});

const notifyMock = vi.fn();
vi.mock("../src/services/daemon.service.js", () => ({
  notifyDaemonEvent: (...args: unknown[]) => notifyMock(...args),
}));

import { appendSessionLogEntry } from "../src/services/session-history.service.js";
import { checkDailyCap } from "../src/services/session.service.js";
import type { SessionLogV2 } from "../src/types.js";

const mkLog = (cost: number): SessionLogV2 => ({
  fund: FUND,
  session_type: "pre_market",
  started_at: new Date().toISOString(),
  trades_executed: 0,
  summary: "",
  cost_usd: cost,
  status: "success",
});

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `fundx-cap-int-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(tmpRoot, "funds", FUND, "state"), { recursive: true });
  notifyMock.mockReset();
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("checkDailyCap", () => {
  it("returns allowed=true when total below cap", async () => {
    await appendSessionLogEntry(FUND, mkLog(2.0));
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed=false when total at cap", async () => {
    await appendSessionLogEntry(FUND, mkLog(5.0));
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(false);
    expect(result.usage.totalUsd).toBeCloseTo(5.0);
  });

  it("returns allowed=false when total above cap", async () => {
    await appendSessionLogEntry(FUND, mkLog(3.0));
    await appendSessionLogEntry(FUND, mkLog(2.5));
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(false);
    expect(result.usage.totalUsd).toBeCloseTo(5.5);
  });

  it("ignores entries from previous days", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await appendSessionLogEntry(FUND, { ...mkLog(10), started_at: yesterday });
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(true);
  });

  it("does not crash on missing JSONL file", async () => {
    const result = await checkDailyCap(FUND, 5);
    expect(result.allowed).toBe(true);
    expect(result.usage.totalUsd).toBe(0);
  });
});
