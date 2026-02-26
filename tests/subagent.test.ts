import { describe, it, expect } from "vitest";
import {
  getDefaultSubAgents,
  mergeSubAgentResults,
  buildAnalystAgents,
} from "../src/subagent.js";
import type { SubAgentResult } from "../src/types.js";

describe("getDefaultSubAgents", () => {
  it("returns five default analysis agents", () => {
    const agents = getDefaultSubAgents("test-fund");
    expect(agents).toHaveLength(5);

    const types = agents.map((a) => a.type);
    expect(types).toContain("macro");
    expect(types).toContain("technical");
    expect(types).toContain("sentiment");
    expect(types).toContain("news");
    expect(types).toContain("risk");
  });

  it("includes fund name in prompts", () => {
    const agents = getDefaultSubAgents("my-growth-fund");
    for (const agent of agents) {
      expect(agent.prompt).toContain("my-growth-fund");
    }
  });

  it("each agent has a name and max_turns", () => {
    const agents = getDefaultSubAgents("test-fund");
    for (const agent of agents) {
      expect(agent.name).toBeTruthy();
      expect(agent.max_turns).toBeGreaterThan(0);
    }
  });
});

describe("mergeSubAgentResults", () => {
  const makeResult = (
    overrides: Partial<SubAgentResult> = {},
  ): SubAgentResult => ({
    type: "macro",
    name: "Macro Analyst",
    started_at: "2026-02-24T09:00:00Z",
    ended_at: "2026-02-24T09:05:00Z",
    status: "success",
    output: "Macro analysis output",
    ...overrides,
  });

  it("generates combined markdown document", () => {
    const results: SubAgentResult[] = [
      makeResult({ type: "macro", name: "Macro Analyst" }),
      makeResult({ type: "technical", name: "Technical Analyst" }),
    ];

    const merged = mergeSubAgentResults(results);

    expect(merged).toContain("Combined Sub-Agent Analysis");
    expect(merged).toContain("Agent Summary");
    expect(merged).toContain("Macro Analyst");
    expect(merged).toContain("Technical Analyst");
  });

  it("includes agent summary table", () => {
    const results: SubAgentResult[] = [
      makeResult({ status: "success", name: "Macro Analyst" }),
      makeResult({ status: "error", name: "Failed Agent", error: "Connection timeout" }),
      makeResult({ status: "timeout", name: "Slow Agent" }),
    ];

    const merged = mergeSubAgentResults(results);

    expect(merged).toContain("| Macro Analyst | OK |");
    expect(merged).toContain("| Failed Agent | ERR |");
    expect(merged).toContain("| Slow Agent | TIMEOUT |");
  });

  it("includes individual agent outputs", () => {
    const results: SubAgentResult[] = [
      makeResult({
        name: "Macro Analyst",
        output: "The Fed is expected to hold rates steady.",
      }),
    ];

    const merged = mergeSubAgentResults(results);
    expect(merged).toContain("The Fed is expected to hold rates steady.");
  });

  it("shows error messages for failed agents", () => {
    const results: SubAgentResult[] = [
      makeResult({
        name: "Failed Agent",
        status: "error",
        output: "",
        error: "API connection failed",
      }),
    ];

    const merged = mergeSubAgentResults(results);
    expect(merged).toContain("API connection failed");
  });

  it("extracts consolidated signals from output", () => {
    const results: SubAgentResult[] = [
      makeResult({
        type: "macro",
        output: "Analysis text\nMACRO_SIGNAL: bullish\nMore text",
      }),
      makeResult({
        type: "technical",
        output: "Charts show\nTECHNICAL_SIGNAL: neutral\nMore",
      }),
      makeResult({
        type: "sentiment",
        output: "News is\nSENTIMENT_SIGNAL: bearish",
      }),
      makeResult({
        type: "risk",
        output: "Risk is\nRISK_LEVEL: moderate",
      }),
    ];

    const merged = mergeSubAgentResults(results);

    expect(merged).toContain("Consolidated Signals");
    expect(merged).toContain("MACRO_SIGNAL: bullish");
    expect(merged).toContain("TECHNICAL_SIGNAL: neutral");
    expect(merged).toContain("SENTIMENT_SIGNAL: bearish");
    expect(merged).toContain("RISK_LEVEL: moderate");
  });

  it("calculates duration from timestamps", () => {
    const results: SubAgentResult[] = [
      makeResult({
        started_at: "2026-02-24T09:00:00Z",
        ended_at: "2026-02-24T09:05:00Z",
      }),
    ];

    const merged = mergeSubAgentResults(results);
    expect(merged).toContain("300s"); // 5 minutes = 300 seconds
  });

  it("handles empty results array", () => {
    const merged = mergeSubAgentResults([]);
    expect(merged).toContain("Combined Sub-Agent Analysis");
    expect(merged).toContain("Agents: 0");
  });
});

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
      expect(agent.model).toBe("haiku");
      expect(agent.maxTurns).toBeGreaterThan(0);
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

