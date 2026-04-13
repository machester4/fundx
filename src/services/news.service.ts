import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { NEWS_DIR } from "../paths.js";
import { loadGlobalConfig } from "../config.js";
import { listFundNames, loadFundConfig } from "./fund.service.js";
import { readPortfolio, readPendingSessions, writePendingSessions, readSessionCounts } from "../state.js";
import { newsConfigSchema, type NewsArticle, type NewsFeed } from "../types.js";

// ── RSS Parsing ──────────────────────────────────────────────

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

/** Safely parse a date string to ISO, falling back to current time on malformed input */
function safeISODate(dateStr: string, fallback: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return fallback;
    return d.toISOString();
  } catch {
    return fallback;
  }
}

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
        id: createHash("sha256").update(String(url)).digest("hex"),
        title: String(title).trim(),
        source: sourceName,
        category,
        url: String(url).trim(),
        published_at: safeISODate(pubDate, now),
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
        published_at: safeISODate(published, now),
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectTickers(text: string, knownTickers: string[]): string[] {
  const found: string[] = [];
  for (const ticker of knownTickers) {
    // Match $TICKER, (TICKER), or bare TICKER as whole word
    const escaped = escapeRegex(ticker);
    const pattern = new RegExp(`(\\$${escaped}\\b|\\(${escaped}\\)|\\b${escaped}\\b)`, "i");
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

// Lazy-initialized zvec collection and fastembed model.
// The zvec collection stores news articles with embeddings for semantic search.
// fastembed provides local text embeddings (AllMiniLML6V2, 384 dimensions).

import type { ZVecCollection, ZVecCollectionSchema as ZVecCollectionSchemaType } from "@zvec/zvec";
import type { FlagEmbedding as FlagEmbeddingType } from "fastembed";

let zvecCollection: ZVecCollection | null = null;
let embedModel: FlagEmbeddingType | null = null;

const COLLECTION_NAME = "news_articles";
const EMBEDDING_DIM = 384; // AllMiniLML6V2

/**
 * Open (or create) the zvec collection.
 *
 * zvec 0.2.3 uses an exclusive lock: only one process can hold a collection
 * at a time, even for readOnly access. That means CLI/MCP subprocesses cannot
 * query while the daemon is running. Callers must handle this — `queryArticles`
 * returns `status: "unavailable"` with the lock error so callers can tell the
 * user/agent that the cache is owned by another process.
 */
async function getCollection(): Promise<ZVecCollection> {
  if (zvecCollection) return zvecCollection;
  await mkdir(NEWS_DIR, { recursive: true });
  const { default: zvec, ZVecDataType } = await import("@zvec/zvec");

  const collectionPath = join(NEWS_DIR, COLLECTION_NAME);

  // Try opening existing collection first; create if it doesn't exist.
  // If another process has the lock, zvec throws "Can't lock read-write collection"
  // and this function propagates it — queryArticles maps it to `unavailable`.
  try {
    zvecCollection = zvec.ZVecOpen(collectionPath);
    return zvecCollection;
  } catch (err) {
    // "Can't lock read-write collection" → another process holds the lock.
    // Rethrow so the caller can report it; don't try to create a new collection.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Can't lock") || msg.includes("read-write")) {
      throw err;
    }
    // Otherwise assume the collection doesn't exist yet — fall through to create.
  }

  const schema = new zvec.ZVecCollectionSchema({
    name: COLLECTION_NAME,
    vectors: {
      name: "embedding",
      dataType: ZVecDataType.VECTOR_FP32,
      dimension: EMBEDDING_DIM,
      indexParams: {
        indexType: zvec.ZVecIndexType.HNSW,
        metricType: zvec.ZVecMetricType.COSINE,
      },
    },
    fields: [
      { name: "title", dataType: ZVecDataType.STRING },
      { name: "source", dataType: ZVecDataType.STRING },
      { name: "category", dataType: ZVecDataType.STRING },
      { name: "url", dataType: ZVecDataType.STRING },
      { name: "published_at", dataType: ZVecDataType.STRING },
      { name: "fetched_at", dataType: ZVecDataType.STRING },
      { name: "symbols", dataType: ZVecDataType.STRING }, // JSON-encoded array
      { name: "snippet", dataType: ZVecDataType.STRING },
      { name: "alerted", dataType: ZVecDataType.BOOL },
    ],
  });

  zvecCollection = zvec.ZVecCreateAndOpen(collectionPath, schema);
  return zvecCollection;
}

async function getEmbedder(): Promise<FlagEmbeddingType> {
  if (embedModel) return embedModel;
  const { FlagEmbedding, EmbeddingModel } = await import("fastembed");
  embedModel = await FlagEmbedding.init({ model: EmbeddingModel.AllMiniLML6V2 });
  return embedModel;
}

/** Helper: embed a single text using fastembed's AsyncGenerator API */
async function embedText(embedder: FlagEmbeddingType, text: string): Promise<number[]> {
  // queryEmbed returns Promise<number[]> for a single query string
  return embedder.queryEmbed(text);
}

// ── Public API ───────────────────────────────────────────────

/** Fetch all configured RSS feeds and store new articles */
export async function fetchAllFeeds(): Promise<NewsArticle[]> {
  const config = await loadGlobalConfig();
  const newsConfig = newsConfigSchema.parse(config.news ?? {});
  const feeds = newsConfig.feeds;
  const maxPerFeed = newsConfig.max_articles_per_feed;
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
    // Dedup: skip if article already in collection
    try {
      const existing = collection.fetchSync(article.id);
      if (existing && Object.keys(existing).length > 0) continue;
    } catch { /* not found — proceed to insert */ }

    article.symbols = detectTickers(`${article.title} ${article.snippet}`, knownTickers);
    const text = `${article.title} ${article.snippet}`;
    const embedding = await embedText(embedder, text);

    // Insert into zvec
    collection.upsertSync({
      id: article.id,
      vectors: { embedding },
      fields: {
        title: article.title,
        source: article.source,
        category: article.category,
        url: article.url,
        published_at: article.published_at,
        fetched_at: article.fetched_at,
        symbols: JSON.stringify(article.symbols),
        snippet: article.snippet,
        alerted: false,
      },
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
    } catch { /* skip funds that fail to load */ }
  }
  return [...tickers];
}

/** Map a zvec result document to a NewsArticle (with optional score) */
function mapZvecDoc(doc: { id: string; fields: Record<string, unknown>; score?: number }): NewsArticle & { score?: number } {
  return {
    id: doc.id,
    title: doc.fields.title as string,
    source: doc.fields.source as string,
    category: doc.fields.category as string,
    url: doc.fields.url as string,
    published_at: doc.fields.published_at as string,
    fetched_at: doc.fields.fetched_at as string,
    symbols: JSON.parse((doc.fields.symbols as string) || "[]"),
    snippet: doc.fields.snippet as string,
    alerted: doc.fields.alerted as boolean,
    ...(doc.score !== undefined && { score: doc.score }),
  };
}

/** Tagged result so callers can distinguish "no matches" from "cache inaccessible". */
export type NewsQueryResult =
  | { status: "ok"; articles: (NewsArticle & { score?: number })[] }
  | { status: "empty"; articles: [] }
  | { status: "unavailable"; articles: []; reason: string };

/** Options accepted by queryArticles / queryArticlesDirect. Extracted so
 * the IPC client/server can share the shape without circular imports. */
export interface QueryArticlesOpts {
  query?: string;
  symbols?: string;
  category?: string;
  source?: string;
  hours?: number;
  limit?: number;
}

/**
 * Direct (zvec-touching) implementation of article search.
 *
 * This is the low-level function; external callers should use `queryArticles`
 * (the router) instead, which transparently delegates to the daemon via IPC
 * when needed so multiple processes can coexist with zvec's single-writer lock.
 */
export async function queryArticlesDirect(opts: QueryArticlesOpts): Promise<NewsQueryResult> {
  let collection: ZVecCollection;
  try {
    collection = await getCollection();
  } catch (err) {
    // Zvec couldn't be opened (e.g. multi-process locking, missing binary, corrupt index).
    // Surface explicitly so callers can tell the agent "cache down" instead of "no news".
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[news] Failed to open zvec collection: ${reason}`);
    return { status: "unavailable", articles: [], reason };
  }
  const maxResults = opts.limit ?? 20;

  // Build zvec filter expression parts
  const filterParts: string[] = [];
  if (opts.source) filterParts.push(`source == "${opts.source}"`);
  if (opts.category) filterParts.push(`category == "${opts.category}"`);
  if (opts.hours) {
    const cutoff = new Date(Date.now() - opts.hours * 60 * 60 * 1000).toISOString();
    filterParts.push(`published_at >= "${cutoff}"`);
  }
  const filter = filterParts.length > 0 ? filterParts.join(" and ") : undefined;

  let results: (NewsArticle & { score?: number })[];

  try {
    if (opts.query) {
      // Semantic search — embed query and search by vector similarity
      const embedder = await getEmbedder();
      const queryEmbedding = await embedText(embedder, opts.query);
      const docs = collection.querySync({
        fieldName: "embedding",
        topk: maxResults,
        vector: queryEmbedding,
        filter,
      });
      results = docs.map(mapZvecDoc);
    } else {
      // Filter-only — query without vector (scalar filter)
      const docs = collection.querySync({
        topk: maxResults,
        filter,
      });
      results = docs.map(mapZvecDoc);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[news] zvec query failed: ${reason}`);
    return { status: "unavailable", articles: [], reason };
  }

  // Post-filter by symbols (Issue 1): symbols are stored as JSON arrays in zvec,
  // so we filter in JavaScript after fetching
  if (opts.symbols) {
    const wanted = opts.symbols.split(",").map((s) => s.trim().toUpperCase());
    results = results.filter((r) => {
      const articleSymbols: string[] = Array.isArray(r.symbols) ? r.symbols : JSON.parse(r.symbols || "[]");
      return wanted.some((w) => articleSymbols.includes(w));
    });
  }

  if (results.length === 0) return { status: "empty", articles: [] };
  return { status: "ok", articles: results };
}

/** Cache health summary for diagnostics (CLI, status, agent messaging) */
export interface NewsCacheStats {
  status: "ok" | "unavailable";
  reason?: string;
  total: number;
  newest_published_at?: string;
  oldest_published_at?: string;
}

/**
 * Direct (zvec-touching) implementation of the cache health probe.
 * External callers should use `getNewsStats` (the router).
 */
export async function getNewsStatsDirect(): Promise<NewsCacheStats> {
  let collection: ZVecCollection;
  try {
    collection = await getCollection();
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err), total: 0 };
  }
  try {
    // Accurate count from the collection's stats; avoids the truncation bug
    // of counting only `topk` query results when the index exceeds that cap.
    const total = collection.stats.docCount;
    if (total === 0) return { status: "ok", total: 0 };

    // ISO-8601 strings sort lexicographically, so we can estimate newest/oldest
    // from a bounded recent-sample without scanning the whole index. This is
    // best-effort freshness info for diagnostics (sidebar, status); it is not
    // a sort-by-date (zvec returns arbitrary order here).
    const sampleSize = Math.min(total, 1000);
    const docs = collection.querySync({ topk: sampleSize });
    const times = docs
      .map((d) => (d.fields?.published_at as string) ?? "")
      .filter((s) => s.length > 0)
      .sort();
    return {
      status: "ok",
      total,
      newest_published_at: times[times.length - 1],
      oldest_published_at: times[0],
    };
  } catch (err) {
    return { status: "unavailable", reason: err instanceof Error ? err.message : String(err), total: 0 };
  }
}

// ── Routing wrappers ──────────────────────────────────────────

// Lazy imports to avoid pulling net/fs at module load when not needed.
// Also keeps the module graph acyclic: news-ipc-client.ts can `import type`
// from this file without triggering a load-time dependency on node:net.

/**
 * Public read API for news articles.
 *
 * Routes transparently:
 * - In the daemon process (`FUNDX_IS_DAEMON === "1"`) → direct zvec call.
 * - If the daemon's IPC socket exists → query via the socket.
 * - Otherwise → direct (daemon not running, CLI owns the lock).
 *
 * Callers get the same tagged-union response regardless of route.
 */
/** ENOENT means the daemon stopped between our existsSync check and the connect —
 * fall back to direct zvec rather than reporting a confusing IPC error. */
function isSocketGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /ENOENT|ECONNREFUSED/.test(msg);
}

export async function queryArticles(opts: QueryArticlesOpts): Promise<NewsQueryResult> {
  if (process.env.FUNDX_IS_DAEMON === "1") return queryArticlesDirect(opts);
  const { isNewsIpcAvailable, queryArticlesViaIpc } = await import("./news-ipc-client.js");
  if (!isNewsIpcAvailable()) return queryArticlesDirect(opts);
  try {
    return await queryArticlesViaIpc(opts);
  } catch (err) {
    if (isSocketGoneError(err)) return queryArticlesDirect(opts);
    return {
      status: "unavailable",
      articles: [],
      reason: `IPC call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Public cache health probe. Routes the same way as `queryArticles`. */
export async function getNewsStats(): Promise<NewsCacheStats> {
  if (process.env.FUNDX_IS_DAEMON === "1") return getNewsStatsDirect();
  const { isNewsIpcAvailable, getNewsStatsViaIpc } = await import("./news-ipc-client.js");
  if (!isNewsIpcAvailable()) return getNewsStatsDirect();
  try {
    return await getNewsStatsViaIpc();
  } catch (err) {
    if (isSocketGoneError(err)) return getNewsStatsDirect();
    return {
      status: "unavailable",
      total: 0,
      reason: `IPC call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Module-level cooldown map so it persists across invocations within the same daemon process
const alertCooldowns = new Map<string, number>(); // fundName -> last alert timestamp

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

  for (const article of newArticles) {
    if (article.alerted) continue;
    if (!isHighImpact(article.title + " " + article.snippet)) continue;

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
      // Check quiet hours for each affected fund
      const notifyFunds: string[] = [];
      for (const fundName of affectedFunds) {
        try {
          const config = await loadFundConfig(fundName);
          const qh = config.notifications?.quiet_hours;
          if (qh?.enabled && qh.start && qh.end) {
            const now = new Date();
            const hour = now.getHours();
            const min = now.getMinutes();
            const current = `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
            const isQuiet = qh.start <= qh.end
              ? (current >= qh.start && current <= qh.end)   // same-day: e.g. 12:00-14:00
              : (current >= qh.start || current <= qh.end);  // overnight: e.g. 23:00-07:00
            if (isQuiet) continue;
          }
          notifyFunds.push(fundName);
        } catch {
          notifyFunds.push(fundName); // on error, notify anyway
        }
      }

      if (notifyFunds.length > 0) {
        const msg =
          `<b>[NEWS]</b> ${article.source}\n` +
          `${article.symbols.length > 0 ? article.symbols.join(", ") + " mentioned\n\n" : "\n"}` +
          `${article.title}\n\n` +
          `Funds: ${notifyFunds.join(", ")}`;
        try {
          const { sendTelegramNotification } = await import("./gateway.service.js");
          await sendTelegramNotification(msg);
        } catch { /* best effort */ }

        // Mark article as alerted in zvec (write — requires the daemon to hold the lock)
        try {
          const collection = await getCollection();
          collection.updateSync({
            id: article.id,
            fields: { alerted: true },
          });
        } catch { /* best effort */ }

        // Enqueue news reaction session for each affected fund
        for (const fundName of notifyFunds) {
          try {
            const counts = await readSessionCounts(fundName);
            const today = new Date().toISOString().split("T")[0];

            // Reset counts if date changed
            if (counts.date !== today) {
              counts.date = today;
              counts.news = 0;
              counts.agent = 0;
              counts.last_news_at = undefined;
              counts.last_agent_at = undefined;
            }

            // Check limits: max 5/day, max 1/hour
            if (counts.news >= 5) continue;
            if (counts.last_news_at) {
              const elapsed = Date.now() - new Date(counts.last_news_at).getTime();
              if (elapsed < 60 * 60 * 1000) continue;
            }

            // Enqueue pending session
            const pending = await readPendingSessions(fundName);
            const symbols = article.symbols.length > 0 ? article.symbols.join(", ") : "general market";
            pending.push({
              id: randomUUID(),
              type: "news_reaction",
              focus: `NEWS REACTION SESSION: ${article.source} reported "${article.title}".\nSymbols mentioned: ${symbols}.\nAnalyze the impact on your portfolio. If immediate action is needed (stop-loss adjustment, position reduction, hedge), execute it. If no action needed, document your reasoning in memory.\nThis is a short session (5 min, 10 turns) — be decisive.`,
              scheduled_at: new Date(Date.now() + 60_000).toISOString(),
              created_at: new Date().toISOString(),
              source: "news",
              max_turns: 10,
              max_duration_minutes: 5,
              priority: "high",
            });
            await writePendingSessions(fundName, pending);
          } catch { /* best effort — alert was already sent */ }
        }
      }
    }
  }
}

/** Remove articles older than retention period */
export async function cleanOldArticles(): Promise<void> {
  const config = await loadGlobalConfig();
  const newsConfig = newsConfigSchema.parse(config.news ?? {});
  const retentionDays = newsConfig.retention_days;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const collection = await getCollection();
  // Delete articles older than cutoff using zvec's filter-based delete
  collection.deleteByFilterSync(`published_at < "${cutoff}"`);
}
