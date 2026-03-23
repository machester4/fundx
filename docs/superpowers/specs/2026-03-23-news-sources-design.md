# News Sources Design

## Problem

FundX has limited news coverage — only FMP, Alpaca, and Yahoo Finance. There's no Bloomberg, Reuters, or other editorial sources. News is pull-only (agent must explicitly query), there's no cache, no semantic search, and no breaking news alerts.

## Design Decisions

- **Sources:** Configurable RSS feeds with defaults (Bloomberg, Reuters, CNBC, MarketWatch). User adds/removes in `config.yaml`.
- **Storage:** Zvec vector database (`@zvec/zvec`) — in-process, no server. Enables semantic similarity search across articles.
- **Fetch:** Daemon cron fetches RSS every 5 min during market hours, 30 min off-hours. Articles cached with embeddings.
- **Agent access:** New `get_rss_news` MCP tool with semantic search + structured filters.
- **Alerts:** Breaking news detection post-fetch, Telegram alerts when high-impact articles match fund tickers.

---

## Section 1: RSS Feed System with Zvec

### Config in `~/.fundx/config.yaml`

```yaml
news:
  feeds:
    - name: Bloomberg
      url: https://feeds.bloomberg.com/markets/news.rss
      category: macro
    - name: Reuters
      url: https://www.reutersagency.com/feed/?best-topics=business-finance
      category: macro
    - name: CNBC
      url: https://www.cnbc.com/id/100003114/device/rss/rss.html
      category: market
    - name: MarketWatch
      url: https://feeds.marketwatch.com/marketwatch/topstories
      category: market
  fetch_interval_minutes: 5
  max_articles_per_feed: 20
  retention_days: 7
```

Defaults are Bloomberg + Reuters + CNBC + MarketWatch. Users can add any RSS feed with `name`, `url`, and `category` (macro, market, sector, commodity, crypto, etc.).

### Zvec Storage

`~/.fundx/news_cache.zvec` — single collection for all articles.

**Schema per article:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | SHA256(url) — dedup key |
| `title` | string | Headline |
| `source` | string | Feed name (Bloomberg, Reuters, etc.) |
| `category` | string | Feed category |
| `url` | string | Article URL |
| `published_at` | string | ISO timestamp from RSS |
| `fetched_at` | string | When we fetched it |
| `symbols` | string | JSON array of detected tickers |
| `snippet` | string | First ~200 chars of RSS description |
| `embedding` | vector | Embedding of title + snippet for semantic search |

### Embeddings

Generated at insert time for each article. Uses a lightweight text embedding approach consistent with the existing trade journal (`src/embeddings.ts`). The embedding covers `title + " " + snippet` to capture the article's semantic meaning.

### Advantages over plain SQLite

- **Semantic search**: "monetary policy news" finds relevant articles without exact keyword match
- **Similarity clustering**: natural dedup of semantically identical articles from different sources
- **Hybrid queries**: combine vector similarity with structured filters (source, category, date range, symbols)

### New dependency

`@zvec/zvec` — in-process vector database, no external server needed. npm package with macOS ARM64 + Linux support.

### New files

- `src/services/news.service.ts` — fetch, parse, embed, store, query, cleanup

### Modified files

- `src/types.ts` — news feed config schema, article schema
- `src/config.ts` — default news feeds
- `src/paths.ts` — `NEWS_CACHE` path constant

---

## Section 2: Daemon Integration + Ticker Detection

### Fetch cron in daemon

New cron schedule in `daemon.service.ts`:

- **Market hours (8:00-19:00 UTC):** fetch every `fetch_interval_minutes` (default 5 min)
- **Off-hours:** fetch every 30 min
- Uses `fast-xml-parser` for RSS parsing (lightweight, no native deps)
- Deduplicates by URL hash before inserting
- Cleans articles older than `retention_days` once daily

### Ticker detection (best-effort)

After fetching each article, detect mentioned tickers:

1. Match patterns: `$AAPL`, `(AAPL)`, or bare uppercase tickers
2. For each active fund, build a set of known tickers from `universe.allowed` + `portfolio.positions`
3. Match article title + snippet against these tickers
4. Store matched tickers in `symbols` field as JSON array

This is pattern matching, not NLP. The agent (Claude) does deeper analysis when it reads articles.

### New dependency

`fast-xml-parser` — RSS/XML parsing

### Modified files

- `src/services/daemon.service.ts` — add news fetch cron schedule, call `fetchAllFeeds()` and `checkBreakingNews()`
- `src/services/news.service.ts` — `fetchAllFeeds()`, `parseRssFeed()`, `detectTickers()`, `cleanOldArticles()`

---

## Section 3: MCP Tool + Agent Access

### New tool `get_rss_news` in `src/mcp/market-data.ts`

```
get_rss_news({
  query?: string,        // semantic search (embedded and compared via zvec)
  symbols?: string,      // filter by ticker (comma-separated)
  category?: string,     // macro, market, sector, commodity
  source?: string,       // Bloomberg, Reuters, etc.
  hours?: number,        // last N hours (default 24)
  limit?: number,        // max articles (default 20)
})
```

**Query modes:**

- **No query, no filters** → latest articles across all feeds
- **Query only** → semantic similarity search ("gold miners selloff")
- **Filters only** → structured filter (source=Bloomberg, hours=4)
- **Query + filters** → hybrid: semantic similarity within filtered subset

**Returns:** list of articles with title, source, timestamp, snippet, url, symbols, and relevance score (when query provided).

### Integration with existing tools

`get_news` (FMP/Alpaca/Yahoo) remains unchanged — it provides structured market data with price context. `get_rss_news` provides editorial coverage. They are complementary.

The `news-analyst` sub-agent prompt in `src/subagent.ts` is updated to mention both tools.

### Modified files

- `src/mcp/market-data.ts` — add `get_rss_news` tool
- `src/subagent.ts` — update news-analyst prompt to mention `get_rss_news`

---

## Section 4: Breaking News Alerts via Telegram

### Detection logic

After each RSS fetch cycle, `checkBreakingNews()` runs:

1. For each **new** article (not previously seen):
   - Check if it mentions tickers of any active fund
   - Check for high-impact keywords: "breaking", "halt", "crash", "surge", "FDA", "FOMC", "earnings", "bankruptcy", "acquisition", "downgrade", "upgrade", "default", "sanctions"
   - If matches fund ticker + high-impact keyword → trigger alert

### Alert format

```
[NEWS] Bloomberg
GDXJ, GLD mentioned

Fed holds rates steady, signals no cuts in 2026

Funds: pm-survivor, runway-metal
```

### Dedup and rate limiting

- Track alerted article IDs in memory (Set) — no duplicate alerts
- Max 1 alert per fund every 10 minutes (avoid spam during volatile sessions)
- Respect fund's `notifications.quiet_hours` config
- Uses existing `sendTelegramNotification` from `gateway.service.ts`

### Modified files

- `src/services/news.service.ts` — `checkBreakingNews()` function
- `src/services/daemon.service.ts` — call `checkBreakingNews()` after fetch

---

## Files Summary

### New files

| File | Purpose |
|------|---------|
| `src/services/news.service.ts` | RSS fetch, parse, embed, store (zvec), query, ticker detection, breaking news alerts, cleanup |

### Modified files

| File | Changes |
|------|---------|
| `src/types.ts` | News feed config schema (`NewsFeedConfig`), article schema |
| `src/paths.ts` | `NEWS_CACHE` path constant for zvec database |
| `src/config.ts` | Default news feeds in global config |
| `src/services/daemon.service.ts` | News fetch cron schedule + breaking news check |
| `src/mcp/market-data.ts` | New `get_rss_news` tool with semantic + hybrid search |
| `src/subagent.ts` | Update news-analyst prompt |

### New dependencies

| Package | Purpose |
|---------|---------|
| `@zvec/zvec` | In-process vector database for article storage + semantic search |
| `fast-xml-parser` | RSS/XML feed parsing |

### Unchanged

- `src/services/market.service.ts` — existing FMP/Alpaca/Yahoo news unchanged
- `src/mcp/market-data.ts` existing tools — `get_news`, `get_market_movers` unchanged
- `src/services/gateway.service.ts` — uses existing `sendTelegramNotification`
