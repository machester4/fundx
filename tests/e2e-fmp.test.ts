import { describe, it, expect } from "vitest";
import {
  getSp500ConstituentsRaw,
  getNasdaq100ConstituentsRaw,
  getDow30ConstituentsRaw,
  getScreenerResultsRaw,
  getCompanyProfile,
  _resetProfileCacheForTests,
} from "../src/services/market.service.js";

const FMP_KEY = process.env.FUNDX_FMP_E2E_KEY;
const describeIfKey = FMP_KEY ? describe : describe.skip;

describeIfKey("FMP E2E (gated by FUNDX_FMP_E2E_KEY)", () => {
  it("sp500 constituent endpoint returns a plausible list", async () => {
    const tickers = await getSp500ConstituentsRaw(FMP_KEY!);
    expect(tickers.length).toBeGreaterThanOrEqual(450);
    expect(tickers.length).toBeLessThanOrEqual(550);
    expect(tickers).toContain("AAPL");
    expect(tickers).toContain("MSFT");
  });

  it("nasdaq100 constituent endpoint returns a plausible list", async () => {
    const tickers = await getNasdaq100ConstituentsRaw(FMP_KEY!);
    expect(tickers.length).toBeGreaterThanOrEqual(80);
    expect(tickers.length).toBeLessThanOrEqual(110);
    expect(tickers).toContain("AAPL");
    expect(tickers).toContain("NVDA");
  });

  it("dow30 constituent endpoint returns 30 tickers", async () => {
    const tickers = await getDow30ConstituentsRaw(FMP_KEY!);
    expect(tickers.length).toBeGreaterThanOrEqual(28);
    expect(tickers.length).toBeLessThanOrEqual(32);
  });

  it("company-screener responds to basic US large-cap filter", async () => {
    const results = await getScreenerResultsRaw(
      {
        market_cap_min: 10_000_000_000,
        exchange: ["NYSE", "NASDAQ"],
        country: "US",
        is_actively_trading: true,
        limit: 50,
      },
      FMP_KEY!,
    );
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.symbol).toMatch(/^[A-Z][A-Z0-9.-]*$/);
      if (r.marketCap !== undefined) expect(r.marketCap).toBeGreaterThanOrEqual(10_000_000_000);
    }
  });

  it("profile endpoint returns sector for AAPL", async () => {
    _resetProfileCacheForTests();
    const profile = await getCompanyProfile("AAPL", FMP_KEY!);
    expect(profile).not.toBeNull();
    expect(profile!.sector).toBe("Technology");
  });
});
