import { describe, it, expect, vi } from "vitest";
import { computeFundCorrelation, computeCorrelationMatrix } from "../src/services/correlation.service.js";

vi.mock("../src/services/fund.service.js", () => ({
  listFundNames: vi.fn().mockResolvedValue(["fund-a", "fund-b", "fund-c"]),
}));

vi.mock("../src/state.js", () => ({
  readPortfolio: vi.fn().mockResolvedValue({
    last_updated: "2026-02-25T00:00:00Z",
    cash: 10000,
    total_value: 10000,
    positions: [],
  }),
}));

vi.mock("../src/journal.js", () => ({
  openJournal: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
    }),
    close: vi.fn(),
  }),
  getTradesInDays: vi.fn().mockReturnValue([]),
}));

describe("computeFundCorrelation", () => {
  it("returns a valid correlation entry", async () => {
    const entry = await computeFundCorrelation("fund-a", "fund-b", 30);

    expect(entry.fund_a).toBe("fund-a");
    expect(entry.fund_b).toBe("fund-b");
    expect(entry.period_days).toBe(30);
    expect(entry.correlation).toBeGreaterThanOrEqual(-1);
    expect(entry.correlation).toBeLessThanOrEqual(1);
    expect(entry.computed_at).toBeTruthy();
  });

  it("returns 0 correlation for empty trade histories", async () => {
    const entry = await computeFundCorrelation("fund-a", "fund-b", 30);
    expect(entry.correlation).toBe(0);
  });

  it("detects overlapping symbols in portfolios", async () => {
    const { readPortfolio } = await import("../src/state.js");
    const mockedReadPortfolio = vi.mocked(readPortfolio);

    mockedReadPortfolio.mockResolvedValueOnce({
      last_updated: "2026-02-25T00:00:00Z",
      cash: 5000,
      total_value: 10000,
      positions: [
        { symbol: "GDX", shares: 100, avg_cost: 45, current_price: 46, market_value: 4600, unrealized_pnl: 100, unrealized_pnl_pct: 2.2, weight_pct: 46, entry_date: "2026-01-01", entry_reason: "" },
      ],
    });
    mockedReadPortfolio.mockResolvedValueOnce({
      last_updated: "2026-02-25T00:00:00Z",
      cash: 5000,
      total_value: 10000,
      positions: [
        { symbol: "GDX", shares: 50, avg_cost: 44, current_price: 46, market_value: 2300, unrealized_pnl: 100, unrealized_pnl_pct: 4.5, weight_pct: 23, entry_date: "2026-01-15", entry_reason: "" },
        { symbol: "SPY", shares: 10, avg_cost: 500, current_price: 510, market_value: 5100, unrealized_pnl: 100, unrealized_pnl_pct: 2, weight_pct: 51, entry_date: "2026-01-01", entry_reason: "" },
      ],
    });

    const entry = await computeFundCorrelation("fund-a", "fund-b", 30);
    expect(entry.overlapping_symbols).toContain("GDX");
    expect(entry.warning).toContain("GDX");
  });
});

describe("computeCorrelationMatrix", () => {
  it("computes pairwise correlations", async () => {
    const results = await computeCorrelationMatrix(30);
    // 3 funds → 3 pairs: (a,b), (a,c), (b,c)
    expect(results).toHaveLength(3);
  });

  it("uses specified period", async () => {
    const results = await computeCorrelationMatrix(60);
    for (const entry of results) {
      expect(entry.period_days).toBe(60);
    }
  });
});
