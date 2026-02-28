import { describe, it, expect, vi } from "vitest";
import { checkSpecialSessions, KNOWN_EVENTS } from "../src/services/special-sessions.service.js";
import type { FundConfig } from "../src/types.js";

vi.mock("../src/services/fund.service.js", () => ({
  loadFundConfig: vi.fn(),
  saveFundConfig: vi.fn(),
  listFundNames: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/services/session.service.js", () => ({
  runFundSession: vi.fn(),
}));

function makeConfig(
  specialSessions: Array<{ trigger: string; time: string; focus: string; enabled?: boolean }>,
): FundConfig {
  return {
    fund: { name: "test", display_name: "Test", description: "", created: "2026-01-01", status: "active" },
    capital: { initial: 10000, currency: "USD" },
    objective: { type: "growth" },
    risk: { profile: "moderate", max_drawdown_pct: 15, max_position_pct: 25, max_leverage: 1, stop_loss_pct: 8, max_daily_loss_pct: 5, correlation_limit: 0.8, custom_rules: [] },
    universe: { allowed: [], forbidden: [] },
    schedule: {
      timezone: "UTC",
      trading_days: ["MON", "TUE", "WED", "THU", "FRI"],
      sessions: {},
      special_sessions: specialSessions.map((s) => ({
        trigger: s.trigger,
        time: s.time,
        focus: s.focus,
        enabled: s.enabled ?? true,
        max_duration_minutes: 15,
      })),
    },
    broker: { provider: "alpaca", mode: "paper" },
    notifications: { telegram: { enabled: false, trade_alerts: true, stop_loss_alerts: true, daily_digest: true, weekly_digest: true, milestone_alerts: true, drawdown_alerts: true }, quiet_hours: { enabled: true, start: "23:00", end: "07:00", allow_critical: true } },
    claude: { model: "sonnet", personality: "", decision_framework: "" },
  } as FundConfig;
}

describe("checkSpecialSessions", () => {
  it("returns empty array when no special sessions configured", () => {
    const config = makeConfig([]);
    expect(checkSpecialSessions(config)).toEqual([]);
  });

  it("skips disabled sessions", () => {
    const config = makeConfig([
      { trigger: "every Monday", time: "09:00", focus: "Weekly review", enabled: false },
    ]);
    // Even on a Monday, this should not trigger
    const monday = new Date("2026-02-23T09:00:00Z"); // Feb 23 2026 is Monday
    expect(checkSpecialSessions(config, monday)).toEqual([]);
  });

  it("triggers on matching day-of-week", () => {
    const config = makeConfig([
      { trigger: "every Monday", time: "09:00", focus: "Weekly review" },
    ]);
    const monday = new Date("2026-02-23T09:00:00Z"); // Monday
    const result = checkSpecialSessions(config, monday);
    expect(result).toHaveLength(1);
    expect(result[0].trigger).toBe("every Monday");
  });

  it("does not trigger on wrong day-of-week", () => {
    const config = makeConfig([
      { trigger: "every Monday", time: "09:00", focus: "Weekly review" },
    ]);
    const tuesday = new Date("2026-02-24T09:00:00Z"); // Tuesday
    expect(checkSpecialSessions(config, tuesday)).toEqual([]);
  });

  it("triggers on specific date", () => {
    const config = makeConfig([
      { trigger: "2026-03-15", time: "10:00", focus: "Special date event" },
    ]);
    const date = new Date("2026-03-15T10:00:00Z");
    const result = checkSpecialSessions(config, date);
    expect(result).toHaveLength(1);
  });

  it("does not trigger on different date", () => {
    const config = makeConfig([
      { trigger: "2026-03-15", time: "10:00", focus: "Special date event" },
    ]);
    const date = new Date("2026-03-16T10:00:00Z");
    expect(checkSpecialSessions(config, date)).toEqual([]);
  });

  it("triggers on first day of month", () => {
    const config = makeConfig([
      { trigger: "first day of month", time: "09:00", focus: "Monthly rebalance" },
    ]);
    const firstDay = new Date("2026-03-01T09:00:00Z");
    expect(checkSpecialSessions(config, firstDay)).toHaveLength(1);

    const secondDay = new Date("2026-03-02T09:00:00Z");
    expect(checkSpecialSessions(config, secondDay)).toHaveLength(0);
  });

  it("triggers on last day of month", () => {
    const config = makeConfig([
      { trigger: "last day of month", time: "16:00", focus: "End-of-month review" },
    ]);
    const lastDayFeb = new Date("2026-02-28T16:00:00Z");
    expect(checkSpecialSessions(config, lastDayFeb)).toHaveLength(1);

    const notLast = new Date("2026-02-27T16:00:00Z");
    expect(checkSpecialSessions(config, notLast)).toHaveLength(0);
  });

  it("triggers OpEx on third Friday", () => {
    const config = makeConfig([
      { trigger: "Monthly options expiration (OpEx)", time: "09:00", focus: "OpEx review" },
    ]);
    // Third Friday of March 2026 is March 20
    const thirdFriday = new Date("2026-03-20T09:00:00Z");
    expect(checkSpecialSessions(config, thirdFriday)).toHaveLength(1);

    // Second Friday (not third)
    const secondFriday = new Date("2026-03-13T09:00:00Z");
    expect(checkSpecialSessions(config, secondFriday)).toHaveLength(0);
  });

  it("triggers NFP on first Friday", () => {
    const config = makeConfig([
      { trigger: "Non-Farm Payrolls release", time: "08:15", focus: "NFP day" },
    ]);
    // First Friday of March 2026 is March 6
    const firstFriday = new Date("2026-03-06T08:15:00Z");
    expect(checkSpecialSessions(config, firstFriday)).toHaveLength(1);

    // Second Friday
    const secondFriday = new Date("2026-03-13T08:15:00Z");
    expect(checkSpecialSessions(config, secondFriday)).toHaveLength(0);
  });

  it("handles multiple triggers", () => {
    const config = makeConfig([
      { trigger: "every Friday", time: "09:00", focus: "Weekly" },
      { trigger: "first day of month", time: "09:00", focus: "Monthly" },
    ]);
    // Friday March 6 — only "every Friday" matches
    const friday = new Date("2026-03-06T09:00:00Z");
    expect(checkSpecialSessions(config, friday)).toHaveLength(1);
  });
});

describe("KNOWN_EVENTS", () => {
  it("has at least 5 known events", () => {
    expect(KNOWN_EVENTS.length).toBeGreaterThanOrEqual(5);
  });

  it("each event has required fields", () => {
    for (const event of KNOWN_EVENTS) {
      expect(event.name).toBeTruthy();
      expect(event.trigger).toBeTruthy();
      expect(event.defaultTime).toMatch(/^\d{2}:\d{2}$/);
      expect(event.defaultFocus).toBeTruthy();
      expect(["yearly", "monthly", "quarterly", "ad-hoc"]).toContain(event.recurring);
    }
  });
});
