import { describe, it, expect } from "vitest";
import {
  buildAnalystAgents,
} from "../src/subagent.js";

// ── buildAnalystAgents ────────────────────────────────────────

describe("buildAnalystAgents", () => {
  it("returns 5 agent definitions", () => {
    const agents = buildAnalystAgents("test-fund");
    const keys = Object.keys(agents);
    expect(keys).toHaveLength(5);
    expect(keys).toContain("macro-analyst");
    expect(keys).toContain("technical-analyst");
    expect(keys).toContain("sentiment-analyst");
    expect(keys).toContain("news-analyst");
    expect(keys).toContain("risk-analyst");
  });

  it("each agent has required AgentDefinition fields", () => {
    const agents = buildAnalystAgents("test-fund");
    for (const [, agent] of Object.entries(agents)) {
      expect(agent.description).toBeTruthy();
      expect(agent.prompt).toBeTruthy();
      expect(agent.model).toBe("sonnet");
      expect(agent.maxTurns).toBe(20);
    }
  });

  it("includes fund name in agent prompts", () => {
    const agents = buildAnalystAgents("my-fund");
    for (const [, agent] of Object.entries(agents)) {
      expect(agent.prompt).toContain("my-fund");
    }
  });

  it("assigns mcpServers to each agent", () => {
    const agents = buildAnalystAgents("test-fund");
    expect(agents["macro-analyst"].mcpServers).toContain("market-data");
    expect(agents["risk-analyst"].mcpServers).toContain("broker-alpaca");
    expect(agents["risk-analyst"].mcpServers).toContain("market-data");
  });

  it("assigns tools to each agent", () => {
    const agents = buildAnalystAgents("test-fund");
    for (const [, agent] of Object.entries(agents)) {
      expect(agent.tools).toBeDefined();
      expect(agent.tools!.length).toBeGreaterThan(0);
      expect(agent.tools).toContain("Read");
    }
  });
});
