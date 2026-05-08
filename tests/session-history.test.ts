import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendSessionLogEntry,
  readTodaysSessionUsage,
  pruneSessionLogJsonl,
} from "../src/services/session-history.service.js";
import type { SessionLogV2 } from "../src/types.js";

const FUND = "fundx-history-test";
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

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `fundx-history-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(tmpRoot, "funds", FUND, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const mkLog = (overrides: Partial<SessionLogV2> = {}): SessionLogV2 => ({
  fund: FUND,
  session_type: "pre_market",
  started_at: new Date().toISOString(),
  trades_executed: 0,
  summary: "",
  cost_usd: 0.5,
  status: "success",
  ...overrides,
});

describe("appendSessionLogEntry + readTodaysSessionUsage", () => {
  it("appends a single entry and reads it back as today's usage", async () => {
    const log = mkLog({ cost_usd: 1.23 });
    await appendSessionLogEntry(FUND, log);

    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(1);
    expect(usage.totalUsd).toBeCloseTo(1.23, 2);
    expect(usage.entries).toHaveLength(1);
  });

  it("aggregates multiple appends in order", async () => {
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 0.5 }));
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 0.7 }));
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 1.0 }));

    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(3);
    expect(usage.totalUsd).toBeCloseTo(2.2, 2);
    expect(usage.entries[0].cost_usd).toBe(0.5);
    expect(usage.entries[2].cost_usd).toBe(1.0);
  });

  it("excludes entries from previous days (filter by started_at)", async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 0.5, started_at: yesterday }));
    await appendSessionLogEntry(FUND, mkLog({ cost_usd: 0.7 }));

    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(1);
    expect(usage.totalUsd).toBeCloseTo(0.7, 2);
  });

  it("returns zero usage when no JSONL file exists", async () => {
    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(0);
    expect(usage.totalUsd).toBe(0);
    expect(usage.entries).toHaveLength(0);
  });

  it("skips malformed lines without crashing", async () => {
    const path = join(tmpRoot, "funds", FUND, "state", "session_log.jsonl");
    const goodLine = JSON.stringify(mkLog({ cost_usd: 1.0 }));
    const badLine = "{ this is not json";
    await writeFile(path, `${goodLine}\n${badLine}\n`, "utf-8");

    const usage = await readTodaysSessionUsage(FUND);
    expect(usage.sessionCount).toBe(1);
    expect(usage.totalUsd).toBeCloseTo(1.0, 2);
  });
});

describe("pruneSessionLogJsonl", () => {
  it("removes entries older than retentionDays", async () => {
    const old = new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString();
    const recent = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    await appendSessionLogEntry(FUND, mkLog({ started_at: old }));
    await appendSessionLogEntry(FUND, mkLog({ started_at: recent }));

    await pruneSessionLogJsonl(FUND, 90);

    const path = join(tmpRoot, "funds", FUND, "state", "session_log.jsonl");
    const content = await readFile(path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).started_at).toBe(recent);
  });
});
