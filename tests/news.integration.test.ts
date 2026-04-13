/**
 * Integration test for the RSS news pipeline — exercises real zvec + fastembed.
 *
 * Gated behind RUN_INTEGRATION=1 because fastembed downloads a ~100 MB model
 * on first use, which we don't want to pay for in normal CI.
 *
 * Run with:  RUN_INTEGRATION=1 pnpm test news.integration
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shouldRun = process.env.RUN_INTEGRATION === "1";
const describeIntegration = shouldRun ? describe : describe.skip;

describeIntegration("news service — real zvec + fastembed round-trip", () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Must be set before paths.ts is imported (which happens lazily below)
    tmpDir = await mkdtemp(join(tmpdir(), "fundx-news-integration-"));
    process.env.FUNDX_NEWS_DIR = tmpDir;

    // Stub global fetch to serve 3 synthetic RSS articles with distinct semantic topics
    const rssXml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <item>
        <title>Gold miners surge on rising bullion prices</title>
        <link>https://example.com/gold-miners</link>
        <description>GDX and GDXJ rally as gold spot breaks $2400.</description>
        <pubDate>${new Date().toUTCString()}</pubDate>
      </item>
      <item>
        <title>Treasury yields climb after strong jobs report</title>
        <link>https://example.com/yields</link>
        <description>The 10-year Treasury yield jumped after payrolls beat estimates.</description>
        <pubDate>${new Date().toUTCString()}</pubDate>
      </item>
      <item>
        <title>Bitcoin consolidates above key support</title>
        <link>https://example.com/btc</link>
        <description>BTC trades sideways as ETF inflows slow.</description>
        <pubDate>${new Date().toUTCString()}</pubDate>
      </item>
    </channel></rss>`;

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => rssXml,
    } as unknown as Response));

    // Stub fund discovery so the service doesn't try to read real funds
    vi.doMock("../src/services/fund.service.js", () => ({
      listFundNames: async () => [],
      loadFundConfig: async () => { throw new Error("not used"); },
    }));
    vi.doMock("../src/state.js", async () => {
      const actual = await vi.importActual<typeof import("../src/state.js")>("../src/state.js");
      return { ...actual, readPortfolio: async () => null };
    });
    // Stub global config so feeds list is well-defined
    vi.doMock("../src/config.js", () => ({
      loadGlobalConfig: async () => ({
        news: {
          feeds: [{ name: "TestSource", url: "https://example.com/feed.xml", category: "macro" }],
          max_articles_per_feed: 20,
          retention_days: 7,
        },
      }),
    }));
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.resetModules();
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    delete process.env.FUNDX_NEWS_DIR;
  });

  it("ingests articles and returns semantically ranked results", async () => {
    const { fetchAllFeeds, queryArticles, getNewsStats } = await import(
      "../src/services/news.service.js"
    );

    // Ingest — parses RSS, embeds via real fastembed, upserts to real zvec
    const inserted = await fetchAllFeeds();
    expect(inserted.length).toBe(3);

    // Cache reports the ingested articles
    const stats = await getNewsStats();
    expect(stats.status).toBe("ok");
    expect(stats.total).toBe(3);

    // Semantic query "precious metals" should rank the gold article first
    const goldResult = await queryArticles({ query: "precious metals", limit: 5 });
    expect(goldResult.status).toBe("ok");
    if (goldResult.status === "ok") {
      expect(goldResult.articles.length).toBeGreaterThan(0);
      expect(goldResult.articles[0].title.toLowerCase()).toContain("gold");
    }

    // Semantic query "crypto" should rank bitcoin article first
    const btcResult = await queryArticles({ query: "cryptocurrency", limit: 5 });
    expect(btcResult.status).toBe("ok");
    if (btcResult.status === "ok") {
      expect(btcResult.articles[0].title.toLowerCase()).toContain("bitcoin");
    }

    // Filter-only query (no vector) returns all 3
    const all = await queryArticles({ hours: 24, limit: 10 });
    expect(all.status).toBe("ok");
    if (all.status === "ok") {
      expect(all.articles.length).toBe(3);
    }

    // Empty window returns empty (not unavailable)
    const empty = await queryArticles({ hours: 0.0001, limit: 5 });
    // With hours ~0, cutoff is nearly "now" and articles were just inserted;
    // so this might or might not be empty. Accept either ok or empty, but NOT unavailable.
    expect(empty.status === "ok" || empty.status === "empty").toBe(true);
  }, 120_000);

});
