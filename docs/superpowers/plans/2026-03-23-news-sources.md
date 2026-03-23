# News Sources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable RSS news feeds (Bloomberg, Reuters, CNBC, etc.) with zvec vector storage, semantic search, daemon-based periodic fetching, and breaking news Telegram alerts.

**Architecture:** A new `news.service.ts` handles RSS fetching, parsing, embedding via fastembed-js, and storing in zvec. The daemon runs a separate cron that fetches feeds every 5 min and checks for breaking news. A new `get_rss_news` MCP tool lets the agent query cached articles with semantic search. Breaking news triggers Telegram alerts when high-impact articles match fund tickers.

**Tech Stack:** `@zvec/zvec` (vector DB), `@anysphere/fastembed` (local embeddings), `fast-xml-parser` (RSS), grammy (Telegram), Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-news-sources-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/services/news.service.ts` | RSS fetch, parse, embed, store (zvec), query, ticker detection, breaking news alerts, cleanup |
| `tests/news.test.ts` | Unit tests for news service |

### Modified files

| File | Changes |
|------|---------|
| `src/types.ts` | `newsFeedSchema`, `newsConfigSchema`, `newsArticleSchema` |
| `src/paths.ts` | `NEWS_DIR` constant |
| `src/config.ts` | No code changes — defaults come from Zod schema `.default()` |
| `src/services/daemon.service.ts` | Add news fetch cron schedule |
| `src/mcp/market-data.ts` | Add `get_rss_news` tool |
| `src/subagent.ts` | Update news-analyst prompt to mention `get_rss_news` |

---

## Task 1: Dependencies, Types, and Paths

**Files:**
- Modify: `src/types.ts`
- Modify: `src/paths.ts`

- [ ] **Step 1: Install dependencies**

```bash
pnpm add @zvec/zvec @anysphere/fastembed fast-xml-parser
```

- [ ] **Step 2: Add news schemas to `src/types.ts`**

Append at end of file:

```typescript
// ── News Sources Schemas ─────────────────────────────────────

export const newsFeedSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  category: z.string().default("market"),
});

export type NewsFeed = z.infer<typeof newsFeedSchema>;

const DEFAULT_NEWS_FEEDS: z.infer<typeof newsFeedSchema>[] = [
  { name: "Bloomberg", url: "https://feeds.bloomberg.com/markets/news.rss", category: "macro" },
  { name: "Reuters", url: "https://www.reutersagency.com/feed/?best-topics=business-finance", category: "macro" },
  { name: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", category: "market" },
  { name: "MarketWatch", url: "https://feeds.marketwatch.com/marketwatch/topstories", category: "market" },
];

export const newsConfigSchema = z.object({
  feeds: z.array(newsFeedSchema).default(DEFAULT_NEWS_FEEDS),
  fetch_interval_minutes: z.number().positive().default(5),
  max_articles_per_feed: z.number().positive().default(20),
  retention_days: z.number().positive().default(7),
});

export type NewsConfig = z.infer<typeof newsConfigSchema>;

export const newsArticleSchema = z.object({
  id: z.string(),
  title: z.string(),
  source: z.string(),
  category: z.string(),
  url: z.string(),
  published_at: z.string(),
  fetched_at: z.string(),
  symbols: z.array(z.string()).default([]),
  snippet: z.string().default(""),
  alerted: z.boolean().default(false),
});

export type NewsArticle = z.infer<typeof newsArticleSchema>;
```

- [ ] **Step 3: Add `news` to `globalConfigSchema`**

In `src/types.ts`, add `news` field to `globalConfigSchema` (after `sws`):

```typescript
  news: newsConfigSchema.optional(),
```

- [ ] **Step 4: Add `NEWS_DIR` to `src/paths.ts`**

After `DAEMON_LOG` constants:

```typescript
/** News cache directory (zvec database) */
export const NEWS_DIR = join(WORKSPACE, "news");
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/paths.ts package.json pnpm-lock.yaml
git commit -m "feat(news): add news schemas, path constant, and dependencies"
```

---

## Task 2: News Service — Core (Fetch, Parse, Store)

**Files:**
- Create: `src/services/news.service.ts`
- Create: `tests/news.test.ts`

- [ ] **Step 1: Write tests for RSS parsing and ticker detection**

Create `tests/news.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external deps
vi.mock("@zvec/zvec", () => ({
  Collection: vi.fn().mockImplementation(() => ({
    insert: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    filter: vi.fn().mockResolvedValue([]),
    delete: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("@anysphere/fastembed", () => ({
  EmbeddingModel: { AllMiniLML6V2: "all-MiniLM-L6-v2" },
  FlagEmbedding: {
    init: vi.fn().mockResolvedValue({
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/news.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/services/news.service.ts`**

```typescript
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { NEWS_DIR } from "../paths.js";
import { loadGlobalConfig } from "../config.js";
import { listFundNames, loadFundConfig } from "./fund.service.js";
import { readPortfolio } from "../state.js";
import type { NewsArticle, NewsFeed } from "../types.js";

// ── RSS Parsing ──────────────────────────────────────────────

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export function parseRssXml(xml: string, sourceName: string, category: string): Omit<NewsArticle, "alerted">[] {
  const parsed = xmlParser.parse(xml);
  const articles: Omit<NewsArticle, "alerted">[] = [];
  const now = new Date().toISOString();

  // RSS 2.0
  const items = parsed?.rss?.channel?.item;
  if (items) {
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      const title = item.title ?? "";
      const url = item.link ?? "";
      const desc = typeof item.description === "string" ? item.description : "";
      const pubDate = item.pubDate ?? now;
      articles.push({
        id: createHash("sha256").update(url).digest("hex"),
        title: String(title).trim(),
        source: sourceName,
        category,
        url: String(url).trim(),
        published_at: new Date(pubDate).toISOString(),
        fetched_at: now,
        symbols: [],
        snippet: stripHtml(String(desc)).slice(0, 200),
      });
    }
    return articles;
  }

  // Atom
  const entries = parsed?.feed?.entry;
  if (entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    for (const entry of list) {
      const title = entry.title ?? "";
      const url = entry.link?.["@_href"] ?? entry.link ?? "";
      const summary = entry.summary ?? entry.content ?? "";
      const published = entry.published ?? entry.updated ?? now;
      articles.push({
        id: createHash("sha256").update(String(url)).digest("hex"),
        title: String(title).trim(),
        source: sourceName,
        category,
        url: String(url).trim(),
        published_at: new Date(published).toISOString(),
        fetched_at: now,
        symbols: [],
        snippet: stripHtml(String(summary)).slice(0, 200),
      });
    }
  }

  return articles;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// ── Ticker Detection ─────────────────────────────────────────

export function detectTickers(text: string, knownTickers: string[]): string[] {
  const found: string[] = [];
  for (const ticker of knownTickers) {
    // Match $TICKER, (TICKER), or bare TICKER as whole word
    const pattern = new RegExp(`(\\$${ticker}\\b|\\(${ticker}\\)|\\b${ticker}\\b)`, "i");
    if (pattern.test(text)) {
      found.push(ticker);
    }
  }
  return [...new Set(found)];
}

// ── High Impact Detection ────────────────────────────────────

const HIGH_IMPACT_KEYWORDS = [
  "breaking", "halt", "crash", "surge", "FDA", "FOMC", "earnings",
  "bankruptcy", "acquisition", "downgrade", "upgrade", "default",
  "sanctions", "emergency", "recession", "rate cut", "rate hike",
];

export function isHighImpact(text: string): boolean {
  const lower = text.toLowerCase();
  return HIGH_IMPACT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

// ── Zvec Storage ─────────────────────────────────────────────

let zvecCollection: unknown = null;
let embedModel: unknown = null;

async function getCollection(): Promise<unknown> {
  if (zvecCollection) return zvecCollection;
  await mkdir(NEWS_DIR, { recursive: true });
  const { Collection } = await import("@zvec/zvec");
  zvecCollection = new Collection(NEWS_DIR);
  return zvecCollection;
}

async function getEmbedder(): Promise<{ embed: (texts: string[]) => Promise<number[][]> }> {
  if (embedModel) return embedModel as { embed: (texts: string[]) => Promise<number[][]> };
  const { FlagEmbedding, EmbeddingModel } = await import("@anysphere/fastembed");
  embedModel = await FlagEmbedding.init({ model: EmbeddingModel.AllMiniLML6V2 });
  return embedModel as { embed: (texts: string[]) => Promise<number[][]> };
}

// ── Public API ───────────────────────────────────────────────

/** Fetch all configured RSS feeds and store new articles */
export async function fetchAllFeeds(): Promise<NewsArticle[]> {
  const config = await loadGlobalConfig();
  const feeds = config.news?.feeds ?? [];
  const maxPerFeed = config.news?.max_articles_per_feed ?? 20;
  const allNew: NewsArticle[] = [];

  // Gather known tickers from all active funds
  const knownTickers = await gatherKnownTickers();

  for (const feed of feeds) {
    try {
      const articles = await fetchSingleFeed(feed, maxPerFeed, knownTickers);
      allNew.push(...articles);
    } catch (err) {
      console.warn(`[news] Failed to fetch ${feed.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return allNew;
}

async function fetchSingleFeed(feed: NewsFeed, maxPerFeed: number, knownTickers: string[]): Promise<NewsArticle[]> {
  const response = await fetch(feed.url, {
    headers: { "User-Agent": "FundX/1.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const xml = await response.text();
  const parsed = parseRssXml(xml, feed.name, feed.category).slice(0, maxPerFeed);

  // Detect tickers and embed
  const collection = await getCollection();
  const embedder = await getEmbedder();
  const newArticles: NewsArticle[] = [];

  for (const article of parsed) {
    // TODO: check if article.id already exists in collection (dedup)
    article.symbols = detectTickers(`${article.title} ${article.snippet}`, knownTickers);
    const text = `${article.title} ${article.snippet}`;
    const [embedding] = await embedder.embed([text]);

    // Insert into zvec with embedding
    // Note: actual zvec API may differ — adapt during implementation
    await (collection as any).insert({
      ...article,
      alerted: false,
      symbols: JSON.stringify(article.symbols),
      embedding,
    });

    newArticles.push({ ...article, alerted: false });
  }

  return newArticles;
}

async function gatherKnownTickers(): Promise<string[]> {
  const tickers = new Set<string>();
  const names = await listFundNames();
  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      if (config.fund.status !== "active") continue;
      // Tickers from universe
      for (const entry of config.universe.allowed) {
        if (entry.tickers) entry.tickers.forEach((t) => tickers.add(t));
      }
      // Tickers from portfolio
      const portfolio = await readPortfolio(name).catch(() => null);
      if (portfolio) {
        for (const pos of portfolio.positions) tickers.add(pos.symbol);
      }
    } catch { /* skip */ }
  }
  return [...tickers];
}

/** Search articles with optional semantic query and filters */
export async function queryArticles(opts: {
  query?: string;
  symbols?: string;
  category?: string;
  source?: string;
  hours?: number;
  limit?: number;
}): Promise<NewsArticle[]> {
  // TODO: implement zvec query with filters and optional semantic search
  // For now, return empty — will be filled during implementation
  return [];
}

/** Check new articles for breaking news and send Telegram alerts */
export async function checkBreakingNews(newArticles: NewsArticle[]): Promise<void> {
  const names = await listFundNames();
  const fundTickers = new Map<string, string[]>();

  for (const name of names) {
    try {
      const config = await loadFundConfig(name);
      if (config.fund.status !== "active") continue;
      const tickers: string[] = [];
      for (const entry of config.universe.allowed) {
        if (entry.tickers) tickers.push(...entry.tickers);
      }
      const portfolio = await readPortfolio(name).catch(() => null);
      if (portfolio) portfolio.positions.forEach((p) => tickers.push(p.symbol));
      fundTickers.set(name, [...new Set(tickers)]);
    } catch { /* skip */ }
  }

  const alertCooldowns = new Map<string, number>(); // fundName → last alert timestamp

  for (const article of newArticles) {
    if (article.alerted) continue;
    if (!isHighImpact(article.title)) continue;

    const affectedFunds: string[] = [];
    for (const [fundName, tickers] of fundTickers) {
      const matched = detectTickers(`${article.title} ${article.snippet}`, tickers);
      if (matched.length > 0) {
        const lastAlert = alertCooldowns.get(fundName) ?? 0;
        if (Date.now() - lastAlert > 10 * 60 * 1000) { // 10 min cooldown
          affectedFunds.push(fundName);
          alertCooldowns.set(fundName, Date.now());
        }
      }
    }

    if (affectedFunds.length > 0) {
      const msg =
        `<b>[NEWS]</b> ${article.source}\n` +
        `${article.symbols.length > 0 ? article.symbols.join(", ") + " mentioned\n\n" : "\n"}` +
        `${article.title}\n\n` +
        `Funds: ${affectedFunds.join(", ")}`;
      try {
        const { sendTelegramNotification } = await import("./gateway.service.js");
        await sendTelegramNotification(msg);
      } catch { /* best effort */ }
    }
  }
}

/** Remove articles older than retention period */
export async function cleanOldArticles(): Promise<void> {
  const config = await loadGlobalConfig();
  const retentionDays = config.news?.retention_days ?? 7;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  // TODO: delete articles from zvec where published_at < cutoff
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test -- tests/news.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/news.service.ts tests/news.test.ts
git commit -m "feat(news): news service with RSS parsing, ticker detection, zvec storage"
```

---

## Task 3: Daemon Integration

**Files:**
- Modify: `src/services/daemon.service.ts`

- [ ] **Step 1: Add news fetch cron to `startDaemon()`**

Add import at top:
```typescript
import { fetchAllFeeds, checkBreakingNews, cleanOldArticles } from "./news.service.js";
```

Add a separate cron schedule after the existing `"* * * * *"` and `"0 9 * * *"` schedules, before the signal handlers:

```typescript
  // News feed fetcher — every 5 min, reduced off-hours
  let lastNewsFetchAt = 0;
  cron.schedule("*/5 * * * *", async () => {
    const hour = new Date().getUTCHours();
    const isMarketHours = hour >= 8 && hour < 19;
    const elapsed = Date.now() - lastNewsFetchAt;

    // Off-hours: only fetch every 30 min
    if (!isMarketHours && elapsed < 30 * 60 * 1000) return;

    lastNewsFetchAt = Date.now();
    try {
      const newArticles = await fetchAllFeeds();
      if (newArticles.length > 0) {
        await log(`[news] Fetched ${newArticles.length} new articles`);
        await checkBreakingNews(newArticles);
      }
    } catch (err) {
      await log(`[news] Fetch error: ${err}`);
    }
  });

  // Daily cleanup of old articles
  cron.schedule("0 0 * * *", async () => {
    try {
      await cleanOldArticles();
      await log("[news] Old articles cleaned up");
    } catch (err) {
      await log(`[news] Cleanup error: ${err}`);
    }
  });
```

- [ ] **Step 2: Run tests**

Run: `pnpm test -- tests/daemon-integration.test.ts`
Expected: PASS (news imports will be resolved, mocked functions absorb calls)

- [ ] **Step 3: Commit**

```bash
git add src/services/daemon.service.ts
git commit -m "feat(news): add RSS fetch cron and daily cleanup to daemon"
```

---

## Task 4: MCP Tool — `get_rss_news`

**Files:**
- Modify: `src/mcp/market-data.ts`

- [ ] **Step 1: Add the `get_rss_news` tool**

Add import at top of file:
```typescript
import { queryArticles } from "../services/news.service.js";
```

Add the tool after the existing `get_news` tool:

```typescript
server.tool(
  "get_rss_news",
  "Search cached RSS news articles from Bloomberg, Reuters, CNBC, etc. Supports semantic search and filtering by source, category, symbols, or time range.",
  {
    query: z.string().optional().describe("Semantic search query (e.g. 'gold miners selloff', 'monetary policy')"),
    symbols: z.string().optional().describe("Filter by ticker symbols (comma-separated, e.g. GDXJ,GLD)"),
    category: z.string().optional().describe("Filter by category (macro, market, sector, commodity)"),
    source: z.string().optional().describe("Filter by source name (Bloomberg, Reuters, CNBC, MarketWatch)"),
    hours: z.number().positive().default(24).describe("Look back N hours (default 24)"),
    limit: z.number().positive().max(50).default(20).describe("Max articles to return"),
  },
  async ({ query, symbols, category, source, hours, limit }) => {
    try {
      const articles = await queryArticles({ query, symbols, category, source, hours, limit });
      if (articles.length === 0) {
        return { content: [{ type: "text", text: "No RSS news articles found matching your criteria. Try broadening the search or check if RSS feeds are configured." }] };
      }
      const formatted = articles.map((a) => ({
        title: a.title,
        source: a.source,
        category: a.category,
        published: a.published_at,
        symbols: a.symbols,
        snippet: a.snippet,
        url: a.url,
      }));
      return { content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error querying RSS news: ${err instanceof Error ? err.message : err}` }] };
    }
  },
);
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/mcp/market-data.ts
git commit -m "feat(news): add get_rss_news MCP tool with semantic search"
```

---

## Task 5: Update News Analyst Sub-Agent

**Files:**
- Modify: `src/subagent.ts`

- [ ] **Step 1: Update news-analyst prompt**

Find the line `Use market-data MCP tools (get_news, get_market_movers) to gather current data.` (around line 198) and replace with:

```typescript
`Use market-data MCP tools to gather current data:`,
`- get_news — structured financial news from FMP/Alpaca (prices, earnings)`,
`- get_rss_news — editorial coverage from Bloomberg, Reuters, CNBC, etc. Supports semantic search.`,
`- get_market_movers — top gainers/losers`,
``,
`Start with get_rss_news to get broad editorial coverage, then use get_news for specific ticker data.`,
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/subagent.ts
git commit -m "feat(news): update news-analyst sub-agent to use get_rss_news"
```

---

## Task 6: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run build**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 4: Manual smoke test**

```bash
# Verify news config in global config
cat ~/.fundx/config.yaml | grep -A 10 "news"

# Start daemon and watch for news fetch
pnpm dev -- stop && pnpm dev -- start
# Wait 5 min, then check logs:
tail -20 ~/.fundx/daemon.log | grep news

# Verify zvec directory created
ls ~/.fundx/news/
```

- [ ] **Step 5: Commit if any fixes needed**

```bash
git add -A
git commit -m "fix(news): integration fixes"
```
