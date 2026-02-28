import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

// ── AgentDefinition Builders (for SDK Task tool) ──────────────

/**
 * Build AgentDefinition objects for the Claude Agent SDK.
 *
 * These are passed via the `agents` option in `runAgentQuery()`, making them
 * available to the main session agent via the Task tool. The agent decides
 * when to invoke each analyst based on the descriptions.
 */
export function buildAnalystAgents(
  fundName: string,
): Record<string, AgentDefinition> {
  return {
    "macro-analyst": {
      description:
        "Use this agent to analyze macroeconomic conditions — interest rates, Fed policy, GDP, inflation, sector rotation, geopolitical events. Use when you need a macro perspective before making trading decisions.",
      tools: ["Read", "WebSearch", "Bash", "Grep", "Glob"],
      prompt: [
        `You are the macro analysis agent for fund '${fundName}'.`,
        ``,
        `Analyze current macroeconomic conditions relevant to this fund's holdings and universe.`,
        `Focus on:`,
        `- Interest rates, Fed policy, and yield curve analysis`,
        `- GDP, employment, inflation data and trends`,
        `- Sector rotation and market regime (risk-on vs risk-off)`,
        `- Geopolitical events affecting markets`,
        `- Currency movements and correlations`,
        ``,
        `Use market-data MCP tools to gather current data.`,
        `Output a concise analysis in markdown with clear conclusions.`,
        `End with: MACRO_SIGNAL: bullish | neutral | bearish`,
        `And: CONFIDENCE: 0.0 to 1.0`,
      ].join("\n"),
      model: "haiku",
      mcpServers: ["market-data"],
      maxTurns: 15,
    },
    "technical-analyst": {
      description:
        "Use this agent to perform technical analysis on specific symbols — price action, moving averages, support/resistance, volume patterns, momentum indicators, chart patterns.",
      tools: ["Read", "Bash", "Grep", "Glob"],
      prompt: [
        `You are the technical analysis agent for fund '${fundName}'.`,
        ``,
        `Perform technical analysis on the fund's current holdings and watchlist.`,
        `Focus on:`,
        `- Price action and trend analysis (moving averages, support/resistance)`,
        `- Volume patterns and momentum indicators`,
        `- Chart patterns and breakout/breakdown levels`,
        `- Relative strength vs. benchmarks (SPY)`,
        `- Key price levels for entry/exit decisions`,
        ``,
        `Use market-data MCP tools to fetch historical bars and current quotes.`,
        `Output a concise analysis in markdown for each ticker.`,
        `End with: TECHNICAL_SIGNAL: bullish | neutral | bearish`,
        `And: CONFIDENCE: 0.0 to 1.0`,
      ].join("\n"),
      model: "haiku",
      mcpServers: ["market-data"],
      maxTurns: 15,
    },
    "sentiment-analyst": {
      description:
        "Use this agent to analyze market sentiment — news sentiment, VIX, put/call ratios, earnings surprises, analyst ratings, social sentiment.",
      tools: ["Read", "WebSearch", "Grep", "Glob"],
      prompt: [
        `You are the sentiment analysis agent for fund '${fundName}'.`,
        ``,
        `Analyze market sentiment and news relevant to this fund.`,
        `Focus on:`,
        `- Recent news headlines affecting holdings and watchlist`,
        `- Market breadth and volatility (VIX, put/call ratios)`,
        `- Earnings surprises and guidance changes`,
        `- Analyst upgrades/downgrades`,
        `- Social and institutional sentiment shifts`,
        ``,
        `Use market-data MCP tools (get_news, get_market_movers, get_most_active).`,
        `Output a concise sentiment report in markdown.`,
        `End with: SENTIMENT_SIGNAL: bullish | neutral | bearish`,
        `And: CONFIDENCE: 0.0 to 1.0`,
      ].join("\n"),
      model: "haiku",
      mcpServers: ["market-data"],
      maxTurns: 15,
    },
    "news-analyst": {
      description:
        "Use this agent to analyze recent news, breaking events, regulatory changes, insider activity, and upcoming catalysts relevant to the fund's holdings and watchlist.",
      tools: ["Read", "WebSearch", "Grep", "Glob"],
      prompt: [
        `You are the news analysis agent for fund '${fundName}'.`,
        ``,
        `Analyze recent news and developments relevant to this fund.`,
        `Focus on:`,
        `- Breaking news affecting holdings or watchlist companies`,
        `- Major world events (geopolitical, regulatory, policy changes)`,
        `- Industry and sector-specific developments`,
        `- Insider transactions and institutional activity`,
        `- Upcoming catalysts (earnings, FDA approvals, product launches)`,
        ``,
        `Use market-data MCP tools (get_news, get_market_movers) to gather current data.`,
        `Output a concise news analysis in markdown with impact assessments.`,
        `End with: NEWS_SIGNAL: bullish | neutral | bearish`,
        `And: CONFIDENCE: 0.0 to 1.0`,
      ].join("\n"),
      model: "haiku",
      mcpServers: ["market-data"],
      maxTurns: 15,
    },
    "risk-analyst": {
      description:
        "Use this agent to assess portfolio risk — concentration, correlation between holdings, stop-loss validation, drawdown analysis, liquidity risk, and distance to objective milestones.",
      tools: ["Read", "Bash", "Grep", "Glob"],
      prompt: [
        `You are the risk management agent for fund '${fundName}'.`,
        ``,
        `Assess portfolio risk and ensure compliance with fund constraints.`,
        `Focus on:`,
        `- Current portfolio exposure and concentration risk`,
        `- Stop-loss levels and position sizing validation`,
        `- Drawdown analysis vs. fund limits`,
        `- Correlation between holdings`,
        `- Liquidity risk assessment`,
        `- Distance to objective milestones`,
        ``,
        `Read portfolio.json, objective_tracker.json, and risk constraints from CLAUDE.md.`,
        `Use broker-alpaca MCP tools to check current positions and account status.`,
        `Output a risk report in markdown.`,
        `End with: RISK_LEVEL: low | moderate | elevated | high`,
        `And: CONFIDENCE: 0.0 to 1.0`,
      ].join("\n"),
      model: "haiku",
      mcpServers: ["broker-alpaca", "market-data"],
      maxTurns: 15,
    },
  };
}
