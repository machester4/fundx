/**
 * Integration test: runMetaReflection end-to-end with mocked SDK
 *
 * Validates the full meta-reflection orchestration cycle:
 *  1. Lists archived handoffs since cursor
 *  2. Calls runFundSession with the promptBuilder override
 *  3. Advances the cursor and writes a `success` tracker
 *  4. On second run with no new handoffs: writes `no_data`, skips SDK call
 *
 * Isolation strategy:
 *  - process.env.FUNDX_HOME is set to a per-test tmpdir. fundPaths() reads
 *    FUNDX_HOME at call-time, so all fs operations land in the tmpdir with no
 *    paths.js mock required.
 *  - session.service.js is mocked to avoid real SDK calls. The stub writes a
 *    fake lesson to market-lessons.md (simulating what the agent would do).
 *  - fund.service.js and config.js are mocked to return minimal valid configs.
 *  - state.ts and journal.ts are NOT mocked — they use fundPaths() which
 *    already redirects to the tmpdir. openJournal() auto-creates an empty DB.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Set env key before vi.mock factories are hoisted ─────────────────────────
//    vi.mock factories run synchronously at module eval time (after hoisting).
//    process.env is a live object, so factories that reference it at call-time
//    (not at factory-definition time) will see the correct value set by beforeEach.
process.env["FUNDX_HOME"] = join(tmpdir(), `fundx-meta-ref-${process.pid}`);

// ── Mock session.service.js ───────────────────────────────────────────────────
//    Replace runFundSession with a stub that simulates the agent writing one
//    lesson to memory/market-lessons.md (the primary side-effect we assert on).
//    Also expose resolveDailyCapUsd + checkDailyCap so the cap-check passes.
vi.mock("../../src/services/session.service.js", () => ({
  runFundSession: vi.fn(async (fundName: string) => {
    const memoryDir = join(
      process.env["FUNDX_HOME"]!,
      "funds",
      fundName,
      "memory",
    );
    const target = join(memoryDir, "market-lessons.md");
    const prior = await readFile(target, "utf-8");
    await writeFile(
      target,
      prior + "\n## 2026-05-08 — Test Lesson\n\nMocked lesson body.\n",
    );
  }),
  resolveDailyCapUsd: vi.fn(() => 20),
  checkDailyCap: vi.fn(async () => ({ allowed: true })),
}));

// ── Mock fund.service.js ──────────────────────────────────────────────────────
vi.mock("../../src/services/fund.service.js", () => ({
  loadFundConfig: vi.fn(async () => ({
    fund: {
      name: "test-fund",
      display_name: "Test Fund",
      description: "Integration test fund",
      created: "2026-01-01",
      status: "active",
    },
    capital: { initial: 10_000, currency: "USD" },
    objective: { type: "growth", target_multiple: 2 },
    risk: { profile: "moderate", max_drawdown_pct: 15, max_position_pct: 25 },
    universe: {
      preset: "sp500",
      include_tickers: [],
      exclude_tickers: [],
      exclude_sectors: [],
    },
    schedule: { sessions: {} },
    broker: { mode: "paper" },
    claude: { model: "sonnet" },
  })),
  fundExists: vi.fn(() => true),
}));

// ── Mock config.js ────────────────────────────────────────────────────────────
vi.mock("../../src/config.js", () => ({
  loadGlobalConfig: vi.fn(async () => ({
    default_model: "sonnet",
    broker: { mode: "paper" },
  })),
}));

// ── journal.js is NOT mocked ──────────────────────────────────────────────────
//    openJournal() uses fundPaths() which is redirected to the tmpdir via
//    FUNDX_HOME. It auto-creates an empty SQLite DB with the correct schema on
//    first access. loadJournalSince now queries the real column names
//    (timestamp, closed_at, price, close_price) so no mock is needed.

// ── Imports after mocks ───────────────────────────────────────────────────────
import {
  runMetaReflection,
  readConsolidationState,
} from "../../src/services/meta-reflection.service.js";

// ── Test suite ────────────────────────────────────────────────────────────────
describe("integration: runMetaReflection (mocked SDK)", () => {
  let workspace: string;
  const fundName = "test-fund";

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "fundx-meta-ref-"));
    process.env["FUNDX_HOME"] = workspace;

    const fundRoot = join(workspace, "funds", fundName);
    const stateDir = join(fundRoot, "state");
    const archiveDir = join(stateDir, "handoffs");
    const memoryDir = join(fundRoot, "memory");

    await mkdir(archiveDir, { recursive: true });
    await mkdir(memoryDir, { recursive: true });

    // Seed portfolio.json so readPortfolio() doesn't throw
    await writeFile(
      join(stateDir, "portfolio.json"),
      JSON.stringify({
        last_updated: new Date().toISOString(),
        cash: 100_000,
        total_value: 100_000,
        positions: [],
      }),
      "utf-8",
    );

    // Seed the three memory files with frontmatter but no lesson entries yet
    const seed = (desc: string) =>
      `---\ndescription: ${desc}\n---\n\n(No observations yet.)\n`;
    await writeFile(
      join(memoryDir, "market-lessons.md"),
      seed("Market patterns and lessons learned"),
    );
    await writeFile(
      join(memoryDir, "trading-patterns.md"),
      seed("Trading behavior observations"),
    );
    await writeFile(join(memoryDir, "fund-notes.md"), seed("General fund observations"));

    // Seed two archived handoff files with distinct mtimes
    const olderPath = join(archiveDir, "2026-05-01T00-00-00_pre_market.md");
    const newerPath = join(archiveDir, "2026-05-08T00-00-00_post_market.md");
    await writeFile(olderPath, "## Older handoff\n\nReasoning A.\n");
    await writeFile(newerPath, "## Newer handoff\n\nReasoning B.\n");

    // Set distinct mtimes so listHandoffsSince can sort/filter correctly
    await utimes(
      olderPath,
      new Date("2026-05-01T00:00:00Z"),
      new Date("2026-05-01T00:00:00Z"),
    );
    await utimes(
      newerPath,
      new Date("2026-05-08T00:00:00Z"),
      new Date("2026-05-08T00:00:00Z"),
    );
  });

  afterEach(async () => {
    delete process.env["FUNDX_HOME"];
    await rm(workspace, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("first run: processes both handoffs, writes lesson, advances cursor", async () => {
    await runMetaReflection(fundName);

    const tracker = await readConsolidationState(fundName);
    expect(tracker).not.toBeNull();
    expect(tracker!.status).toBe("success");
    expect(tracker!.n_handoffs_processed).toBe(2);
    // Cursor should advance to the newest handoff's mtime
    expect(tracker!.cursor_iso).toBe("2026-05-08T00:00:00.000Z");

    // The mock stub appended a lesson to market-lessons.md
    const memory = await readFile(
      join(workspace, "funds", fundName, "memory", "market-lessons.md"),
      "utf-8",
    );
    expect(memory).toContain("Test Lesson");
  });

  it("second run with no new handoffs: status=no_data, no SDK call", async () => {
    // First run advances cursor to 2026-05-08
    await runMetaReflection(fundName);

    // Clear the mock call count recorded during the first run
    const sessionMod = await import("../../src/services/session.service.js");
    (sessionMod.runFundSession as ReturnType<typeof vi.fn>).mockClear();

    // Second run: no handoffs after the cursor → should be no_data
    await runMetaReflection(fundName);

    const tracker = await readConsolidationState(fundName);
    expect(tracker!.status).toBe("no_data");
    expect(tracker!.n_handoffs_processed).toBe(0);
    expect(sessionMod.runFundSession).not.toHaveBeenCalled();
  });
});
