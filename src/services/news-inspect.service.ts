import { stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { NEWS_DIR } from "../paths.js";
import {
  queryArticles,
  fetchAllFeeds,
  getNewsStats,
  type NewsQueryResult,
  type NewsCacheStats,
} from "./news.service.js";
import type { NewsArticle } from "../types.js";

export type NewsInspectResult =
  | { status: "ok"; articles: (NewsArticle & { score?: number })[] }
  | { status: "empty" }
  | { status: "unavailable"; reason: string };

function toInspect(r: NewsQueryResult): NewsInspectResult {
  if (r.status === "ok") return { status: "ok", articles: r.articles };
  if (r.status === "empty") return { status: "empty" };
  return { status: "unavailable", reason: r.reason };
}

/** List articles filtered by scalar fields (no semantic query) */
export async function listArticles(opts: {
  hours?: number;
  source?: string;
  category?: string;
  limit?: number;
}): Promise<NewsInspectResult> {
  return toInspect(await queryArticles({ ...opts, hours: opts.hours ?? 24 }));
}

/** Semantic search — same path the agent's `get_rss_news` tool uses */
export async function searchArticles(opts: {
  query: string;
  symbols?: string;
  hours?: number;
  limit?: number;
}): Promise<NewsInspectResult> {
  return toInspect(await queryArticles({ ...opts, hours: opts.hours ?? 24 }));
}

export interface ExtendedNewsStats extends NewsCacheStats {
  dir_size_bytes?: number;
  newest_age_minutes?: number;
}

/** Bytes used by the zvec collection on disk (approximate, non-recursive on subdirs). */
async function dirSizeBytes(dir: string): Promise<number | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile()) {
        const s = await stat(full);
        total += s.size;
      } else if (entry.isDirectory()) {
        const sub = await dirSizeBytes(full);
        if (sub !== undefined) total += sub;
      }
    }
    return total;
  } catch {
    return undefined;
  }
}

export async function getStats(): Promise<ExtendedNewsStats> {
  const base = await getNewsStats();
  const dir_size_bytes = await dirSizeBytes(NEWS_DIR);
  const newest_age_minutes = base.newest_published_at
    ? Math.round((Date.now() - new Date(base.newest_published_at).getTime()) / 60_000)
    : undefined;
  return { ...base, dir_size_bytes, newest_age_minutes };
}

/** Force a fetch of all configured feeds and return the count of newly stored articles. */
export async function fetchNow(): Promise<{ newCount: number; articles: NewsArticle[] }> {
  const articles = await fetchAllFeeds();
  return { newCount: articles.length, articles };
}
