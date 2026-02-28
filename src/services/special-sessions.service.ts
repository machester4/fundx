import { loadFundConfig, saveFundConfig } from "./fund.service.js";
import { runFundSession } from "./session.service.js";
import type { FundConfig } from "../types.js";

// ── Known Event Calendar ─────────────────────────────────────

interface MarketEvent {
  name: string;
  trigger: string;
  defaultTime: string;
  defaultFocus: string;
  recurring: "yearly" | "monthly" | "quarterly" | "ad-hoc";
}

/** Well-known market events that can trigger special sessions */
export const KNOWN_EVENTS: MarketEvent[] = [
  {
    name: "FOMC Meeting",
    trigger: "FOMC meeting days",
    defaultTime: "14:00",
    defaultFocus:
      "Pre-FOMC positioning review. Reduce directional risk if needed. Monitor rate decision and dot plot.",
    recurring: "quarterly",
  },
  {
    name: "Monthly OpEx",
    trigger: "Monthly options expiration (OpEx)",
    defaultTime: "09:00",
    defaultFocus:
      "Review options exposure. Assess pin risk on open positions. Roll or close expiring positions.",
    recurring: "monthly",
  },
  {
    name: "Quarterly OpEx (Triple Witching)",
    trigger: "Quarterly options expiration (Triple Witching)",
    defaultTime: "09:00",
    defaultFocus:
      "Triple witching day. High volatility expected. Review all positions, reduce leverage, tighten stops.",
    recurring: "quarterly",
  },
  {
    name: "CPI Release",
    trigger: "CPI data release",
    defaultTime: "08:15",
    defaultFocus:
      "CPI release imminent. Review inflation-sensitive positions. Prepare for potential volatility.",
    recurring: "monthly",
  },
  {
    name: "NFP (Non-Farm Payrolls)",
    trigger: "Non-Farm Payrolls release",
    defaultTime: "08:15",
    defaultFocus:
      "Jobs report release. Review labor-market-sensitive positions. Check impact on rate expectations.",
    recurring: "monthly",
  },
  {
    name: "Earnings Season",
    trigger: "Earnings season start",
    defaultTime: "09:00",
    defaultFocus:
      "Earnings season beginning. Review positions with upcoming reports. Assess pre-earnings risk.",
    recurring: "quarterly",
  },
];

// ── Special Session Logic ────────────────────────────────────

/**
 * Check if any special sessions should trigger today.
 * Returns matching special sessions for a fund.
 */
export function checkSpecialSessions(
  config: FundConfig,
  dateOverride?: Date,
): Array<{ trigger: string; time: string; focus: string }> {
  const now = dateOverride ?? new Date();
  const specialSessions = config.schedule.special_sessions ?? [];

  if (specialSessions.length === 0) return [];

  const matching: Array<{ trigger: string; time: string; focus: string }> = [];

  for (const session of specialSessions) {
    if (session.enabled === false) continue;

    // Check trigger against known event patterns
    const triggered = evaluateTrigger(session.trigger, now);
    if (triggered) {
      matching.push({
        trigger: session.trigger,
        time: session.time,
        focus: session.focus,
      });
    }
  }

  return matching;
}

/**
 * Evaluate whether a trigger condition matches a given date.
 * Supports both known event patterns and date-based triggers.
 */
function evaluateTrigger(trigger: string, date: Date): boolean {
  const lower = trigger.toLowerCase();

  // Third Friday of the month (monthly OpEx)
  if (lower.includes("opex") || lower.includes("options expiration")) {
    return isThirdFriday(date);
  }

  // FOMC — check if it's a known FOMC date pattern
  if (lower.includes("fomc")) {
    return isFOMCDay(date);
  }

  // CPI — typically released on specific dates
  if (lower.includes("cpi")) {
    return isCPIDay(date);
  }

  // NFP — first Friday of the month
  if (lower.includes("non-farm") || lower.includes("nfp")) {
    return isFirstFriday(date);
  }

  // Earnings season — roughly mid-Jan, mid-Apr, mid-Jul, mid-Oct
  if (lower.includes("earnings season")) {
    return isEarningsSeasonStart(date);
  }

  // Date-based trigger: "YYYY-MM-DD"
  const dateMatch = trigger.match(/\d{4}-\d{2}-\d{2}/);
  if (dateMatch) {
    const triggerDate = dateMatch[0];
    const currentDate = date.toISOString().split("T")[0];
    return triggerDate === currentDate;
  }

  // Day-of-week trigger: "every Monday"
  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  for (let i = 0; i < dayNames.length; i++) {
    if (lower.includes(`every ${dayNames[i]}`)) {
      return date.getDay() === i;
    }
  }

  // Monthly trigger: "first day of month", "last day of month"
  if (lower.includes("first day of month")) {
    return date.getDate() === 1;
  }
  if (lower.includes("last day of month")) {
    const tomorrow = new Date(date);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.getDate() === 1;
  }

  return false;
}

// ── Date utility functions ───────────────────────────────────

function isThirdFriday(date: Date): boolean {
  if (date.getDay() !== 5) return false; // Not Friday
  const dayOfMonth = date.getDate();
  return dayOfMonth >= 15 && dayOfMonth <= 21;
}

function isFirstFriday(date: Date): boolean {
  if (date.getDay() !== 5) return false;
  return date.getDate() <= 7;
}

function isFOMCDay(date: Date): boolean {
  // FOMC meets roughly 8 times per year
  // Simplified check: 2nd and 4th Wednesday of Jan, Mar, May, Jun, Jul, Sep, Nov, Dec
  // In practice, use a fixed calendar — this is a heuristic
  const month = date.getMonth(); // 0-indexed
  const fomcMonths = [0, 2, 4, 5, 6, 8, 10, 11]; // Jan, Mar, May, Jun, Jul, Sep, Nov, Dec
  if (!fomcMonths.includes(month)) return false;
  if (date.getDay() !== 3) return false; // Wednesday
  // Check if it's the 3rd or 4th Wednesday (typical FOMC pattern)
  const dayOfMonth = date.getDate();
  return dayOfMonth >= 15 && dayOfMonth <= 28;
}

function isCPIDay(date: Date): boolean {
  // CPI is typically released on the 10th-14th of each month (Tuesday or Wednesday)
  const day = date.getDay();
  if (day !== 2 && day !== 3) return false; // Tuesday or Wednesday
  const dayOfMonth = date.getDate();
  return dayOfMonth >= 10 && dayOfMonth <= 14;
}

function isEarningsSeasonStart(date: Date): boolean {
  const month = date.getMonth();
  const dayOfMonth = date.getDate();
  // Earnings season starts roughly: Jan 10-15, Apr 10-15, Jul 10-15, Oct 10-15
  const earningsMonths = [0, 3, 6, 9];
  return earningsMonths.includes(month) && dayOfMonth >= 10 && dayOfMonth <= 15;
}

/**
 * Run a special session for a fund.
 * Similar to a regular session but with event-specific focus.
 */
export async function runSpecialSession(
  fundName: string,
  trigger: string,
  focus: string,
): Promise<void> {
  const sessionType = `special_${trigger.replace(/\s+/g, "_").toLowerCase()}`;
  await runFundSession(fundName, sessionType, { focus });
}

/**
 * Add a special session trigger to a fund's config.
 */
export async function addSpecialSession(
  fundName: string,
  trigger: string,
  time: string,
  focus: string,
): Promise<void> {
  const config = await loadFundConfig(fundName);

  const specialSessions = config.schedule.special_sessions ?? [];
  specialSessions.push({
    trigger,
    time,
    focus,
    enabled: true,
    max_duration_minutes: 15,
  });

  config.schedule.special_sessions = specialSessions;
  await saveFundConfig(config);
}

/**
 * Remove a special session trigger from a fund's config.
 */
export async function removeSpecialSession(
  fundName: string,
  index: number,
): Promise<void> {
  const config = await loadFundConfig(fundName);
  const specialSessions = config.schedule.special_sessions ?? [];

  if (index < 0 || index >= specialSessions.length) {
    throw new Error(`Invalid session index: ${index}`);
  }

  specialSessions.splice(index, 1);
  config.schedule.special_sessions = specialSessions;
  await saveFundConfig(config);
}
