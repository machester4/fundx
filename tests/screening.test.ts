import { describe, it, expect } from "vitest";
import { scoreMomentum121 } from "../src/services/screening.service.js";
import type { DailyBar } from "../src/types.js";

function bars(closes: number[]): DailyBar[] {
  return closes.map((c, i) => {
    const d = new Date(2025, 0, i + 1).toISOString().slice(0, 10);
    return { date: d, close: c, volume: 1_000_000 };
  });
}

describe("scoreMomentum121", () => {
  it("returns null when fewer than 273 bars", () => {
    expect(scoreMomentum121(bars(Array(100).fill(100)))).toBeNull();
  });

  it("skips the most recent 21 trading days (1 month) in the numerator", () => {
    const closes = [...Array(252).fill(100), ...Array(21).fill(50)];
    const s = scoreMomentum121(bars(closes));
    expect(s).not.toBeNull();
    expect(s!.return_12_1).toBeCloseTo(0, 6);
  });

  it("computes positive return when t-21 > t-252", () => {
    const closes = [
      ...Array(252)
        .fill(0)
        .map((_, i) => 100 + i * 0.1),
      ...Array(21).fill(200),
    ];
    const s = scoreMomentum121(bars(closes));
    expect(s!.return_12_1).toBeGreaterThan(0);
  });

  it("returns null with insufficient history", () => {
    expect(scoreMomentum121(bars(Array(200).fill(100)))).toBeNull();
  });

  it("computes 30-day ADV in USD from last 30 bars", () => {
    const closes = Array(273).fill(100);
    const barArr = bars(closes).map((b, i) => ({
      ...b,
      volume: i >= 243 ? 500_000 : 1_000_000,
    }));
    const s = scoreMomentum121(barArr);
    expect(s!.adv_usd_30d).toBeCloseTo(50_000_000, -3);
  });
});
