import { describe, it, expect } from "vitest";
import {
  isInQuietHoursEnv,
  shouldSendNotification,
  formatTradeAlert,
  formatStopLossAlert,
} from "../src/mcp/broker-local-notify.js";

describe("isInQuietHoursEnv", () => {
  it("returns false when env vars not set", () => {
    expect(isInQuietHoursEnv(undefined, undefined)).toBe(false);
  });

  it("returns true when current time is inside midnight-wrapping range", () => {
    // 23:00 - 07:00, test at 01:00 (60 min)
    expect(isInQuietHoursEnv("23:00", "07:00", 60)).toBe(true);
  });

  it("returns false when current time is outside midnight-wrapping range", () => {
    // 23:00 - 07:00, test at 12:00 (720 min)
    expect(isInQuietHoursEnv("23:00", "07:00", 720)).toBe(false);
  });

  it("handles non-wrapping range", () => {
    // 09:00 - 17:00, test at 12:00 (720 min)
    expect(isInQuietHoursEnv("09:00", "17:00", 720)).toBe(true);
    // test at 08:00 (480 min)
    expect(isInQuietHoursEnv("09:00", "17:00", 480)).toBe(false);
  });
});

describe("shouldSendNotification", () => {
  it("returns true when not in quiet hours", () => {
    expect(shouldSendNotification(false, false, false)).toBe(true);
  });

  it("returns false when in quiet hours and not critical", () => {
    expect(shouldSendNotification(true, false, true)).toBe(false);
  });

  it("returns true when in quiet hours, critical, and allow_critical", () => {
    expect(shouldSendNotification(true, true, true)).toBe(true);
  });

  it("returns false when in quiet hours, critical, but no allow_critical", () => {
    expect(shouldSendNotification(true, true, false)).toBe(false);
  });
});

describe("formatTradeAlert", () => {
  it("formats a buy alert", () => {
    const msg = formatTradeAlert("Growth", "URA", "buy", 6, 48.66, "Gold miners oversold");
    expect(msg).toContain("🟢");
    expect(msg).toContain("<b>Growth</b>");
    expect(msg).toContain("BUY");
    expect(msg).toContain("6 URA");
    expect(msg).toContain("48.66");
    expect(msg).toContain("Gold miners oversold");
  });

  it("formats a sell alert without reason", () => {
    const msg = formatTradeAlert("Growth", "URA", "sell", 6, 52.00);
    expect(msg).toContain("🔴");
    expect(msg).toContain("SELL");
    expect(msg).not.toContain("Reason:");
  });

  it("includes total value", () => {
    const msg = formatTradeAlert("MyFund", "AAPL", "buy", 10, 175.5);
    expect(msg).toContain("Total: $1755.00");
  });
});

describe("formatStopLossAlert", () => {
  it("formats a stop-loss alert", () => {
    const msg = formatStopLossAlert("Growth", "URA", 6, 46.00, -15.96, -5.48);
    expect(msg).toContain("⚠️");
    expect(msg).toContain("STOP-LOSS");
    expect(msg).toContain("URA");
    expect(msg).toContain("46.00");
    expect(msg).toContain("-15.96");
    // lossPct uses toFixed(1), so -5.48 rounds to -5.5
    expect(msg).toContain("-5.5");
  });

  it("includes fund name in bold", () => {
    const msg = formatStopLossAlert("RunwayFund", "GLD", 10, 180.0, -50.0, -2.7);
    expect(msg).toContain("<b>RunwayFund</b>");
  });

  it("labels action as stop triggered", () => {
    const msg = formatStopLossAlert("F", "X", 1, 10.0, -1.0, -1.0);
    expect(msg).toContain("stop triggered");
  });
});
