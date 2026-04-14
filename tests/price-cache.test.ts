import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  openPriceCache,
  writeBars,
  readBars,
  isFresh,
} from "../src/services/price-cache.service.js";
import type { DailyBar } from "../src/types.js";

function makeBars(days: number): DailyBar[] {
  const out: DailyBar[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(2026, 0, i + 1).toISOString().slice(0, 10);
    out.push({ date: d, close: 100 + i, volume: 1_000_000 });
  }
  return out;
}

describe("price-cache.service", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openPriceCache(":memory:");
  });

  it("writes and reads bars for a ticker", () => {
    const bars = makeBars(5);
    writeBars(db, "AAPL", bars, Date.now());
    expect(readBars(db, "AAPL")).toEqual(bars);
  });

  it("reports fresh within 24h", () => {
    writeBars(db, "MSFT", makeBars(3), Date.now());
    expect(isFresh(db, "MSFT", Date.now())).toBe(true);
  });

  it("reports stale after 24h+1ms", () => {
    const wrote = Date.now() - (24 * 3600 * 1000 + 1);
    writeBars(db, "GOOG", makeBars(3), wrote);
    expect(isFresh(db, "GOOG", Date.now())).toBe(false);
  });

  it("returns empty array for unknown ticker", () => {
    expect(readBars(db, "UNKNOWN")).toEqual([]);
  });

  it("overwrites on re-write", () => {
    writeBars(db, "AAPL", makeBars(3), Date.now());
    writeBars(db, "AAPL", makeBars(5), Date.now());
    expect(readBars(db, "AAPL")).toHaveLength(5);
  });
});
