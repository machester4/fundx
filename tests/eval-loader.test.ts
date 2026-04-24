import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEvalCases, filterCases } from "../src/services/eval/loader.js";

async function scratchRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "eval-loader-"));
  await mkdir(join(root, "cases"), { recursive: true });
  await mkdir(join(root, "fixtures"), { recursive: true });
  return { root, cleanup: async () => rm(root, { recursive: true, force: true }) };
}

describe("loadEvalCases", () => {
  it("loads a single valid case with no fixture base", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      await writeFile(join(root, "cases", "mvp-x.yaml"), `
id: mvp-x
description: Test case x
prompt: hello
fund_state:
  portfolio: { cash: 1000 }
expect:
  must_invoke: [foo]
runs: 3
threshold: 2
`);
      const cases = await loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") });
      expect(cases).toHaveLength(1);
      expect(cases[0].id).toBe("mvp-x");
      expect(cases[0].fund_state.portfolio.cash).toBe(1000);
    } finally {
      await cleanup();
    }
  });

  it("resolves a fixture base and allows overrides", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      await writeFile(join(root, "fixtures", "base.yaml"), `
id: base
fund_config: { objective: runway }
portfolio: { cash: 5000 }
watchlist:
  - ticker: NVDA
    status: candidate
`);
      await writeFile(join(root, "cases", "case.yaml"), `
id: case
description: test
prompt: hi
fund_state:
  base: base
  portfolio: { cash: 9999 }
expect: {}
`);
      const cases = await loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") });
      expect(cases).toHaveLength(1);
      expect(cases[0].fund_state.portfolio.cash).toBe(9999);
      expect(cases[0].fund_state.watchlist).toHaveLength(1);
      expect(cases[0].fund_state.watchlist[0].ticker).toBe("NVDA");
    } finally {
      await cleanup();
    }
  });

  it("throws on unknown fixture base", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      await writeFile(join(root, "cases", "c.yaml"), `
id: c
description: d
prompt: p
fund_state: { base: nope, portfolio: { cash: 0 } }
expect: {}
`);
      await expect(
        loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") }),
      ).rejects.toThrow(/unknown fixture/i);
    } finally {
      await cleanup();
    }
  });

  it("throws on duplicate case IDs", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      const body = `
id: dup
description: d
prompt: p
fund_state: { portfolio: { cash: 0 } }
expect: {}
`;
      await writeFile(join(root, "cases", "a.yaml"), body);
      await writeFile(join(root, "cases", "b.yaml"), body);
      await expect(
        loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") }),
      ).rejects.toThrow(/duplicate.*id.*dup/i);
    } finally {
      await cleanup();
    }
  });

  it("throws on schema violation with file path in message", async () => {
    const { root, cleanup } = await scratchRepo();
    try {
      await writeFile(join(root, "cases", "bad.yaml"), `
id: BAD-ID-UPPER
description: d
prompt: p
fund_state: { portfolio: { cash: 0 } }
expect: {}
`);
      await expect(
        loadEvalCases({ casesDir: join(root, "cases"), fixturesDir: join(root, "fixtures") }),
      ).rejects.toThrow(/bad\.yaml/);
    } finally {
      await cleanup();
    }
  });
});

describe("filterCases", () => {
  const makeCase = (id: string) => ({
    id, description: "", prompt: "p",
    language: "es" as const,
    fund_state: {
      portfolio: { cash: 0, positions: [] },
      fund_config: {},
      tracker: { progress_pct: 0, status: "on_track" as const },
      watchlist: [],
    },
    expect: { must_invoke: [], must_not_invoke: [] },
    runs: 3,
    threshold: 2,
  });

  it("returns all when no filter supplied", () => {
    const all = [makeCase("a"), makeCase("b"), makeCase("mvp-c")];
    expect(filterCases(all, {})).toEqual(all);
  });

  it("filters by exact case id", () => {
    const all = [makeCase("a"), makeCase("b")];
    const filtered = filterCases(all, { case: "a" });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("a");
  });

  it("filters by substring pattern", () => {
    const all = [makeCase("mvp-a"), makeCase("mvp-b"), makeCase("backlog-c")];
    const filtered = filterCases(all, { filter: "mvp-" });
    expect(filtered).toHaveLength(2);
  });

  it("throws on --case with no match", () => {
    const all = [makeCase("a")];
    expect(() => filterCases(all, { case: "missing" })).toThrow(/no case matching/i);
  });
});
