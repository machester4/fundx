import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * checkBreakingNews relevance: a fund should only get a news_reaction session
 * when the article's tickers intersect its PORTFOLIO or WATCHLIST — not its
 * full resolved universe (with every fund on the sp500 preset, universe-based
 * relevance fanned every tagged headline out to all funds).
 */

const mockListActiveFundNames = vi.fn(async () => ["fundA", "fundB"]);
const mockLoadFundConfig = vi.fn(async (_name: string) => ({
  fund: { name: "x", display_name: "X", status: "active" },
  universe: { include_tickers: [] },
  notifications: { quiet_hours: { enabled: false, start: "22:00", end: "07:00" } },
}));
vi.mock("../src/services/fund.service.js", () => ({
  listActiveFundNames: (...a: unknown[]) => mockListActiveFundNames(...(a as [])),
  loadFundConfig: (...a: unknown[]) => mockLoadFundConfig(...(a as [string])),
}));

const mockReadPortfolio = vi.fn(async (_name: string) => ({ positions: [] as Array<{ symbol: string }> }));
const mockReadSessionCountsForToday = vi.fn(async () => ({ date: "2026-06-12", agent: 0, news: 0 }));
const mockUpdatePendingSessions = vi.fn(async () => []);
vi.mock("../src/state.js", () => ({
  readPortfolio: (...a: unknown[]) => mockReadPortfolio(...(a as [string])),
  readSessionCountsForToday: (...a: unknown[]) => mockReadSessionCountsForToday(...(a as [])),
  updatePendingSessions: (...a: unknown[]) => mockUpdatePendingSessions(...(a as [])),
}));

const mockQueryWatchlist = vi.fn((_db: unknown, _q: unknown): Array<{ ticker: string }> => []);
vi.mock("../src/services/watchlist.service.js", () => ({
  openWatchlistDb: vi.fn(() => ({ close: vi.fn() })),
  queryWatchlist: (...a: unknown[]) => mockQueryWatchlist(...(a as [unknown, unknown])),
}));

vi.mock("../src/services/universe.service.js", () => ({
  resolveUniverse: vi.fn(async () => ({ final_tickers: [] })),
}));

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn(async () => ({ news: {}, market_data: {} })),
}));

// Stub zvec so the "mark alerted" write is a no-op without native deps.
vi.mock("@zvec/zvec", () => ({
  default: {
    ZVecOpen: vi.fn(() => ({
      updateSync: vi.fn(),
      fetchSync: vi.fn(() => ({})),
      upsertSync: vi.fn(),
      querySync: vi.fn(() => []),
    })),
    ZVecCreateAndOpen: vi.fn(),
    ZVecCollectionSchema: class {},
    ZVecIndexType: { HNSW: 0 },
    ZVecMetricType: { COSINE: 0 },
  },
  ZVecDataType: { VECTOR_FP32: 0, STRING: 1, BOOL: 2 },
}));

import { checkBreakingNews } from "../src/services/news.service.js";

const article = (over: Partial<Record<string, unknown>> = {}) => ({
  id: `id-${Math.random()}`,
  title: "COHR earnings surge after guidance beat",
  source: "TestWire",
  category: "stocks",
  url: "https://example.com/a",
  published_at: new Date().toISOString(),
  fetched_at: new Date().toISOString(),
  symbols: ["COHR"],
  snippet: "",
  alerted: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockListActiveFundNames.mockResolvedValue(["fundA", "fundB"]);
});

describe("checkBreakingNews relevance scoping", () => {
  it("enqueues only for the fund whose portfolio holds a matched ticker", async () => {
    mockReadPortfolio.mockImplementation(async (name: string) => ({
      positions: name === "fundA" ? [{ symbol: "COHR" }] : [],
    }));

    await checkBreakingNews([article() as never]);

    expect(mockUpdatePendingSessions).toHaveBeenCalledTimes(1);
    expect(mockUpdatePendingSessions.mock.calls[0][0]).toBe("fundA");
  });

  it("watchlist (candidate/watching) tickers also count as relevant", async () => {
    mockListActiveFundNames.mockResolvedValue(["fundC", "fundD"]);
    mockQueryWatchlist.mockImplementation((_db, q) =>
      (q as { fund: string }).fund === "fundD" ? [{ ticker: "NVDA" }] : [],
    );

    await checkBreakingNews([
      article({ title: "NVDA halts trading after surge", symbols: ["NVDA"] }) as never,
    ]);

    expect(mockUpdatePendingSessions).toHaveBeenCalledTimes(1);
    expect(mockUpdatePendingSessions.mock.calls[0][0]).toBe("fundD");
  });

  it("a universe-only match (no portfolio, no watchlist) does NOT wake any fund", async () => {
    mockListActiveFundNames.mockResolvedValue(["fundE"]);
    await checkBreakingNews([article({ title: "AAPL earnings surge", symbols: ["AAPL"] }) as never]);
    expect(mockUpdatePendingSessions).not.toHaveBeenCalled();
  });
});
