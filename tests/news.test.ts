import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external deps before importing the module under test
vi.mock("@zvec/zvec", () => ({
  ZVecDataType: { STRING: 2, BOOL: 3, VECTOR_FP32: 23 },
  ZVecIndexType: { HNSW: 1, INVERT: 10 },
  ZVecMetricType: { COSINE: 3 },
  ZVecCollectionSchema: vi.fn().mockImplementation(() => ({})),
  ZVecCreateAndOpen: vi.fn().mockReturnValue({
    insertSync: vi.fn(),
    upsertSync: vi.fn(),
    querySync: vi.fn().mockReturnValue([]),
    fetchSync: vi.fn().mockReturnValue({}),
    deleteSync: vi.fn(),
    deleteByFilterSync: vi.fn(),
    updateSync: vi.fn(),
    closeSync: vi.fn(),
  }),
  ZVecOpen: vi.fn().mockImplementation(() => {
    throw new Error("Collection not found");
  }),
}));

vi.mock("fastembed", () => ({
  EmbeddingModel: { AllMiniLML6V2: "fast-all-MiniLM-L6-v2" },
  FlagEmbedding: {
    init: vi.fn().mockResolvedValue({
      queryEmbed: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
      embed: vi.fn(),
    }),
  },
}));

import { parseRssXml, detectTickers, isHighImpact } from "../src/services/news.service.js";

describe("parseRssXml", () => {
  it("parses standard RSS 2.0 feed", () => {
    const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>Gold surges to new high</title>
          <link>https://example.com/gold</link>
          <description>Gold prices reached $2,400 per ounce.</description>
          <pubDate>Mon, 23 Mar 2026 10:00:00 GMT</pubDate>
        </item>
      </channel>
    </rss>`;
    const articles = parseRssXml(xml, "TestSource", "macro");
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Gold surges to new high");
    expect(articles[0].source).toBe("TestSource");
    expect(articles[0].category).toBe("macro");
    expect(articles[0].url).toBe("https://example.com/gold");
    expect(articles[0].snippet).toContain("Gold prices");
  });

  it("handles empty feed gracefully", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>`;
    const articles = parseRssXml(xml, "Empty", "market");
    expect(articles).toHaveLength(0);
  });

  it("handles Atom feeds", () => {
    const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Fed holds rates</title>
        <link href="https://example.com/fed"/>
        <summary>The Federal Reserve held rates steady.</summary>
        <published>2026-03-23T10:00:00Z</published>
      </entry>
    </feed>`;
    const articles = parseRssXml(xml, "AtomSource", "macro");
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe("Fed holds rates");
  });

  it("generates a unique SHA256 id from URL", () => {
    const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>Test</title>
          <link>https://example.com/unique</link>
          <description>Desc</description>
        </item>
      </channel>
    </rss>`;
    const articles = parseRssXml(xml, "Src", "cat");
    expect(articles[0].id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("strips HTML from description", () => {
    const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>HTML Test</title>
          <link>https://example.com/html</link>
          <description>&lt;p&gt;Some &lt;b&gt;bold&lt;/b&gt; text&lt;/p&gt;</description>
        </item>
      </channel>
    </rss>`;
    const articles = parseRssXml(xml, "Src", "cat");
    expect(articles[0].snippet).not.toContain("<");
  });

  it("truncates snippet to 200 chars", () => {
    const longDesc = "A".repeat(500);
    const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>Long</title>
          <link>https://example.com/long</link>
          <description>${longDesc}</description>
        </item>
      </channel>
    </rss>`;
    const articles = parseRssXml(xml, "Src", "cat");
    expect(articles[0].snippet.length).toBeLessThanOrEqual(200);
  });
});

describe("detectTickers", () => {
  it("detects $TICKER format", () => {
    expect(detectTickers("$AAPL surges 5%", ["AAPL", "MSFT"])).toEqual(["AAPL"]);
  });

  it("detects (TICKER) format", () => {
    expect(detectTickers("Apple (AAPL) reports earnings", ["AAPL"])).toEqual(["AAPL"]);
  });

  it("detects bare tickers from known set", () => {
    expect(detectTickers("GDXJ and GLD fall sharply", ["GDXJ", "GLD", "SPY"])).toEqual(["GDXJ", "GLD"]);
  });

  it("returns empty for no matches", () => {
    expect(detectTickers("Market is flat today", ["AAPL"])).toEqual([]);
  });

  it("deduplicates tickers", () => {
    expect(detectTickers("$AAPL and AAPL both mentioned", ["AAPL"])).toEqual(["AAPL"]);
  });
});

describe("isHighImpact", () => {
  it("detects breaking news keywords", () => {
    expect(isHighImpact("BREAKING: Fed announces emergency rate cut")).toBe(true);
  });

  it("detects earnings keywords", () => {
    expect(isHighImpact("AAPL earnings beat expectations")).toBe(true);
  });

  it("returns false for routine news", () => {
    expect(isHighImpact("Markets open slightly higher")).toBe(false);
  });

  it("detects FOMC keyword", () => {
    expect(isHighImpact("FOMC meeting minutes released")).toBe(true);
  });

  it("detects rate hike keyword (multi-word)", () => {
    expect(isHighImpact("Central bank signals rate hike")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isHighImpact("company files for BANKRUPTCY")).toBe(true);
  });
});
