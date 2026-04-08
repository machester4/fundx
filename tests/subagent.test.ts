import { describe, it, expect } from "vitest";
import { buildAnalystAgents } from "../src/subagent.js";

// ── buildAnalystAgents ────────────────────────────────────────

describe("buildAnalystAgents", () => {
  const agents = buildAnalystAgents("test-fund");
  const keys = Object.keys(agents);

  // ── Structure ───────────────────────────────────────────────

  it("returns exactly 4 agent definitions", () => {
    expect(keys).toHaveLength(4);
  });

  it("contains the new agent names", () => {
    expect(keys).toContain("market-analyst");
    expect(keys).toContain("technical-analyst");
    expect(keys).toContain("risk-guardian");
    expect(keys).toContain("trade-evaluator");
  });

  it("does NOT contain old agent names", () => {
    expect(keys).not.toContain("macro-analyst");
    expect(keys).not.toContain("sentiment-analyst");
    expect(keys).not.toContain("news-analyst");
    expect(keys).not.toContain("risk-analyst");
  });

  // ── Common fields ──────────────────────────────────────────

  it("each agent has required AgentDefinition fields", () => {
    for (const [, agent] of Object.entries(agents)) {
      expect(agent.description).toBeTruthy();
      expect(agent.prompt).toBeTruthy();
      expect(agent.model).toBe("sonnet");
      expect(typeof agent.maxTurns).toBe("number");
      expect(agent.maxTurns).toBeGreaterThan(0);
    }
  });

  it("includes fund name in all agent prompts", () => {
    const namedAgents = buildAnalystAgents("my-fund");
    for (const [, agent] of Object.entries(namedAgents)) {
      expect(agent.prompt).toContain("my-fund");
    }
  });

  it("all agents include Read in their tools", () => {
    for (const [, agent] of Object.entries(agents)) {
      expect(agent.tools).toBeDefined();
      expect(agent.tools!.length).toBeGreaterThan(0);
      expect(agent.tools).toContain("Read");
    }
  });

  // ── market-analyst ─────────────────────────────────────────

  describe("market-analyst", () => {
    const agent = agents["market-analyst"];

    it("has market-data MCP server", () => {
      expect(agent.mcpServers).toContain("market-data");
    });

    it("covers macro domain", () => {
      expect(agent.prompt).toMatch(/monetary policy/i);
      expect(agent.prompt).toMatch(/economic cycle/i);
      expect(agent.prompt).toMatch(/geopolitical/i);
    });

    it("covers sentiment domain", () => {
      expect(agent.prompt).toMatch(/VIX/);
      expect(agent.prompt).toMatch(/put.call/i);
      expect(agent.prompt).toMatch(/breadth/i);
      expect(agent.prompt).toMatch(/contrarian/i);
    });

    it("covers news domain", () => {
      expect(agent.prompt).toMatch(/breaking/i);
      expect(agent.prompt).toMatch(/regulatory/i);
      expect(agent.prompt).toMatch(/catalyst/i);
      expect(agent.prompt).toMatch(/insider/i);
    });

    it("has anti-hallucination directive", () => {
      expect(agent.prompt).toMatch(/never cite a price.*without retrieving/i);
    });

    it("outputs <market_assessment> XML", () => {
      expect(agent.prompt).toContain("<market_assessment>");
    });

    it("has maxTurns of 25", () => {
      expect(agent.maxTurns).toBe(25);
    });

    it("references MCP tool guidance", () => {
      expect(agent.prompt).toMatch(/get_news/);
      expect(agent.prompt).toMatch(/get_rss_news/);
      expect(agent.prompt).toMatch(/get_market_movers/);
    });

    it("instructs agent to write analysis to file", () => {
      expect(agent.prompt).toContain("analysis/");
      expect(agent.prompt).toContain("_market-assessment.md");
    });

    it("has Write in tools", () => {
      expect(agents["market-analyst"].tools).toContain("Write");
    });
  });

  // ── technical-analyst ──────────────────────────────────────

  describe("technical-analyst", () => {
    const agent = agents["technical-analyst"];

    it("has market-data MCP server", () => {
      expect(agent.mcpServers).toContain("market-data");
    });

    it("has evidence-based guidance", () => {
      expect(agent.prompt).toMatch(/evidence.based/i);
      expect(agent.prompt).toMatch(/academic support/i);
      expect(agent.prompt).toMatch(/200.day MA/i);
    });

    it("outputs <technical_assessment> XML", () => {
      expect(agent.prompt).toContain("<technical_assessment>");
    });

    it("has maxTurns of 20", () => {
      expect(agent.maxTurns).toBe(20);
    });

    it("instructs agent to write analysis to file", () => {
      expect(agent.prompt).toContain("analysis/");
      expect(agent.prompt).toContain("_technical-");
    });

    it("has Write in tools", () => {
      expect(agents["technical-analyst"].tools).toContain("Write");
    });
  });

  // ── risk-guardian ──────────────────────────────────────────

  describe("risk-guardian", () => {
    const agent = agents["risk-guardian"];

    it("has both broker-local and market-data MCP servers", () => {
      expect(agent.mcpServers).toContain("broker-local");
      expect(agent.mcpServers).toContain("market-data");
    });

    it("outputs APPROVED/REJECTED verdict in <risk_validation> XML", () => {
      expect(agent.prompt).toContain("<risk_validation>");
      expect(agent.prompt).toMatch(/APPROVED/);
      expect(agent.prompt).toMatch(/REJECTED/);
      expect(agent.prompt).toMatch(/VERDICT/);
    });

    it("has lower maxTurns than other agents", () => {
      expect(agent.maxTurns).toBe(15);
      expect(agent.maxTurns).toBeLessThan(agents["market-analyst"].maxTurns!);
      expect(agent.maxTurns).toBeLessThan(agents["technical-analyst"].maxTurns!);
    });

    it("includes drawdown recovery table", () => {
      expect(agent.prompt).toMatch(/-10%.*\+11\.1%/);
      expect(agent.prompt).toMatch(/-50%.*\+100%/);
    });

    it("includes correlation rule", () => {
      expect(agent.prompt).toMatch(/0\.7/);
    });

    it("includes drawdown budget tiers", () => {
      expect(agent.prompt).toMatch(/50-75%/);
      expect(agent.prompt).toMatch(/half sizing/i);
    });

    it("has adversarial behavioral directive", () => {
      expect(agent.prompt).toMatch(/find reasons to reject/i);
    });

    it("has description mentioning hard gate", () => {
      expect(agent.description).toMatch(/hard gate/i);
    });

    it("instructs agent to write validation to file", () => {
      expect(agent.prompt).toContain("analysis/");
      expect(agent.prompt).toContain("_risk-validation-");
    });

    it("has Write in tools", () => {
      expect(agents["risk-guardian"].tools).toContain("Write");
    });
  });

  // ── trade-evaluator ────────────────────────────────────────

  describe("trade-evaluator", () => {
    const agent = agents["trade-evaluator"];

    it("has market-data MCP server", () => {
      expect(agent.mcpServers).toContain("market-data");
    });

    it("has skepticism-tuned prompt", () => {
      expect(agent.prompt).toMatch(/skeptical/i);
      expect(agent.prompt).toMatch(/find reasons NOT to/i);
    });

    it("checks for cognitive biases", () => {
      expect(agent.prompt).toMatch(/confirmation bias/i);
      expect(agent.prompt).toMatch(/FOMO/i);
      expect(agent.prompt).toMatch(/anchoring/i);
      expect(agent.prompt).toMatch(/recency bias/i);
    });

    it("checks journal consultation", () => {
      expect(agent.prompt).toMatch(/journal/i);
      expect(agent.prompt).toMatch(/consulted/i);
    });

    it("outputs <trade_evaluation> XML", () => {
      expect(agent.prompt).toContain("<trade_evaluation>");
      expect(agent.prompt).toContain("SCORE");
      expect(agent.prompt).toContain("RECOMMENDATION");
      expect(agent.prompt).toContain("PROCEED");
      expect(agent.prompt).toContain("RECONSIDER");
      expect(agent.prompt).toContain("REJECT");
    });

    it("has maxTurns of 15", () => {
      expect(agent.maxTurns).toBe(15);
    });

    it("includes fund name in prompt", () => {
      const namedAgents = buildAnalystAgents("my-fund");
      expect(namedAgents["trade-evaluator"].prompt).toContain("my-fund");
    });

    it("instructs agent to write evaluation to file", () => {
      expect(agent.prompt).toContain("analysis/");
      expect(agent.prompt).toContain("_trade-evaluation-");
    });

    it("has Write in tools", () => {
      expect(agents["trade-evaluator"].tools).toContain("Write");
    });
  });
});
