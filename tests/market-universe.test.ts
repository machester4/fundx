import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getNasdaq100Constituents,
  getDow30Constituents,
  getScreenerResults,
  getCompanyProfile,
  _resetProfileCacheForTests,
  getSp500ConstituentsRaw,
  getNasdaq100ConstituentsRaw,
  getDow30ConstituentsRaw,
  getScreenerResultsRaw,
} from "../src/services/market.service.js";

const origFetch = globalThis.fetch;

function mockFetch(handler: (url: string) => unknown) {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const body = handler(String(url));
    if (body === undefined) return new Response("not found", { status: 500 });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  globalThis.fetch = origFetch;
  _resetProfileCacheForTests();
});

describe("getNasdaq100Constituents", () => {
  it("returns tickers from FMP response", async () => {
    mockFetch((url) => {
      expect(url).toContain("/nasdaq_constituent");
      expect(url).toContain("apikey=KEY");
      return [{ symbol: "AAPL" }, { symbol: "MSFT" }];
    });
    expect(await getNasdaq100Constituents("KEY")).toEqual(["AAPL", "MSFT"]);
  });

  it("returns empty array on non-200 (caller handles fallback)", async () => {
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 500 })) as unknown as typeof globalThis.fetch;
    expect(await getNasdaq100Constituents("KEY")).toEqual([]);
  });
});

describe("getDow30Constituents", () => {
  it("returns tickers from FMP response", async () => {
    mockFetch((url) => {
      expect(url).toContain("/dowjones_constituent");
      return [{ symbol: "MMM" }, { symbol: "BA" }];
    });
    expect(await getDow30Constituents("KEY")).toEqual(["MMM", "BA"]);
  });
});

describe("getScreenerResults", () => {
  it("builds correct query string from all filters", async () => {
    let captured = "";
    mockFetch((url) => {
      captured = url;
      return [];
    });
    await getScreenerResults(
      {
        market_cap_min: 1e10,
        market_cap_max: 5e11,
        price_min: 10,
        price_max: 500,
        beta_min: 0.5,
        beta_max: 1.5,
        dividend_min: 0,
        dividend_max: 5,
        volume_min: 1_000_000,
        volume_max: 100_000_000,
        sector: ["Technology", "Healthcare"],
        industry: "Consumer Electronics",
        exchange: ["NYSE", "NASDAQ"],
        country: "US",
        is_etf: false,
        is_fund: false,
        is_actively_trading: true,
        include_all_share_classes: false,
        limit: 500,
      },
      "KEY",
    );
    expect(captured).toContain("/company-screener");
    expect(captured).toContain("marketCapMoreThan=10000000000");
    expect(captured).toContain("marketCapLowerThan=500000000000");
    expect(captured).toContain("priceMoreThan=10");
    expect(captured).toContain("betaMoreThan=0.5");
    expect(captured).toContain("dividendMoreThan=0");
    expect(captured).toContain("volumeMoreThan=1000000");
    expect(captured).toContain("sector=Technology");
    expect(captured).toContain("sector=Healthcare");
    expect(captured).toContain("industry=Consumer%20Electronics");
    expect(captured).toContain("exchange=NYSE");
    expect(captured).toContain("exchange=NASDAQ");
    expect(captured).toContain("country=US");
    expect(captured).toContain("isEtf=false");
    expect(captured).toContain("isActivelyTrading=true");
    expect(captured).toContain("limit=500");
    expect(captured).toContain("apikey=KEY");
  });

  it("returns typed rows", async () => {
    mockFetch(() => [
      { symbol: "AAPL", companyName: "Apple", marketCap: 3e12, sector: "Technology", industry: "X", exchange: "NASDAQ" },
    ]);
    const r = await getScreenerResults({ limit: 10, is_actively_trading: true }, "KEY");
    expect(r).toHaveLength(1);
    expect(r[0].symbol).toBe("AAPL");
    expect(r[0].sector).toBe("Technology");
  });

  it("omits unset filters from query", async () => {
    let captured = "";
    mockFetch((url) => { captured = url; return []; });
    await getScreenerResults({ limit: 100, is_actively_trading: true }, "KEY");
    expect(captured).not.toContain("marketCapMoreThan");
    expect(captured).not.toContain("sector=");
    expect(captured).toContain("limit=100");
  });
});

describe("getCompanyProfile", () => {
  it("fetches and returns profile", async () => {
    mockFetch((url) => {
      expect(url).toContain("/profile/AAPL");
      return [{ symbol: "AAPL", companyName: "Apple", sector: "Technology", industry: "Consumer Electronics", exchange: "NASDAQ" }];
    });
    const p = await getCompanyProfile("AAPL", "KEY");
    expect(p?.sector).toBe("Technology");
  });

  it("returns null when FMP returns empty", async () => {
    mockFetch(() => []);
    expect(await getCompanyProfile("ZZZZZ", "KEY")).toBeNull();
  });

  it("caches successful responses (second call no fetch)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify([{ symbol: "AAPL", sector: "Technology" }]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await getCompanyProfile("AAPL", "KEY");
    await getCompanyProfile("AAPL", "KEY");
    expect(calls).toBe(1);
  });

  it("case-insensitive ticker (normalizes to upper)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response(JSON.stringify([{ symbol: "AAPL", sector: "Tech" }]), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    await getCompanyProfile("aapl", "KEY");
    await getCompanyProfile("AAPL", "KEY");
    expect(calls).toBe(1);
  });
});

describe("getSp500ConstituentsRaw", () => {
  it("throws on non-200", async () => {
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 500 })) as unknown as typeof globalThis.fetch;
    await expect(getSp500ConstituentsRaw("KEY")).rejects.toThrow(/500/);
  });

  it("returns tickers on success", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{ symbol: "AAPL" }]), { status: 200 })) as unknown as typeof globalThis.fetch;
    expect(await getSp500ConstituentsRaw("KEY")).toEqual(["AAPL"]);
  });

  it("throws on empty body", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof globalThis.fetch;
    await expect(getSp500ConstituentsRaw("KEY")).rejects.toThrow(/empty/i);
  });
});

describe("getNasdaq100ConstituentsRaw", () => {
  it("throws on non-200", async () => {
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 503 })) as unknown as typeof globalThis.fetch;
    await expect(getNasdaq100ConstituentsRaw("KEY")).rejects.toThrow(/503/);
  });
});

describe("getDow30ConstituentsRaw", () => {
  it("throws on non-200", async () => {
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 404 })) as unknown as typeof globalThis.fetch;
    await expect(getDow30ConstituentsRaw("KEY")).rejects.toThrow(/404/);
  });
});

describe("getScreenerResultsRaw", () => {
  it("throws on non-200", async () => {
    globalThis.fetch = vi.fn(async () => new Response("x", { status: 500 })) as unknown as typeof globalThis.fetch;
    await expect(getScreenerResultsRaw({ limit: 10 }, "KEY")).rejects.toThrow(/500/);
  });

  it("returns results on success", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{ symbol: "AAPL", sector: "Technology" }]), { status: 200 })) as unknown as typeof globalThis.fetch;
    const r = await getScreenerResultsRaw({ limit: 10 }, "KEY");
    expect(r).toHaveLength(1);
    expect(r[0].symbol).toBe("AAPL");
  });
});
