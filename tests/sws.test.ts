import { describe, it, expect } from "vitest";
import {
  globalConfigSchema,
  swsSnowflakeSchema,
  swsCompanySchema,
  swsScreenerResultSchema,
  swsSearchResultSchema,
} from "../src/types.js";

describe("globalConfigSchema — SWS config", () => {
  it("accepts config without sws key", () => {
    const result = globalConfigSchema.parse({});
    expect(result.sws).toBeUndefined();
  });

  it("accepts config with sws token", () => {
    const result = globalConfigSchema.parse({
      sws: {
        auth_token: "abc123",
        token_expires_at: "2026-12-31T00:00:00Z",
      },
    });
    expect(result.sws?.auth_token).toBe("abc123");
    expect(result.sws?.token_expires_at).toBe("2026-12-31T00:00:00Z");
  });

  it("accepts sws with only partial fields", () => {
    const result = globalConfigSchema.parse({
      sws: { auth_token: "token-only" },
    });
    expect(result.sws?.auth_token).toBe("token-only");
    expect(result.sws?.token_expires_at).toBeUndefined();
  });

  it("accepts sws as empty object", () => {
    const result = globalConfigSchema.parse({ sws: {} });
    expect(result.sws).toBeDefined();
    expect(result.sws?.auth_token).toBeUndefined();
  });
});

describe("swsSnowflakeSchema", () => {
  it("validates valid scores", () => {
    const result = swsSnowflakeSchema.parse({
      value: 8,
      future: 6,
      health: 9,
      past: 7,
      dividend: 4,
    });
    expect(result.value).toBe(8);
    expect(result.future).toBe(6);
    expect(result.health).toBe(9);
    expect(result.past).toBe(7);
    expect(result.dividend).toBe(4);
  });

  it("rejects missing fields", () => {
    expect(() =>
      swsSnowflakeSchema.parse({
        value: 8,
        future: 6,
        // missing health, past, dividend
      }),
    ).toThrow();
  });
});

describe("swsCompanySchema", () => {
  const validCompany = {
    id: 12345,
    name: "Apple Inc",
    tickerSymbol: "AAPL",
    uniqueSymbol: "NasdaqGS:AAPL",
    exchangeSymbol: "NasdaqGS",
    score: {
      value: 8,
      future: 6,
      health: 9,
      past: 7,
      dividend: 0,
    },
    primaryIndustry: {
      id: 1,
      name: "Tech Hardware",
      slug: "tech-hardware",
    },
    analysisValue: {
      return1d: 0.5,
      return7d: 2.1,
      return1yAbs: 15.3,
      marketCap: 3000000000000,
      lastSharePrice: 190.5,
      priceTarget: 210.0,
      pe: 29.5,
      pb: 45.2,
      priceToSales: 8.1,
    },
    analysisFuture: {
      netIncomeGrowth3Y: 10.5,
      netIncomeGrowthAnnual: 8.2,
      revenueGrowthAnnual: 6.5,
    },
    analysisDividend: {
      dividendYield: 0.5,
    },
    analysisMisc: {
      analystCount: 35,
    },
    info: {
      shortDescription: "Designs and sells consumer electronics.",
      logoUrl: "https://example.com/aapl.png",
      yearFounded: 1976,
    },
  };

  it("validates a full company object", () => {
    const result = swsCompanySchema.parse(validCompany);
    expect(result.id).toBe(12345);
    expect(result.name).toBe("Apple Inc");
    expect(result.tickerSymbol).toBe("AAPL");
    expect(result.uniqueSymbol).toBe("NasdaqGS:AAPL");
    expect(result.exchangeSymbol).toBe("NasdaqGS");
    expect(result.score.value).toBe(8);
    expect(result.primaryIndustry.name).toBe("Tech Hardware");
    expect(result.analysisValue?.marketCap).toBe(3000000000000);
    expect(result.analysisFuture?.netIncomeGrowth3Y).toBe(10.5);
    expect(result.analysisDividend?.dividendYield).toBe(0.5);
    expect(result.analysisMisc?.analystCount).toBe(35);
    expect(result.info?.yearFounded).toBe(1976);
  });

  it("validates a minimal company (only required fields)", () => {
    const result = swsCompanySchema.parse({
      id: 1,
      name: "Test Corp",
      tickerSymbol: "TST",
      uniqueSymbol: "NYSE:TST",
      exchangeSymbol: "NYSE",
      score: { value: 5, future: 5, health: 5, past: 5, dividend: 5 },
      primaryIndustry: { id: 2, name: "Finance", slug: "finance" },
    });
    expect(result.id).toBe(1);
    expect(result.analysisValue).toBeUndefined();
    expect(result.info).toBeUndefined();
  });

  it("accepts null values for nullable optional fields", () => {
    const result = swsCompanySchema.parse({
      ...validCompany,
      analysisValue: {
        return1d: null,
        marketCap: null,
        lastSharePrice: 190.5,
      },
    });
    expect(result.analysisValue?.return1d).toBeNull();
    expect(result.analysisValue?.marketCap).toBeNull();
  });

  it("rejects missing required fields", () => {
    expect(() =>
      swsCompanySchema.parse({
        id: 1,
        name: "Missing fields",
        // missing tickerSymbol, uniqueSymbol, exchangeSymbol, score, primaryIndustry
      }),
    ).toThrow();
  });
});

describe("swsScreenerResultSchema", () => {
  it("validates a screener result", () => {
    const result = swsScreenerResultSchema.parse({
      totalHits: 100,
      companies: [
        {
          id: 1,
          name: "Test Corp",
          tickerSymbol: "TST",
          uniqueSymbol: "NYSE:TST",
          exchangeSymbol: "NYSE",
          score: { value: 5, future: 5, health: 5, past: 5, dividend: 5 },
          primaryIndustry: { id: 2, name: "Finance", slug: "finance" },
        },
      ],
    });
    expect(result.totalHits).toBe(100);
    expect(result.companies).toHaveLength(1);
    expect(result.companies[0].tickerSymbol).toBe("TST");
  });

  it("defaults companies to empty array when omitted", () => {
    const result = swsScreenerResultSchema.parse({ totalHits: 0 });
    expect(result.companies).toEqual([]);
  });

  it("rejects missing totalHits", () => {
    expect(() => swsScreenerResultSchema.parse({ companies: [] })).toThrow();
  });
});

describe("swsSearchResultSchema", () => {
  it("validates a search result with score", () => {
    const result = swsSearchResultSchema.parse({
      id: 1,
      name: "Apple Inc",
      tickerSymbol: "AAPL",
      uniqueSymbol: "NasdaqGS:AAPL",
      exchangeSymbol: "NasdaqGS",
      score: { value: 8, future: 6, health: 9, past: 7, dividend: 0 },
    });
    expect(result.tickerSymbol).toBe("AAPL");
    expect(result.score?.value).toBe(8);
  });

  it("validates a search result without score", () => {
    const result = swsSearchResultSchema.parse({
      id: 2,
      name: "Test Corp",
      tickerSymbol: "TST",
      uniqueSymbol: "NYSE:TST",
      exchangeSymbol: "NYSE",
    });
    expect(result.score).toBeUndefined();
  });
});
