import { describe, it, expect, afterEach } from "vitest";
import { buildFundContext } from "../src/services/chat.service.js";
import { seedEvalFund, type SeedEvalFundHandle } from "../src/services/eval/seed.js";

// ── relTime helper (exported from chat.service.ts) ─────────────────
import { relTime } from "../src/services/chat.service.js";

describe("relTime", () => {
  it("formats seconds for deltas under a minute", () => {
    const ts = Date.now() - 5000;
    expect(relTime(ts)).toMatch(/^[0-9]+s ago$/);
  });

  it("formats minutes between 1 minute and 1 hour", () => {
    const ts = Date.now() - 10 * 60 * 1000;
    expect(relTime(ts)).toBe("10m ago");
  });

  it("formats hours between 1 hour and 1 day", () => {
    const ts = Date.now() - 5 * 3600 * 1000;
    expect(relTime(ts)).toBe("5h ago");
  });

  it("formats days for deltas of 1+ days", () => {
    const ts = Date.now() - 3 * 86400 * 1000;
    expect(relTime(ts)).toBe("3d ago");
  });

  it("accepts ISO string and epoch number", () => {
    const epoch = Date.now() - 2 * 3600 * 1000;
    const iso = new Date(epoch).toISOString();
    expect(relTime(iso)).toBe(relTime(epoch));
  });

  it("clamps negative deltas to 0s ago", () => {
    const future = Date.now() + 60_000;
    expect(relTime(future)).toBe("0s ago");
  });
});

// ── buildFundContext new sections ──────────────────────────────────
describe("buildFundContext — watchlist section", () => {
  let handle: SeedEvalFundHandle | null = null;
  afterEach(async () => {
    if (handle) { await handle.cleanup(); handle = null; }
  });

  it('renders "empty — run screen_run to populate" when watchlist has no entries', async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [],
    });
    const ctx = await buildFundContext(handle.fundName);
    expect(ctx).toContain("### Watchlist");
    expect(ctx).toMatch(/empty — run `screen_run` to populate/);
  });

  it('renders 3 entries without "top 5 of N" header when watchlist has ≤5', async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [
        { ticker: "NVDA", status: "candidate", peak_score: 0.9, screens: ["momentum-12-1"], first_surfaced_days_ago: 7 },
        { ticker: "AMD",  status: "watching",  peak_score: 0.7, screens: ["momentum-12-1"], first_surfaced_days_ago: 3 },
        { ticker: "AVGO", status: "candidate", peak_score: 0.6, screens: ["momentum-12-1"], first_surfaced_days_ago: 2 },
      ],
    });
    const ctx = await buildFundContext(handle.fundName);
    expect(ctx).toContain("### Watchlist (by peak_score)");
    expect(ctx).not.toContain("top 5 of");
    expect(ctx).toContain("NVDA");
    expect(ctx).toContain("[candidate]");
    expect(ctx).toContain("score=0.90");
    // sort by peak_score desc: NVDA first, then AMD, then AVGO
    const nvdaIdx = ctx.indexOf("NVDA");
    const amdIdx = ctx.indexOf("AMD");
    const avgoIdx = ctx.indexOf("AVGO");
    expect(nvdaIdx).toBeLessThan(amdIdx);
    expect(amdIdx).toBeLessThan(avgoIdx);
  });

  it('renders "top 5 of N" header when watchlist has >5 entries, plus hint line', async () => {
    const watchlist = Array.from({ length: 8 }, (_, i) => ({
      ticker: `T${i.toString().padStart(2, "0")}`,
      status: "candidate" as const,
      peak_score: 0.9 - i * 0.05,
      screens: ["momentum-12-1"],
      first_surfaced_days_ago: i + 1,
    }));
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist,
    });
    const ctx = await buildFundContext(handle.fundName);
    expect(ctx).toContain("### Watchlist — top 5 of 8 (by peak_score)");
    expect(ctx).toContain("(3 more candidates available via screener.watchlist_query)");
    // First ticker T00 should appear, last ticker T07 should NOT appear in top 5
    expect(ctx).toContain("T00");
    expect(ctx).not.toContain("T07");
  });
});

describe("buildFundContext — data freshness section", () => {
  let handle: SeedEvalFundHandle | null = null;
  afterEach(async () => {
    if (handle) { await handle.cleanup(); handle = null; }
  });

  it("includes portfolio and tracker timestamps with relTime formatting", async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [],
    });
    const ctx = await buildFundContext(handle.fundName);
    expect(ctx).toContain("### Data freshness");
    expect(ctx).toMatch(/portfolio: updated \d+[smhd] ago/);
    expect(ctx).toMatch(/tracker: updated \d+[smhd] ago/);
  });

  it("includes watchlist freshness when the watchlist has entries", async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [
        { ticker: "NVDA", status: "candidate", peak_score: 0.9, screens: ["momentum-12-1"], first_surfaced_days_ago: 7 },
      ],
    });
    const ctx = await buildFundContext(handle.fundName);
    expect(ctx).toMatch(/watchlist: evaluated \d+[smhd] ago/);
  });

  it("omits freshness lines whose underlying files are missing", async () => {
    handle = await seedEvalFund({
      fund_config: { objective: "runway", risk_profile: "moderate", initial_capital: 10000 },
      portfolio: { cash: 10000, positions: [] },
      tracker: { progress_pct: 0, status: "on_track" },
      watchlist: [],
    });
    // handoff file does NOT exist by default after seeding — freshness section
    // should not mention it (no "undefined ago")
    const ctx = await buildFundContext(handle.fundName);
    expect(ctx).not.toMatch(/handoff: written undefined/);
    expect(ctx).not.toMatch(/handoff: written NaN/);
  });
});
