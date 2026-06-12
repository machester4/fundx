import { describe, it, expect, beforeEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = join(tmpdir(), `fundx-verdicts-test-${Date.now()}`);

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => ({
      root: join(tmpRoot, "funds", name),
      state: {
        dir: join(tmpRoot, "funds", name, "state"),
        verdicts: join(tmpRoot, "funds", name, "state", "verdicts.json"),
      },
    }),
  };
});

import { readVerdicts, writeVerdicts } from "../src/state.js";

beforeEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("verdict persistence state CRUD", () => {
  it("returns [] when the file does not exist", async () => {
    expect(await readVerdicts("nofund")).toEqual([]);
  });

  it("round-trips verdicts and drops malformed entries", async () => {
    const v = {
      ticker: "GLD",
      side: "buy" as const,
      source: "risk-guardian" as const,
      recommendation: "APPROVED" as const,
      approved: true,
      observedAt: 1_750_000_000_000,
    };
    await writeVerdicts("f1", [v, { garbage: true } as never]);
    expect(await readVerdicts("f1")).toEqual([v]);
  });
});
