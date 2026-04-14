import type { DailyBar, ScoreMetadata } from "../types.js";

const LOOKBACK_TOTAL_DAYS = 273;
const SKIP_RECENT_DAYS = 21;
const BASE_DAYS = 252;
const ADV_WINDOW_DAYS = 30;

export interface MomentumScore {
  score: number;
  return_12_1: number;
  adv_usd_30d: number;
  last_price: number;
  missing_days: number;
}

export function scoreMomentum121(bars: DailyBar[]): MomentumScore | null {
  if (bars.length < LOOKBACK_TOTAL_DAYS) return null;
  const n = bars.length;
  const tMinus21 = bars[n - 1 - SKIP_RECENT_DAYS];
  const tMinus252 = bars[n - 1 - SKIP_RECENT_DAYS - (BASE_DAYS - SKIP_RECENT_DAYS)];
  if (!tMinus21 || !tMinus252 || tMinus252.close === 0) return null;
  const return_12_1 = tMinus21.close / tMinus252.close - 1;

  const last30 = bars.slice(-ADV_WINDOW_DAYS);
  const adv_usd_30d =
    last30.reduce((s, b) => s + b.close * b.volume, 0) / ADV_WINDOW_DAYS;

  return {
    score: return_12_1,
    return_12_1,
    adv_usd_30d,
    last_price: bars[n - 1].close,
    missing_days: Math.max(0, LOOKBACK_TOTAL_DAYS - bars.length),
  };
}

export function metadataFromScore(ms: MomentumScore): ScoreMetadata {
  return {
    return_12_1: ms.return_12_1,
    adv_usd_30d: ms.adv_usd_30d,
    last_price: ms.last_price,
    missing_days: ms.missing_days,
  };
}
