import { describe, it, expect } from "vitest";
import { evaluateWatchdog } from "../src/services/session.service.js";

describe("evaluateWatchdog (pure)", () => {
  it("does not fire when query completes in time", () => {
    const r = evaluateWatchdog({ now: 1000, startedAtMs: 0, hardCeilingMs: 2000, queryActive: false });
    expect(r.shouldKill).toBe(false);
  });

  it("does not fire when query active but within ceiling", () => {
    const r = evaluateWatchdog({ now: 1500, startedAtMs: 0, hardCeilingMs: 2000, queryActive: true });
    expect(r.shouldKill).toBe(false);
  });

  it("fires when query active and over ceiling", () => {
    const r = evaluateWatchdog({ now: 2500, startedAtMs: 0, hardCeilingMs: 2000, queryActive: true });
    expect(r.shouldKill).toBe(true);
    expect(r.elapsedMs).toBe(2500);
  });
});
