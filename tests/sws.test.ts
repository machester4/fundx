import { describe, it, expect, vi, beforeEach } from "vitest";
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
      value: 5, future: 4, health: 6, past: 3, dividend: 2,
    });
    expect(result.value).toBe(5);
  });

  it("rejects missing fields", () => {
    expect(() => swsSnowflakeSchema.parse({ value: 8, future: 6 })).toThrow();
  });
});

describe("swsCompanySchema", () => {
  const validCompany = {
    id: 12345,
    name: "Apple Inc",
    tickerSymbol: "AAPL",
    uniqueSymbol: "NasdaqGS:AAPL",
    exchangeSymbol: "NasdaqGS",
    score: { value: 5, future: 4, health: 6, past: 5, dividend: 3 },
    primaryIndustry: { id: 1, name: "Consumer Electronics", slug: "consumer-electronics" },
  };

  it("validates a full company object", () => {
    const result = swsCompanySchema.parse(validCompany);
    expect(result.uniqueSymbol).toBe("NasdaqGS:AAPL");
  });

  it("validates a minimal company (only required fields)", () => {
    const result = swsCompanySchema.parse(validCompany);
    expect(result.analysisValue).toBeUndefined();
    expect(result.info).toBeUndefined();
  });

  it("accepts null values for nullable optional fields", () => {
    const result = swsCompanySchema.parse({
      ...validCompany,
      analysisValue: { return1d: null, marketCap: null, lastSharePrice: 190.5 },
    });
    expect(result.analysisValue?.return1d).toBeNull();
  });

  it("rejects missing required fields", () => {
    expect(() => swsCompanySchema.parse({ id: 1, name: "Incomplete" })).toThrow();
  });
});

describe("swsScreenerResultSchema", () => {
  it("validates a screener result", () => {
    const result = swsScreenerResultSchema.parse({ totalHits: 100, companies: [] });
    expect(result.totalHits).toBe(100);
  });

  it("defaults companies to empty array when omitted", () => {
    const result = swsScreenerResultSchema.parse({ totalHits: 0 });
    expect(result.companies).toEqual([]);
  });
});

describe("swsSearchResultSchema", () => {
  it("validates a search result with score", () => {
    const result = swsSearchResultSchema.parse({
      id: 1, name: "Apple Inc", tickerSymbol: "AAPL",
      uniqueSymbol: "NasdaqGS:AAPL", exchangeSymbol: "NasdaqGS",
      score: { value: 5, future: 4, health: 6, past: 5, dividend: 3 },
    });
    expect(result.score?.value).toBe(5);
  });

  it("validates a search result without score", () => {
    const result = swsSearchResultSchema.parse({
      id: 2, name: "Test Corp", tickerSymbol: "TST",
      uniqueSymbol: "NYSE:TST", exchangeSymbol: "NYSE",
    });
    expect(result.score).toBeUndefined();
  });
});

// ── SWS Service tests ─────────────────────────────────────────

vi.mock("../src/config.js", () => ({
  loadGlobalConfig: vi.fn(),
  saveGlobalConfig: vi.fn(),
}));

import { loadGlobalConfig, saveGlobalConfig } from "../src/config.js";
import {
  swsTokenStatus,
  swsLogout,
  findChromePath,
  swsListScreeners,
} from "../src/services/sws.service.js";

const mockLoadGlobalConfig = vi.mocked(loadGlobalConfig);
const mockSaveGlobalConfig = vi.mocked(saveGlobalConfig);

describe("swsTokenStatus", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns invalid when no token configured", async () => {
    mockLoadGlobalConfig.mockResolvedValue({ sws: undefined } as never);
    const status = await swsTokenStatus();
    expect(status.valid).toBe(false);
    expect(status.expiresAt).toBeNull();
    expect(status.expiresInHours).toBeNull();
  });

  it("returns valid when token exists and not expired", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    mockLoadGlobalConfig.mockResolvedValue({
      sws: { auth_token: "test-token", token_expires_at: futureDate },
    } as never);
    const status = await swsTokenStatus();
    expect(status.valid).toBe(true);
    expect(status.expiresInHours).toBeGreaterThan(0);
  });

  it("returns invalid when token is expired", async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    mockLoadGlobalConfig.mockResolvedValue({
      sws: { auth_token: "test-token", token_expires_at: pastDate },
    } as never);
    const status = await swsTokenStatus();
    expect(status.valid).toBe(false);
    expect(status.expiresInHours).toBe(0);
  });
});

describe("swsLogout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveGlobalConfig.mockResolvedValue(undefined);
  });

  it("removes sws key from config", async () => {
    mockLoadGlobalConfig.mockResolvedValue({
      sws: { auth_token: "some-token", token_expires_at: "2026-01-01T00:00:00Z" },
    } as never);
    await swsLogout();
    expect(mockSaveGlobalConfig).toHaveBeenCalledOnce();
    const savedConfig = mockSaveGlobalConfig.mock.calls[0][0] as Record<string, unknown>;
    expect(savedConfig["sws"]).toBeUndefined();
  });
});

describe("findChromePath", () => {
  it("returns CHROME_PATH env var when set", () => {
    const original = process.env["CHROME_PATH"];
    process.env["CHROME_PATH"] = "/custom/path/to/chrome";
    try {
      expect(findChromePath()).toBe("/custom/path/to/chrome");
    } finally {
      if (original === undefined) delete process.env["CHROME_PATH"];
      else process.env["CHROME_PATH"] = original;
    }
  });
});

describe("swsListScreeners", () => {
  it("returns non-empty array with slug, id, description", () => {
    const screeners = swsListScreeners();
    expect(screeners.length).toBeGreaterThan(0);
    for (const s of screeners) {
      expect(typeof s.slug).toBe("string");
      expect(typeof s.id).toBe("number");
      expect(typeof s.description).toBe("string");
    }
  });
});
