import { describe, it, expect, vi } from "vitest";

// daemon.service.ts pulls in heavyweight deps at module load (node-cron,
// better-sqlite3 via screening/watchlist) — mock the boundary modules so we
// can import the pure helpers in isolation.
vi.mock("node-cron", () => ({ default: { schedule: vi.fn() } }));
vi.mock("../src/services/watchlist.service.js", () => ({ openWatchlistDb: vi.fn() }));
vi.mock("../src/services/price-cache.service.js", () => ({ openPriceCache: vi.fn() }));
vi.mock("../src/services/screening.service.js", () => ({ runScreen: vi.fn() }));
vi.mock("../src/services/news.service.js", () => ({
  fetchAllFeeds: vi.fn(),
  checkBreakingNews: vi.fn(),
  cleanOldArticles: vi.fn(),
}));
vi.mock("../src/services/news-ipc.service.js", () => ({
  startNewsIpcServer: vi.fn(),
  stopNewsIpcServer: vi.fn(),
}));
vi.mock("../src/embeddings.js", () => ({}));
vi.mock("../src/journal.js", () => ({ openJournal: vi.fn(), getTradesInDays: vi.fn() }));
vi.mock("../src/stoploss.js", () => ({ checkStopLosses: vi.fn(), executeStopLosses: vi.fn() }));
vi.mock("../src/services/meta-reflection.service.js", () => ({ runMetaReflection: vi.fn() }));

import { detectWakeGap, WAKE_GAP_THRESHOLD_MS } from "../src/services/daemon.service.js";

describe("detectWakeGap", () => {
  it("fires when the inter-tick gap exceeds the threshold", () => {
    const t0 = 1_750_000_000_000;
    expect(detectWakeGap(t0, t0 + WAKE_GAP_THRESHOLD_MS + 1)).toBe(true);
  });

  it("stays quiet for normal one-minute cadence", () => {
    const t0 = 1_750_000_000_000;
    expect(detectWakeGap(t0, t0 + 60_000)).toBe(false);
  });

  it("does not fire on the first tick (no anchor)", () => {
    expect(detectWakeGap(0, 1_750_000_000_000)).toBe(false);
  });
});
