import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { writeJsonAtomic } from "../state.js";
import { fundPaths } from "../paths.js";
import type { Universe, UniverseResolution } from "../types.js";
import { universeResolutionSchema } from "../types.js";
import {
  getCompanyProfile,
  getSp500ConstituentsRaw,
  getNasdaq100ConstituentsRaw,
  getDow30ConstituentsRaw,
  getScreenerResultsRaw,
  type ScreenerResult,
} from "./market.service.js";
import { SP500_FALLBACK } from "../constants/sp500.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Stable hash of a universe config. Arrays are sorted before hashing. */
export function hashUniverseConfig(u: Universe): string {
  const normalized = {
    preset: u.preset ?? null,
    filters: u.filters ?? null,
    include_tickers: [...u.include_tickers].sort(),
    exclude_tickers: [...u.exclude_tickers].sort(),
    exclude_sectors: [...u.exclude_sectors].sort(),
  };
  return createHash("sha1").update(JSON.stringify(normalized)).digest("hex");
}

export interface InUniverseStatus {
  in_universe: boolean;
  base_match: boolean;
  include_override: boolean;
  exclude_hard_block: boolean;
  exclude_reason?: "ticker" | "sector";
}

/** Check whether a ticker is in a resolved universe, and why. Does not call FMP. */
export function isInUniverse(
  resolution: UniverseResolution,
  ticker: string,
): InUniverseStatus {
  const t = ticker.toUpperCase();
  if (resolution.exclude_tickers_config.includes(t)) {
    return {
      in_universe: false,
      base_match: false,
      include_override: false,
      exclude_hard_block: true,
      exclude_reason: "ticker",
    };
  }
  if (resolution.include_applied.includes(t)) {
    return {
      in_universe: true,
      base_match: resolution.base_tickers.includes(t),
      include_override: true,
      exclude_hard_block: false,
    };
  }
  const base = resolution.base_tickers.includes(t);
  return {
    in_universe: base,
    base_match: base,
    include_override: false,
    exclude_hard_block: false,
  };
}

/** Read the cached resolution file. Returns null when missing or malformed. */
export async function readCachedUniverse(fundName: string): Promise<UniverseResolution | null> {
  const p = fundPaths(fundName).state.universe;
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, "utf8");
    return universeResolutionSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Fetch preset constituents from FMP via shared raw fetchers. Throws on error. */
async function fetchPreset(preset: string, apiKey: string): Promise<string[]> {
  if (preset === "sp500") return getSp500ConstituentsRaw(apiKey);
  if (preset === "nasdaq100") return getNasdaq100ConstituentsRaw(apiKey);
  if (preset === "dow30") return getDow30ConstituentsRaw(apiKey);
  throw new Error(`Unknown preset: ${preset}`);
}

/** Normalize exclude_sectors against screener results (sector is available). */
function applyScreenerExcludeSectors(
  screener: ScreenerResult[],
  excludeSectors: string[],
): { kept: ScreenerResult[]; excludedSymbols: string[] } {
  if (excludeSectors.length === 0) {
    return { kept: screener, excludedSymbols: [] };
  }
  const kept: ScreenerResult[] = [];
  const excludedSymbols: string[] = [];
  for (const r of screener) {
    if (r.sector && excludeSectors.includes(r.sector)) {
      excludedSymbols.push(r.symbol);
    } else {
      kept.push(r);
    }
  }
  return { kept, excludedSymbols };
}

/** Apply include/exclude to a base ticker list (no sector data at this layer). */
function applyIncludeExclude(
  base: string[],
  universe: Universe,
): { final: string[]; include_applied: string[]; exclude_tickers_applied: string[] } {
  const excluded: string[] = [];
  const filtered = base.filter((t) => {
    if (universe.exclude_tickers.includes(t)) {
      excluded.push(t);
      return false;
    }
    return true;
  });
  const final = [...filtered];
  const includeApplied: string[] = [];
  for (const t of universe.include_tickers) {
    if (!final.includes(t)) {
      final.push(t);
      includeApplied.push(t);
    }
  }
  return { final, include_applied: includeApplied, exclude_tickers_applied: excluded };
}

export interface ResolveOpts {
  force?: boolean;
  now?: number;
  ttlMs?: number;
  persist?: boolean; // default true; when false, resolves without writing cache file
}

export async function resolveUniverse(
  fundName: string,
  universe: Universe,
  apiKey: string,
  opts: ResolveOpts = {},
): Promise<UniverseResolution> {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const hash = hashUniverseConfig(universe);

  // Cache hit?
  if (!opts.force) {
    const cached = await readCachedUniverse(fundName);
    if (cached && cached.config_hash === hash && now - cached.resolved_at < ttl) {
      return cached;
    }
  }

  // Try FMP
  try {
    if (universe.preset) {
      const base = await fetchPreset(universe.preset, apiKey);
      const { final, include_applied, exclude_tickers_applied } = applyIncludeExclude(base, universe);
      const resolution: UniverseResolution = {
        resolved_at: now,
        config_hash: hash,
        resolved_from: "fmp",
        source: { kind: "preset", preset: universe.preset },
        base_tickers: base,
        final_tickers: final,
        include_applied,
        exclude_tickers_applied,
        exclude_sectors_applied: [],
        exclude_tickers_config: [...universe.exclude_tickers],
        exclude_sectors_config: [...universe.exclude_sectors],
        count: final.length,
      };
      if (opts.persist !== false) {
        await writeJsonAtomic(fundPaths(fundName).state.universe, resolution);
      }
      return resolution;
    }

    // Filter mode
    if (universe.filters) {
      const screener = await getScreenerResultsRaw(universe.filters, apiKey);
      const { kept, excludedSymbols } = applyScreenerExcludeSectors(screener, universe.exclude_sectors);
      const keptSymbols = kept.map((r) => r.symbol);
      const { final, include_applied, exclude_tickers_applied } = applyIncludeExclude(keptSymbols, universe);
      const resolution: UniverseResolution = {
        resolved_at: now,
        config_hash: hash,
        resolved_from: "fmp",
        source: { kind: "filters" },
        base_tickers: keptSymbols,
        final_tickers: final,
        include_applied,
        exclude_tickers_applied,
        exclude_sectors_applied: excludedSymbols,
        exclude_tickers_config: [...universe.exclude_tickers],
        exclude_sectors_config: [...universe.exclude_sectors],
        count: final.length,
      };
      if (opts.persist !== false) {
        await writeJsonAtomic(fundPaths(fundName).state.universe, resolution);
      }
      return resolution;
    }
  } catch (err) {
    console.warn(
      `[universe] FMP resolution failed for ${fundName}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback 1: stale cache (ignore TTL, but only when config hasn't changed)
  const stale = await readCachedUniverse(fundName);
  if (stale && stale.config_hash === hash) {
    return { ...stale, resolved_from: "stale_cache" };
  }

  // Fallback 2: SP500_FALLBACK static list
  const base = [...SP500_FALLBACK];
  const { final, include_applied, exclude_tickers_applied } = applyIncludeExclude(base, universe);
  return {
    resolved_at: now,
    config_hash: hash,
    resolved_from: "static_fallback",
    source: universe.preset ? { kind: "preset", preset: universe.preset } : { kind: "filters" },
    base_tickers: base,
    final_tickers: final,
    include_applied,
    exclude_tickers_applied,
    exclude_sectors_applied: [],
    exclude_tickers_config: [...universe.exclude_tickers],
    exclude_sectors_config: [...universe.exclude_sectors],
    count: final.length,
  };
}

/** Delete the cached universe resolution file. Safe to call when no cache exists. */
export async function invalidateUniverseCache(fundName: string): Promise<void> {
  const p = fundPaths(fundName).state.universe;
  try {
    await unlink(p);
  } catch (err) {
    // Missing file is OK; anything else is unexpected but non-fatal
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[universe] failed to invalidate cache for ${fundName}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * For preset mode, check a ticker's sector against exclude_sectors via profile lookup.
 * Sectors are not available at resolution time for presets, so this is called at trade-time.
 */
export async function checkSectorExclusion(
  resolution: UniverseResolution,
  ticker: string,
  apiKey: string,
): Promise<{ excluded: boolean; sector?: string }> {
  if (resolution.exclude_sectors_config.length === 0) return { excluded: false };
  if (resolution.source.kind === "filters") {
    // Filters mode already applied sector exclusion at resolution time.
    return { excluded: false };
  }
  const profile = await getCompanyProfile(ticker, apiKey);
  if (!profile?.sector) return { excluded: false };
  return {
    excluded: resolution.exclude_sectors_config.includes(profile.sector),
    sector: profile.sector,
  };
}
