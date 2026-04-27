import { describe, it, expect } from "vitest";
import { buildAutonomousPrompt } from "../src/services/session.service.js";

const baseInput = {
  fundName: "test-fund",
  sessionType: "pre-market",
  focus: "Review overnight news, check positions, identify rebalancing needs.",
  today: "2026-04-27",
};

describe("buildAutonomousPrompt", () => {
  it("starts with the autonomous-scheduled mode prefix", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toMatch(/^Session mode: autonomous scheduled/);
  });

  it("includes the fund name and session type in the running header", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toContain("running a pre-market session for fund 'test-fund'");
  });

  it("includes the focus line", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toContain("Focus: Review overnight news, check positions, identify rebalancing needs.");
  });

  it("references the session-init rule", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toContain("Follow your session-init rule");
  });

  it("specifies the analysis output path with the injected date and sessionType", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).toContain("Write analysis to analysis/2026-04-27_pre-market.md");
  });

  it("includes the universe block when provided", () => {
    const out = buildAutonomousPrompt({
      ...baseInput,
      universeBlock: "## Universe\n- SPY\n- QQQ",
    });
    expect(out).toContain("## Universe");
    expect(out).toContain("- SPY");
  });

  it("omits universe block when undefined or null", () => {
    const withUndefined = buildAutonomousPrompt({ ...baseInput, universeBlock: undefined });
    const withNull = buildAutonomousPrompt({ ...baseInput, universeBlock: null });
    expect(withUndefined).not.toContain("## Universe");
    expect(withNull).not.toContain("## Universe");
  });

  it("includes debate skills paragraph when useDebateSkills=true", () => {
    const out = buildAutonomousPrompt({ ...baseInput, useDebateSkills: true });
    expect(out).toContain("prioritize thorough analysis");
    expect(out).toContain("Investment Debate and Risk Assessment skills");
    expect(out).toContain("analyst sub-agents (via the Task tool)");
  });

  it("omits debate skills paragraph when useDebateSkills=false or undefined", () => {
    const withFalse = buildAutonomousPrompt({ ...baseInput, useDebateSkills: false });
    const withUndefined = buildAutonomousPrompt(baseInput);
    expect(withFalse).not.toContain("prioritize thorough analysis");
    expect(withUndefined).not.toContain("prioritize thorough analysis");
  });

  it("uses today's date by default when `today` is not provided", () => {
    const out = buildAutonomousPrompt({ ...baseInput, today: undefined });
    const expectedDate = new Date().toISOString().split("T")[0];
    expect(out).toContain(`analysis/${expectedDate}_pre-market.md`);
  });
});
