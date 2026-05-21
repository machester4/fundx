import { describe, it, expect, vi, beforeEach } from "vitest";

const mockedReaddir = vi.fn();
const mockedStat = vi.fn();
const mockedRm = vi.fn();

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises",
  );
  return {
    ...actual,
    readdir: (...args: unknown[]) => mockedReaddir(...args),
    stat: (...args: unknown[]) => mockedStat(...args),
    rm: (...args: unknown[]) => mockedRm(...args),
  };
});

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>(
    "../src/paths.js",
  );
  return {
    ...actual,
    FUNDS_DIR: "/test/.fundx/funds",
  };
});

import { sweepEvalOrphans } from "../src/services/eval/seed.js";

const NOW = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

function dirEntry(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockedRm.mockResolvedValue(undefined);
});

describe("sweepEvalOrphans", () => {
  it("removes only directories matching fundx-eval-* prefix, older than minAgeMs", async () => {
    mockedReaddir.mockResolvedValue([
      dirEntry("Growth", true),
      dirEntry("fundx-eval-old1", true),
      dirEntry("fundx-eval-old2", true),
      dirEntry("fundx-eval-fresh", true),
      dirEntry("notes.md", false),
    ]);
    mockedStat.mockImplementation(async (p: string) => {
      if (p.endsWith("fundx-eval-fresh")) return { mtimeMs: NOW - 5 * 60 * 1000 }; // 5 min — too fresh
      return { mtimeMs: NOW - 2 * HOUR_MS }; // 2 hours
    });

    const result = await sweepEvalOrphans({ minAgeMs: 30 * 60 * 1000 });

    expect(result.removed).toEqual(["fundx-eval-old1", "fundx-eval-old2"]);
    expect(result.kept).toEqual(["fundx-eval-fresh"]);
    expect(mockedRm).toHaveBeenCalledTimes(2);
    expect(mockedRm).toHaveBeenCalledWith(
      "/test/.fundx/funds/fundx-eval-old1",
      { recursive: true, force: true },
    );
    expect(mockedRm).toHaveBeenCalledWith(
      "/test/.fundx/funds/fundx-eval-old2",
      { recursive: true, force: true },
    );
  });

  it("never touches non-eval directories even if old", async () => {
    mockedReaddir.mockResolvedValue([
      dirEntry("Growth", true),
      dirEntry("runway-metal", true),
      dirEntry("prueba", true),
    ]);
    mockedStat.mockResolvedValue({ mtimeMs: NOW - 24 * HOUR_MS });

    const result = await sweepEvalOrphans();

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it("returns empty result when FUNDS_DIR does not exist", async () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockedReaddir.mockRejectedValue(err);

    const result = await sweepEvalOrphans();

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it("defaults to 30 minute minimum age", async () => {
    mockedReaddir.mockResolvedValue([
      dirEntry("fundx-eval-twenty-min", true),
      dirEntry("fundx-eval-forty-min", true),
    ]);
    mockedStat.mockImplementation(async (p: string) => {
      if (p.endsWith("twenty-min")) return { mtimeMs: NOW - 20 * 60 * 1000 };
      return { mtimeMs: NOW - 40 * 60 * 1000 };
    });

    const result = await sweepEvalOrphans();

    expect(result.removed).toEqual(["fundx-eval-forty-min"]);
    expect(result.kept).toEqual(["fundx-eval-twenty-min"]);
  });
});
