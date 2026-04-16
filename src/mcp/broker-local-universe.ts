/**
 * Pure, testable universe tool handlers for the broker-local MCP server.
 *
 * This module has no MCP dependencies — it can be imported in both
 * the MCP server process and unit tests without any SDK scaffolding.
 */

import { isInUniverse } from "../services/universe.service.js";
import { universeSchema, fundConfigSchema } from "../types.js";
import type { Universe, UniversePreset, UniverseResolution, FundConfig, FmpScreenerFilters } from "../types.js";

// ── Check Universe ────────────────────────────────────────────────────────────

export interface CheckUniverseInput { ticker: string }
export interface CheckUniverseDeps {
  resolve: () => Promise<UniverseResolution>;
  checkSector: (ticker: string, resolution: UniverseResolution) => Promise<{ excluded: boolean; sector?: string }>;
}
export interface CheckUniverseOutput {
  in_universe: boolean;
  base_match: boolean;
  include_override: boolean;
  exclude_hard_block: boolean;
  exclude_reason?: "ticker" | "sector";
  requires_justification: boolean;
  resolved_at: number;
  resolved_from: string;
}

export async function handleCheckUniverse(
  input: CheckUniverseInput,
  deps: CheckUniverseDeps,
): Promise<CheckUniverseOutput> {
  const resolution = await deps.resolve();
  const status = isInUniverse(resolution, input.ticker);
  // Hard block: excluded by ticker config
  if (status.exclude_hard_block) {
    return {
      in_universe: false,
      base_match: status.base_match,
      include_override: false,
      exclude_hard_block: true,
      exclude_reason: status.exclude_reason,
      requires_justification: false,
      resolved_at: resolution.resolved_at,
      resolved_from: resolution.resolved_from,
    };
  }
  // Explicit include_tickers takes precedence over exclude_sectors
  if (status.include_override) {
    return {
      in_universe: true,
      base_match: status.base_match,
      include_override: true,
      exclude_hard_block: false,
      requires_justification: false,
      resolved_at: resolution.resolved_at,
      resolved_from: resolution.resolved_from,
    };
  }
  // Preset mode: check sector exclusion via profile
  const sectorCheck = await deps.checkSector(input.ticker, resolution);
  if (sectorCheck.excluded) {
    return {
      in_universe: false,
      base_match: status.base_match,
      include_override: false,
      exclude_hard_block: true,
      exclude_reason: "sector",
      requires_justification: false,
      resolved_at: resolution.resolved_at,
      resolved_from: resolution.resolved_from,
    };
  }
  return {
    in_universe: status.in_universe,
    base_match: status.base_match,
    include_override: false,
    exclude_hard_block: false,
    requires_justification: !status.in_universe,
    resolved_at: resolution.resolved_at,
    resolved_from: resolution.resolved_from,
  };
}

// ── List Universe ─────────────────────────────────────────────────────────────

export interface ListUniverseInput { sector?: string; limit?: number; verbose?: boolean }
export interface ListUniverseDeps {
  resolve: () => Promise<UniverseResolution>;
  getProfile: (ticker: string) => Promise<{ sector?: string } | null>;
}
export interface ListUniverseOutput {
  tickers: string[];
  total: number;
  resolved_at: number;
  resolved_from: string;
  source?: { kind: "preset"; preset: string } | { kind: "filters" };
  include_tickers?: string[];
  exclude_tickers?: string[];
  exclude_sectors?: string[];
}

export async function handleListUniverse(
  input: ListUniverseInput,
  deps: ListUniverseDeps,
): Promise<ListUniverseOutput> {
  const resolution = await deps.resolve();
  let tickers = resolution.final_tickers;
  if (input.sector) {
    const matching: string[] = [];
    const BATCH_SIZE = 10;
    for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
      const batch = tickers.slice(i, i + BATCH_SIZE);
      const profiles = await Promise.all(
        batch.map((t) => deps.getProfile(t).then((p) => ({ t, p }))),
      );
      for (const { t, p } of profiles) {
        if (p?.sector === input.sector) matching.push(t);
      }
    }
    tickers = matching;
  }
  const total = tickers.length;
  const effectiveLimit = input.limit ?? (input.sector ? 50 : undefined);
  if (effectiveLimit && effectiveLimit > 0) tickers = tickers.slice(0, effectiveLimit);
  const base: ListUniverseOutput = {
    tickers,
    total,
    resolved_at: resolution.resolved_at,
    resolved_from: resolution.resolved_from,
  };
  if (input.verbose) {
    base.source = resolution.source;
    base.include_tickers = [...resolution.include_applied];
    base.exclude_tickers = [...resolution.exclude_tickers_config];
    base.exclude_sectors = [...resolution.exclude_sectors_config];
  }
  return base;
}

// ── Buy Gate ──────────────────────────────────────────────────────────────────

export interface BuyGateInput {
  symbol: string;
  out_of_universe_reason?: string;
}
export interface BuyGateDeps {
  resolve: () => Promise<UniverseResolution>;
  checkSector: (ticker: string, resolution: UniverseResolution) => Promise<{ excluded: boolean; sector?: string }>;
}
export type BuyGateResult =
  | { ok: true; out_of_universe: boolean; out_of_universe_reason: string | null }
  | { ok: false; code: "UNIVERSE_EXCLUDED" | "UNIVERSE_SOFT_GATE" | "UNIVERSE_REASON_TOO_SHORT"; message: string; exclude_reason?: "ticker" | "sector" };

export const MIN_OOU_REASON_LENGTH = 20;

export async function handleBuyGate(
  input: BuyGateInput,
  deps: BuyGateDeps,
): Promise<BuyGateResult> {
  const t = input.symbol.toUpperCase();
  const resolution = await deps.resolve();
  const status = isInUniverse(resolution, t);

  // Hard block by ticker config (exclude_tickers takes precedence)
  if (status.exclude_hard_block) {
    return {
      ok: false,
      code: "UNIVERSE_EXCLUDED",
      message: `${t} is in this fund's exclude_tickers list.`,
      exclude_reason: "ticker",
    };
  }

  // Explicit include_tickers bypasses sector check (matches check_universe precedence)
  if (status.include_override) {
    return { ok: true, out_of_universe: false, out_of_universe_reason: null };
  }

  // Preset mode: check sector exclusion via profile
  const sectorCheck = await deps.checkSector(t, resolution);
  if (sectorCheck.excluded) {
    return {
      ok: false,
      code: "UNIVERSE_EXCLUDED",
      message: `${t} is in sector '${sectorCheck.sector}' which is excluded by this fund.`,
      exclude_reason: "sector",
    };
  }

  if (status.in_universe) {
    return { ok: true, out_of_universe: false, out_of_universe_reason: null };
  }

  // Out-of-universe: require justification
  const raw = input.out_of_universe_reason ?? "";
  if (!raw) {
    return {
      ok: false,
      code: "UNIVERSE_SOFT_GATE",
      message: `${t} is outside this fund's universe. Pass out_of_universe_reason (>=${MIN_OOU_REASON_LENGTH} chars) describing a time-sensitive thesis to proceed.`,
    };
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_OOU_REASON_LENGTH) {
    return {
      ok: false,
      code: "UNIVERSE_REASON_TOO_SHORT",
      message: `out_of_universe_reason must be at least ${MIN_OOU_REASON_LENGTH} characters (got ${trimmed.length}).`,
    };
  }
  return { ok: true, out_of_universe: true, out_of_universe_reason: trimmed };
}

// ── Update Universe ───────────────────────────────────────────────────────────

export interface UpdateUniverseInput {
  mode?: { preset?: UniversePreset; filters?: FmpScreenerFilters };
  include_tickers?: string[];
  exclude_tickers?: string[];
  exclude_sectors?: string[];
  dry_run?: boolean;
}
export interface UpdateUniverseDeps {
  loadCurrentConfig: () => Promise<FundConfig>;
  writeConfigYaml: (config: FundConfig) => Promise<void>;
  invalidateUniverseCache: () => Promise<void>;
  regenerateClaudeMd: (config: FundConfig) => Promise<void>;
  resolveNewUniverse: (config: FundConfig, opts: { dryRun: boolean }) => Promise<UniverseResolution>;
  auditLog: (entry: { before: unknown; after: unknown; timestamp: string }) => Promise<void>;
}
export interface UpdateUniverseOutput {
  ok: true;
  dry_run: boolean;
  before: { source: string; include_count: number; exclude_tickers_count: number; exclude_sectors_count: number };
  after: { source: string; include_count: number; exclude_tickers_count: number; exclude_sectors_count: number };
  resolved: { count: number; resolved_from: "fmp" | "stale_cache" | "static_fallback" };
  warnings: string[];
  note: string;
}

function summarizeUniverse(u: Universe): { source: string; include_count: number; exclude_tickers_count: number; exclude_sectors_count: number } {
  const source = u.preset ? `preset:${u.preset}` : "filters";
  return {
    source,
    include_count: u.include_tickers.length,
    exclude_tickers_count: u.exclude_tickers.length,
    exclude_sectors_count: u.exclude_sectors.length,
  };
}

function computeWarnings(resolution: UniverseResolution): string[] {
  const warnings: string[] = [];
  if (resolution.count === 0) {
    warnings.push(
      "Resolved universe is empty (0 tickers). The fund cannot trade anything until the universe is broadened.",
    );
  }
  if (resolution.resolved_from === "static_fallback") {
    warnings.push(
      "FMP resolution fell through to static fallback. Likely your FMP API key cannot hit the requested " +
      "preset/filter endpoint.",
    );
  }
  return warnings;
}

export async function handleUpdateUniverse(
  input: UpdateUniverseInput,
  deps: UpdateUniverseDeps,
): Promise<UpdateUniverseOutput> {
  // Validate XOR constraint at input level first (before schema re-parse)
  if (input.mode?.preset && input.mode?.filters) {
    throw new Error("mode.preset and mode.filters are mutually exclusive — pass exactly one.");
  }

  // Reject empty mode object
  if (input.mode && !input.mode.preset && !input.mode.filters) {
    throw new Error("mode must include either preset or filters (got empty object).");
  }

  const current = await deps.loadCurrentConfig();
  const before = summarizeUniverse(current.universe);

  // Build patched universe
  let next: Universe = { ...current.universe };
  if (input.mode?.preset) {
    next = {
      preset: input.mode.preset,
      // Drop filters when switching to preset
      include_tickers: next.include_tickers,
      exclude_tickers: next.exclude_tickers,
      exclude_sectors: next.exclude_sectors,
    };
  } else if (input.mode?.filters) {
    next = {
      filters: input.mode.filters,
      // Drop preset when switching to filters
      include_tickers: next.include_tickers,
      exclude_tickers: next.exclude_tickers,
      exclude_sectors: next.exclude_sectors,
    };
  }
  if (input.include_tickers !== undefined) next.include_tickers = input.include_tickers;
  if (input.exclude_tickers !== undefined) next.exclude_tickers = input.exclude_tickers;
  if (input.exclude_sectors !== undefined) next.exclude_sectors = input.exclude_sectors as Universe["exclude_sectors"];

  // Schema validation — throws a Zod error with a clear message if bad
  const validated = universeSchema.parse(next);

  // Wrap in the full fundConfigSchema for belt-and-suspenders
  const newConfig = fundConfigSchema.parse({ ...current, universe: validated });

  const isDryRun = input.dry_run === true;

  if (isDryRun) {
    // Dry run: resolve without persisting anywhere (cache will be untouched)
    const resolution = await deps.resolveNewUniverse(newConfig, { dryRun: true });
    const warnings = computeWarnings(resolution);
    const after = summarizeUniverse(newConfig.universe);
    const note = "DRY RUN: no changes to fund_config.yaml, CLAUDE.md, or the resolver cache. Re-run without dry_run to commit.";
    return {
      ok: true,
      dry_run: true,
      before,
      after,
      resolved: { count: resolution.count, resolved_from: resolution.resolved_from },
      warnings,
      note,
    };
  }

  // Commit path: persist intent first, then resolve against new config
  await deps.writeConfigYaml(newConfig);
  await deps.invalidateUniverseCache();
  const resolution = await deps.resolveNewUniverse(newConfig, { dryRun: false });
  await deps.regenerateClaudeMd(newConfig);
  await deps.auditLog({
    before,
    after: summarizeUniverse(newConfig.universe),
    timestamp: new Date().toISOString(),
  });
  const warnings = computeWarnings(resolution);
  const after = summarizeUniverse(newConfig.universe);
  const note = "Universe updated. Next tool call resolves against the new config (cache invalidated). CLAUDE.md regenerated. If this fund has user-authored YAML comments or custom key ordering in fund_config.yaml, they are lost on write.";

  return {
    ok: true,
    dry_run: false,
    before,
    after,
    resolved: { count: resolution.count, resolved_from: resolution.resolved_from },
    warnings,
    note,
  };
}
