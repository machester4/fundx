import { describe, it, expect } from "vitest";
import { sessionModePrefix } from "../src/services/chat.service.js";

describe("sessionModePrefix", () => {
  it("returns the chat-mode line for interactive-chat", () => {
    const out = sessionModePrefix("interactive-chat");
    expect(out).toMatch(/^Session mode: interactive chat\b/);
    expect(out).toContain("context above contains the fund state");
    expect(out).toContain("respond to the user's message directly");
  });

  it("returns the autonomous-mode line for autonomous-scheduled", () => {
    const out = sessionModePrefix("autonomous-scheduled");
    expect(out).toMatch(/^Session mode: autonomous scheduled\b/);
    expect(out).toContain("Follow the session-init rule");
    expect(out).toContain("Orient sequence");
  });

  it("returns a single-line string with no embedded newlines", () => {
    expect(sessionModePrefix("interactive-chat")).not.toContain("\n");
    expect(sessionModePrefix("autonomous-scheduled")).not.toContain("\n");
  });

  it("returns the ask-mode line for interactive-ask", () => {
    const out = sessionModePrefix("interactive-ask");
    expect(out).toMatch(/^Session mode: interactive ask\b/);
    expect(out).toContain("Read-only one-shot question");
    expect(out).toContain("Do not execute trades");
    expect(out).not.toContain("\n");
  });
});
