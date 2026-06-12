import { describe, it, expect } from "vitest";
import { QUOTA_EXHAUSTED_PATTERN } from "../src/agent.js";
import { isQuotaBackoffActive, QUOTA_BACKOFF_MS } from "../src/services/session.service.js";

describe("quota exhaustion detection", () => {
  it("matches the observed subscription error strings", () => {
    expect(
      QUOTA_EXHAUSTED_PATTERN.test("You're out of extra usage · resets 6pm (America/Montevideo)"),
    ).toBe(true);
    expect(QUOTA_EXHAUSTED_PATTERN.test("You've reached your usage limit")).toBe(true);
    expect(QUOTA_EXHAUSTED_PATTERN.test("You're out of usage · resets 11am")).toBe(true);
    expect(QUOTA_EXHAUSTED_PATTERN.test("ordinary session output about usage of tools")).toBe(false);
    expect(QUOTA_EXHAUSTED_PATTERN.test("Session complete. No trades.")).toBe(false);
  });

  it("isQuotaBackoffActive is true within the window and false after", () => {
    const t0 = 1_750_000_000_000;
    expect(isQuotaBackoffActive(t0, t0 + QUOTA_BACKOFF_MS - 1)).toBe(true);
    expect(isQuotaBackoffActive(t0, t0 + QUOTA_BACKOFF_MS + 1)).toBe(false);
    expect(isQuotaBackoffActive(null, t0)).toBe(false);
  });
});
