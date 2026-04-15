import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { writeJsonAtomic } from "../state.js";
import { fundPaths } from "../paths.js";
import type { Universe, UniverseResolution, FmpScreenerFilters } from "../types.js";
import { universeResolutionSchema } from "../types.js";
import { getCompanyProfile } from "./market.service.js";
import { SP500_FALLBACK } from "../constants/sp500.js";

const FMP_BASE = "https://financialmodelingprep.com/api/v3";
const FMP_STABLE_BASE = "https://financialmodelingprep.com/stable";
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

/** Fetch preset constituents directly from FMP. Throws on HTTP error or empty response. */
async function fetchPresetFromFmp(preset: string, apiKey: string): Promise<string[]> {
  let url: string;
  if (preset === "sp500") {
    url = `${FMP_BASE}/sp500_constituent?apikey=${apiKey}`;
  } else if (preset === "nasdaq100") {
    url = `${FMP_BASE}/nasdaq_constituent?apikey=${apiKey}`;
  } else if (preset === "dow30") {
    url = `${FMP_BASE}/dowjones_constituent?apikey=${apiKey}`;
  } else {
    throw new Error(`Unknown preset: ${preset}`);
  }
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`FMP ${url} returned HTTP ${resp.status}`);
  const body = (await resp.json()) as Array<{ symbol: string }>;
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error(`FMP preset ${preset} returned empty/invalid body`);
  }
  return body.map((r) => r.symbol);
}

// Translate snake_case filter keys to FMP camelCase query params
const FMP_SCREENER_PARAM_MAP: Record<string, string> = {
  market_cap_min: "marketCapMoreThan",
  market_cap_max: "marketCapLowerThan",
  price_min: "priceMoreThan",
  price_max: "priceLowerThan",
  beta_min: "betaMoreThan",
  beta_max: "betaLowerThan",
  dividend_min: "dividendMoreThan",
  dividend_max: "dividendLowerThan",
  volume_min: "volumeMoreThan",
  volume_max: "volumeLowerThan",
  industry: "industry",
  country: "country",
  is_etf: "isEtf",
  is_fund: "isFund",
  is_actively_trading: "isActivelyTrading",
  include_all_share_classes: "includeAllShareClasses",
  limit: "limit",
};

function buildScreenerQuery(filters: FmpScreenerFilters): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      const fmpKey = k === "sector" ? "sector" : k === "exchange" ? "exchange" : k;
      for (const item of v) params.append(fmpKey, String(item));
      continue;
    }
    const fmpKey = FMP_SCREENER_PARAM_MAP[k];
    if (!fmpKey) continue;
    params.append(fmpKey, String(v));
  }
  return params.toString().replace(/\+/g, "%20");
}

interface ScreenerRow {
  symbol: string;
  sector?: string;
}

/** Fetch screener results directly from FMP. Throws on HTTP error or empty response. */
async function fetchScreenerFromFmp(filters: FmpScreenerFilters, apiKey: string): Promise<ScreenerRow[]> {
  const query = buildScreenerQuery(filters);
  const url = `${FMP_STABLE_BASE}/company-screener?${query}&apikey=${apiKey}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!resp.ok) throw new Error(`FMP /company-screener returned HTTP ${resp.status}`);
  const body = (await resp.json()) as ScreenerRow[];
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error("FMP screener returned empty/invalid body");
  }
  return body;
}

/** Normalize exclude_sectors against screener results (sector is available). */
function applyScreenerExcludeSectors(
  screener: ScreenerRow[],
  excludeSectors: string[],
): { kept: ScreenerRow[]; excludedSymbols: string[] } {
  if (excludeSectors.length === 0) {
    return { kept: screener, excludedSymbols: [] };
  }
  const kept: ScreenerRow[] = [];
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
      const base = await fetchPresetFromFmp(universe.preset, apiKey);
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
      await writeJsonAtomic(fundPaths(fundName).state.universe, resolution);
      return resolution;
    }

    // Filter mode
    if (universe.filters) {
      const screener = await fetchScreenerFromFmp(universe.filters, apiKey);
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
      await writeJsonAtomic(fundPaths(fundName).state.universe, resolution);
      return resolution;
    }
  } catch (err) {
    console.warn(
      `[universe] FMP resolution failed for ${fundName}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Fallback 1: stale cache (ignore TTL)
  const stale = await readCachedUniverse(fundName);
  if (stale) {
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
