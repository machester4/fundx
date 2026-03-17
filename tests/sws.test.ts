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

// ── SWS Service tests ─────────────────────────────────────────

import { vi, describe as vDescribe, it as vIt, expect as vExpect, beforeEach as vBeforeEach } from "vitest";

// Mock config module for service tests
vi.mock("../src/config.js", () => {
  return {
    loadGlobalConfig: vi.fn(),
    saveGlobalConfig: vi.fn(),
  };
});

import { loadGlobalConfig, saveGlobalConfig } from "../src/config.js";
import {
  swsTokenStatus,
  swsLogout,
  findChromePath,
  swsListScreeners,
  decodeJwtExp,
} from "../src/services/sws.service.js";

const mockLoadGlobalConfig = loadGlobalConfig as ReturnType<typeof vi.fn>;
const mockSaveGlobalConfig = saveGlobalConfig as ReturnType<typeof vi.fn>;

vDescribe("swsTokenStatus", () => {
  vBeforeEach(() => {
    vi.clearAllMocks();
  });

  vIt("returns invalid when no token configured", async () => {
    mockLoadGlobalConfig.mockResolvedValue({ sws: undefined });

    const status = await swsTokenStatus();

    vExpect(status.configured).toBe(false);
    vExpect(status.valid).toBe(false);
  });

  vIt("returns valid when token exists and not expired", async () => {
    // Create a JWT with exp 1 hour in the future
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: futureExp, sub: "user123" })).toString("base64url");
    const fakeToken = `${header}.${payload}.fakesig`;

    mockLoadGlobalConfig.mockResolvedValue({
      sws: { auth_token: fakeToken, token_expires_at: new Date(futureExp * 1000).toISOString() },
    });

    const status = await swsTokenStatus();

    vExpect(status.configured).toBe(true);
    vExpect(status.valid).toBe(true);
  });

  vIt("returns invalid when token is expired", async () => {
    // Create a JWT with exp in the past
    const pastExp = Math.floor(Date.now() / 1000) - 3600;
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ exp: pastExp, sub: "user123" })).toString("base64url");
    const fakeToken = `${header}.${payload}.fakesig`;

    mockLoadGlobalConfig.mockResolvedValue({
      sws: { auth_token: fakeToken, token_expires_at: new Date(pastExp * 1000).toISOString() },
    });

    const status = await swsTokenStatus();

    vExpect(status.configured).toBe(true);
    vExpect(status.valid).toBe(false);
    vExpect(status.reason).toMatch(/expired/i);
  });
});

vDescribe("swsLogout", () => {
  vBeforeEach(() => {
    vi.clearAllMocks();
    mockSaveGlobalConfig.mockResolvedValue(undefined);
  });

  vIt("removes sws key from config", async () => {
    const config = {
      sws: { auth_token: "some-token", token_expires_at: "2026-01-01T00:00:00Z" },
      broker: { provider: "manual", mode: "paper" },
      telegram: { enabled: false },
    };
    mockLoadGlobalConfig.mockResolvedValue({ ...config });

    await swsLogout();

    vExpect(mockSaveGlobalConfig).toHaveBeenCalledOnce();
    const savedConfig = mockSaveGlobalConfig.mock.calls[0][0] as Record<string, unknown>;
    vExpect(savedConfig["sws"]).toBeUndefined();
  });
});

vDescribe("findChromePath", () => {
  vIt("returns CHROME_PATH env var when set", () => {
    const original = process.env["CHROME_PATH"];
    process.env["CHROME_PATH"] = "/custom/path/to/chrome";
    try {
      const result = findChromePath();
      vExpect(result).toBe("/custom/path/to/chrome");
    } finally {
      if (original === undefined) {
        delete process.env["CHROME_PATH"];
      } else {
        process.env["CHROME_PATH"] = original;
      }
    }
  });
});

vDescribe("swsListScreeners", () => {
  vIt("returns non-empty array with slug, id, description", () => {
    const screeners = swsListScreeners();

    vExpect(screeners.length).toBeGreaterThan(0);

    for (const screener of screeners) {
      vExpect(typeof screener.slug).toBe("string");
      vExpect(screener.slug.length).toBeGreaterThan(0);
      vExpect(typeof screener.id).toBe("string");
      vExpect(screener.id.length).toBeGreaterThan(0);
      vExpect(typeof screener.description).toBe("string");
      vExpect(screener.description.length).toBeGreaterThan(0);
    }
  });
});
