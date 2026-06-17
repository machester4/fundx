import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = join(tmpdir(), `fundx-snapshot-test-${Date.now()}`);

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => ({
      root: join(tmpRoot, "funds", name),
      claudeMd: join(tmpRoot, "funds", name, "CLAUDE.md"),
      claudeDir: join(tmpRoot, "funds", name, ".claude"),
      claudeSettings: join(tmpRoot, "funds", name, ".claude", "settings.json"),
      claudeSkillsDir: join(tmpRoot, "funds", name, ".claude", "skills"),
      claudeRulesDir: join(tmpRoot, "funds", name, ".claude", "rules"),
      state: {
        dir: join(tmpRoot, "funds", name, "state"),
        sessionHandoff: join(tmpRoot, "funds", name, "state", "session-handoff.md"),
        portfolio: join(tmpRoot, "funds", name, "state", "portfolio.json"),
        tracker: join(tmpRoot, "funds", name, "state", "objective_tracker.json"),
        journal: join(tmpRoot, "funds", name, "state", "trade_journal.sqlite"),
        sessionLog: join(tmpRoot, "funds", name, "state", "session_log.json"),
        activeSession: join(tmpRoot, "funds", name, "state", "active_session.json"),
        chatHistory: join(tmpRoot, "funds", name, "state", "chat_history.json"),
        sessionHistory: join(tmpRoot, "funds", name, "state", "session_history.json"),
        lock: join(tmpRoot, "funds", name, "state", ".lock"),
        pendingSessions: join(tmpRoot, "funds", name, "state", "pending_sessions.json"),
        sessionCounts: join(tmpRoot, "funds", name, "state", "session_counts.json"),
        dailySnapshot: join(tmpRoot, "funds", name, "state", "daily_snapshot.json"),
        notifiedMilestones: join(tmpRoot, "funds", name, "state", "notified_milestones.json"),
        universe: join(tmpRoot, "funds", name, "state", "universe.json"),
      },
      analysis: join(tmpRoot, "funds", name, "analysis"),
      scripts: join(tmpRoot, "funds", name, "scripts"),
      reports: join(tmpRoot, "funds", name, "reports"),
      memory: join(tmpRoot, "funds", name, "memory"),
    }),
  };
});

vi.mock("../src/journal.js", () => ({
  openJournal: vi.fn(() => ({ close: vi.fn() })),
  getRecentTrades: vi.fn(() => []),
}));

vi.mock("../src/services/watchlist.service.js", () => ({
  openWatchlistDb: vi.fn(() => ({ close: vi.fn() })),
  queryWatchlist: vi.fn(() => []),
}));

import { buildStateSnapshot } from "../src/services/snapshot.service.js";
import { getRecentTrades } from "../src/journal.js";
import { queryWatchlist } from "../src/services/watchlist.service.js";

const mockedGetRecent = vi.mocked(getRecentTrades);
const mockedQueryWatch = vi.mocked(queryWatchlist);

beforeEach(async () => {
  vi.clearAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

async function seed(fund: string, files: Record<string, string>): Promise<void> {
  const stateDir = join(tmpRoot, "funds", fund, "state");
  await mkdir(stateDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(stateDir, name), content, "utf-8");
  }
}

describe("buildStateSnapshot", () => {
  it("returns full envelope when all sources present", async () => {
    await seed("f1", {
      "session-handoff.md": "# Handoff\nLast session OK.",
      "portfolio.json": '{"cash": 1000, "positions": []}',
      "objective_tracker.json": '{"progress_pct": 50}',
      "pending_sessions.json": "[]",
    });
    mockedGetRecent.mockReturnValue([
      {
        id: 1,
        timestamp: "2026-04-28T10:00:00Z",
        fund: "f1",
        symbol: "AAPL",
        side: "buy",
        quantity: 1,
        price: 100,
        total_value: 100,
        order_type: "market",
      },
    ] as never);
    mockedQueryWatch.mockReturnValue([
      {
        ticker: "MSFT",
        status: "candidate",
        current_screens_json: "[]",
        last_evaluated_at: "2026-04-28",
      } as never,
    ]);

    const snap = await buildStateSnapshot("f1");

    expect(snap).toContain("<state_snapshot>");
    expect(snap).toContain("</state_snapshot>");
    expect(snap).toContain("<session_handoff>");
    expect(snap).toContain("Last session OK.");
    expect(snap).toContain("<portfolio>");
    expect(snap).toContain('"cash": 1000');
    expect(snap).toContain("<objective_tracker>");
    expect(snap).toContain('"progress_pct": 50');
    expect(snap).toContain("<pending_sessions>");
    expect(snap).toContain("<recent_trades");
    expect(snap).toContain("AAPL");
    expect(snap).toContain("<watchlist");
    expect(snap).toContain("MSFT");
  });

  it("handoff_guidance asks to quantify the opportunity cost of cash at decision time", async () => {
    // Guards the decision_discipline lever: the judge deducts when the agent
    // names cash drag without sizing it (sessions/days idle + pace vs target).
    // The ask must live in the decision-time handoff_guidance, not only the
    // reflect-phase session-reflection skill.
    await seed("f-oppcost", { "session-handoff.md": "# Handoff\n18 sessions in cash." });
    const snap = await buildStateSnapshot("f-oppcost");
    expect(snap).toContain("<handoff_guidance>");
    expect(snap).toContain("put a number on what cash is costing");
    expect(snap).toContain("not a cue to act");
  });

  it("emits (none — first session) when handoff missing", async () => {
    await seed("f2", {
      "portfolio.json": '{"cash": 5000}',
    });
    const snap = await buildStateSnapshot("f2");
    expect(snap).toContain("<session_handoff>(none — first session)</session_handoff>");
  });

  it("emits (none) when pending_sessions missing", async () => {
    await seed("f3", { "portfolio.json": '{"cash": 5000}' });
    const snap = await buildStateSnapshot("f3");
    expect(snap).toContain("<pending_sessions>(none)</pending_sessions>");
  });

  it("emits (empty) when journal returns no trades", async () => {
    await seed("f4", { "portfolio.json": '{"cash": 5000}' });
    mockedGetRecent.mockReturnValue([]);
    const snap = await buildStateSnapshot("f4");
    expect(snap).toContain('<recent_trades count="10">(empty)</recent_trades>');
  });

  it("emits (empty) when watchlist returns no entries", async () => {
    await seed("f5", { "portfolio.json": '{"cash": 5000}' });
    mockedQueryWatch.mockReturnValue([]);
    const snap = await buildStateSnapshot("f5");
    expect(snap).toContain('<watchlist top="10">(empty)</watchlist>');
  });

  it("returns valid envelope when fund directory does not exist at all", async () => {
    // No seed call — fund dir not created
    const snap = await buildStateSnapshot("nonexistent-fund");
    expect(snap).toContain("<state_snapshot>");
    expect(snap).toContain("</state_snapshot>");
    expect(snap).toContain("(none");
  });

  it("snapshot opens with <state_snapshot> and closes with </state_snapshot>", async () => {
    const snap = await buildStateSnapshot("anyfund");
    expect(snap.trim().startsWith("<state_snapshot>")).toBe(true);
    expect(snap.trim().endsWith("</state_snapshot>")).toBe(true);
  });

  it("snapshot length under 50KB sanity cap", async () => {
    await seed("f6", {
      "session-handoff.md": "X".repeat(10_000),
      "portfolio.json": '{"cash": 5000}',
    });
    const snap = await buildStateSnapshot("f6");
    expect(snap.length).toBeLessThan(50_000);
  });

  it("handles journal query failure (catches db error, emits empty section)", async () => {
    await seed("f7", { "portfolio.json": '{"cash": 5000}' });
    mockedGetRecent.mockImplementation(() => {
      throw new Error("db locked");
    });
    const snap = await buildStateSnapshot("f7");
    expect(snap).toContain("<recent_trades");
    expect(snap).toContain("(empty");
  });

  it("handles watchlist query failure", async () => {
    await seed("f8", { "portfolio.json": '{"cash": 5000}' });
    mockedQueryWatch.mockImplementation(() => {
      throw new Error("watchlist db unavailable");
    });
    const snap = await buildStateSnapshot("f8");
    expect(snap).toContain("<watchlist");
    expect(snap).toContain("(empty");
  });

  it("clips oversized handoff with truncation marker (runtime cap, not just test sanity)", async () => {
    await seed("f9", {
      "session-handoff.md": "Y".repeat(20_000),  // way over the 8KB cap
      "portfolio.json": '{"cash": 5000}',
    });
    const snap = await buildStateSnapshot("f9");
    // Marker present
    expect(snap).toContain("[truncated,");
    expect(snap).toContain("session-handoff");
    // Snapshot stays well under 50KB
    expect(snap.length).toBeLessThan(50_000);
  });
});

describe("execution_gate_guidance", () => {
  it("always includes the gate mechanics block, even without a handoff", async () => {
    const xml = await buildStateSnapshot("missing-fund-gate");
    expect(xml).toContain("<execution_gate_guidance>");
    expect(xml).toContain("in-process pre-trade check");
    expect(xml).toContain("settings.json hook");
    expect(xml).toContain("Verdicts persist for 24 hours");
    expect(xml).toContain("risk-guardian");
    expect(xml).toContain("</execution_gate_guidance>");
  });

  it("gates the obsolete-handoff-note correction behind handoff presence", async () => {
    // No handoff → no false belief to correct, so the corrective clause is omitted;
    // the factual mechanics stay always-on.
    const noHandoff = await buildStateSnapshot("missing-fund-gate-2");
    expect(noHandoff).not.toContain("human-authorized session");
    await seed("f-gate-hf", { "session-handoff.md": "# Handoff\nHook blocks place_order." });
    const withHandoff = await buildStateSnapshot("f-gate-hf");
    expect(withHandoff).toContain("human-authorized session");
  });
});
