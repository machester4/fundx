import { describe, it, expect } from "vitest";
import {
  parseAnalystReports,
  formatAnalystReportsForPrompt,
  formatPipelineReport,
} from "../src/debate.js";
import type { SubAgentResult, DebatePipelineResult } from "../src/types.js";
import {
  analystReportSchema,
  investmentDebateResultSchema,
  traderDecisionSchema,
  riskDebateResultSchema,
  fundManagerDecisionSchema,
  debatePipelineConfigSchema,
  debatePipelineResultSchema,
  debateArgumentSchema,
} from "../src/types.js";

// ── Schema Validation Tests ────────────────────────────────────

describe("TradingAgents debate schemas", () => {
  it("validates debateArgument schema", () => {
    const arg = {
      role: "bull",
      round: 1,
      argument: "Markets are favorable because...",
      key_points: ["Strong GDP growth", "Low unemployment"],
      counterpoints: ["Bear's inflation concern is overstated"],
    };
    const parsed = debateArgumentSchema.parse(arg);
    expect(parsed.role).toBe("bull");
    expect(parsed.round).toBe(1);
    expect(parsed.key_points).toHaveLength(2);
    expect(parsed.counterpoints).toHaveLength(1);
  });

  it("debateArgument defaults counterpoints to empty array", () => {
    const arg = {
      role: "bear",
      round: 1,
      argument: "Risks are elevated...",
      key_points: ["Rising rates"],
    };
    const parsed = debateArgumentSchema.parse(arg);
    expect(parsed.counterpoints).toEqual([]);
  });

  it("validates analystReport schema", () => {
    const report = {
      analyst_type: "macro",
      analyst_name: "Macro Analyst",
      signal: "bullish",
      confidence: 0.75,
      summary: "Economic conditions favorable",
      key_findings: ["GDP growing", "Low inflation"],
      raw_output: "Full output text...",
    };
    const parsed = analystReportSchema.parse(report);
    expect(parsed.signal).toBe("bullish");
    expect(parsed.confidence).toBe(0.75);
  });

  it("validates investmentDebateResult schema", () => {
    const result = {
      prevailing_perspective: "bullish",
      confidence: 0.8,
      rationale: "Bull arguments were stronger",
      key_bull_arguments: ["Strong earnings"],
      key_bear_arguments: ["Valuation concerns"],
      bull_history: [
        { role: "bull", round: 1, argument: "...", key_points: [], counterpoints: [] },
      ],
      bear_history: [
        { role: "bear", round: 1, argument: "...", key_points: [], counterpoints: [] },
      ],
      rounds_completed: 1,
    };
    const parsed = investmentDebateResultSchema.parse(result);
    expect(parsed.prevailing_perspective).toBe("bullish");
    expect(parsed.rounds_completed).toBe(1);
  });

  it("validates traderDecision schema", () => {
    const decision = {
      action: "BUY",
      symbols: ["AAPL", "MSFT"],
      reasoning: "Strong bullish signals across all analysts",
      conviction: 0.85,
      position_size_pct: 15,
      raw_output: "Full output...",
    };
    const parsed = traderDecisionSchema.parse(decision);
    expect(parsed.action).toBe("BUY");
    expect(parsed.symbols).toEqual(["AAPL", "MSFT"]);
    expect(parsed.conviction).toBe(0.85);
  });

  it("validates riskDebateResult schema", () => {
    const result = {
      approved: true,
      adjusted_action: "BUY",
      risk_adjustments: ["Reduce position to 10%", "Add stop-loss at -5%"],
      rationale: "Trade acceptable with reduced size",
      aggressive_summary: "Full size recommended",
      conservative_summary: "Reduce by half",
      neutral_summary: "Slight reduction advised",
      rounds_completed: 2,
    };
    const parsed = riskDebateResultSchema.parse(result);
    expect(parsed.approved).toBe(true);
    expect(parsed.risk_adjustments).toHaveLength(2);
  });

  it("validates fundManagerDecision schema", () => {
    const decision = {
      approved: true,
      final_action: "BUY",
      final_symbols: ["AAPL"],
      position_size_pct: 10,
      risk_adjustments_applied: ["Reduced from 15% to 10%"],
      rationale: "Approved with conservative sizing",
      raw_output: "Full output...",
    };
    const parsed = fundManagerDecisionSchema.parse(decision);
    expect(parsed.approved).toBe(true);
    expect(parsed.final_symbols).toEqual(["AAPL"]);
  });

  it("validates debatePipelineConfig with defaults", () => {
    const config = debatePipelineConfigSchema.parse({});
    expect(config.max_debate_rounds).toBe(2);
    expect(config.max_risk_debate_rounds).toBe(2);
    expect(config.include_trade_memory).toBe(true);
    expect(config.analyst_timeout_minutes).toBe(8);
    expect(config.debate_timeout_minutes).toBe(5);
  });

  it("validates debatePipelineConfig with custom values", () => {
    const config = debatePipelineConfigSchema.parse({
      max_debate_rounds: 3,
      max_risk_debate_rounds: 1,
      include_trade_memory: false,
    });
    expect(config.max_debate_rounds).toBe(3);
    expect(config.max_risk_debate_rounds).toBe(1);
    expect(config.include_trade_memory).toBe(false);
  });
});

// ── parseAnalystReports Tests ──────────────────────────────────

describe("parseAnalystReports", () => {
  const makeResult = (
    overrides: Partial<SubAgentResult> = {},
  ): SubAgentResult => ({
    type: "macro",
    name: "Macro Analyst",
    started_at: "2026-02-26T09:00:00Z",
    ended_at: "2026-02-26T09:05:00Z",
    status: "success",
    output: "Analysis output\nMACRO_SIGNAL: bullish\nCONFIDENCE: 0.8",
    ...overrides,
  });

  it("parses signals from analyst outputs", () => {
    const results: SubAgentResult[] = [
      makeResult({
        type: "macro",
        name: "Macro Analyst",
        output: "Good conditions\nMACRO_SIGNAL: bullish\nCONFIDENCE: 0.8",
      }),
      makeResult({
        type: "technical",
        name: "Technical Analyst",
        output: "Bearish pattern\nTECHNICAL_SIGNAL: bearish\nCONFIDENCE: 0.6",
      }),
    ];

    const reports = parseAnalystReports(results);
    expect(reports).toHaveLength(2);
    expect(reports[0].signal).toBe("bullish");
    expect(reports[0].confidence).toBe(0.8);
    expect(reports[1].signal).toBe("bearish");
    expect(reports[1].confidence).toBe(0.6);
  });

  it("defaults to neutral when signal is unrecognized", () => {
    const results: SubAgentResult[] = [
      makeResult({
        output: "Some analysis\nMACRO_SIGNAL: moderate",
      }),
    ];

    const reports = parseAnalystReports(results);
    expect(reports[0].signal).toBe("neutral");
  });

  it("defaults confidence to 0.5 when not provided", () => {
    const results: SubAgentResult[] = [
      makeResult({
        output: "Some analysis\nMACRO_SIGNAL: bullish",
      }),
    ];

    const reports = parseAnalystReports(results);
    expect(reports[0].confidence).toBe(0.5);
  });

  it("filters out failed agents", () => {
    const results: SubAgentResult[] = [
      makeResult({ status: "success" }),
      makeResult({ status: "error", output: "" }),
      makeResult({ status: "timeout", output: "" }),
    ];

    const reports = parseAnalystReports(results);
    expect(reports).toHaveLength(1);
  });

  it("extracts key findings when provided", () => {
    const results: SubAgentResult[] = [
      makeResult({
        output: [
          "Analysis",
          "MACRO_SIGNAL: bullish",
          "KEY_FINDINGS:",
          "- GDP growth at 3.2%",
          "- Unemployment at historic lows",
          "- Consumer spending strong",
        ].join("\n"),
      }),
    ];

    const reports = parseAnalystReports(results);
    expect(reports[0].key_findings).toHaveLength(3);
    expect(reports[0].key_findings[0]).toBe("GDP growth at 3.2%");
  });

  it("parses NEWS_SIGNAL for news analyst", () => {
    const results: SubAgentResult[] = [
      makeResult({
        type: "news",
        name: "News Analyst",
        output: "Breaking news\nNEWS_SIGNAL: bearish\nCONFIDENCE: 0.7",
      }),
    ];

    const reports = parseAnalystReports(results);
    expect(reports[0].signal).toBe("bearish");
    expect(reports[0].analyst_type).toBe("news");
  });

  it("handles empty results array", () => {
    const reports = parseAnalystReports([]);
    expect(reports).toHaveLength(0);
  });

  it("clamps confidence to [0, 1]", () => {
    const results: SubAgentResult[] = [
      makeResult({
        output: "Analysis\nMACRO_SIGNAL: bullish\nCONFIDENCE: 1.5",
      }),
    ];

    const reports = parseAnalystReports(results);
    expect(reports[0].confidence).toBe(1);
  });
});

// ── formatAnalystReportsForPrompt Tests ────────────────────────

describe("formatAnalystReportsForPrompt", () => {
  it("formats reports with signal summary", () => {
    const reports = [
      {
        analyst_type: "macro" as const,
        analyst_name: "Macro Analyst",
        signal: "bullish" as const,
        confidence: 0.8,
        summary: "Economy looks strong",
        key_findings: ["GDP growing"],
        raw_output: "...",
      },
      {
        analyst_type: "technical" as const,
        analyst_name: "Technical Analyst",
        signal: "bearish" as const,
        confidence: 0.6,
        summary: "Chart patterns bearish",
        key_findings: [],
        raw_output: "...",
      },
    ];

    const formatted = formatAnalystReportsForPrompt(reports);
    expect(formatted).toContain("Analyst Team Reports");
    expect(formatted).toContain("Macro Analyst");
    expect(formatted).toContain("**bullish**");
    expect(formatted).toContain("Technical Analyst");
    expect(formatted).toContain("**bearish**");
    expect(formatted).toContain("Signal Summary");
    expect(formatted).toContain("GDP growing");
  });
});

// ── formatPipelineReport Tests ────────────────────────────────

describe("formatPipelineReport", () => {
  const makePipelineResult = (): DebatePipelineResult => ({
    fund: "test-fund",
    started_at: "2026-02-26T09:00:00Z",
    ended_at: "2026-02-26T09:30:00Z",
    analyst_reports: [
      {
        analyst_type: "macro",
        analyst_name: "Macro Analyst",
        signal: "bullish",
        confidence: 0.8,
        summary: "Strong economy",
        key_findings: ["GDP up"],
        raw_output: "...",
      },
    ],
    investment_debate: {
      prevailing_perspective: "bullish",
      confidence: 0.75,
      rationale: "Bull had stronger arguments",
      key_bull_arguments: ["Strong earnings growth"],
      key_bear_arguments: ["High valuations"],
      bull_history: [],
      bear_history: [],
      rounds_completed: 2,
    },
    trader_decision: {
      action: "BUY",
      symbols: ["AAPL", "MSFT"],
      reasoning: "Bullish signals across the board",
      conviction: 0.8,
      position_size_pct: 15,
      raw_output: "...",
    },
    risk_debate: {
      approved: true,
      adjusted_action: "BUY",
      risk_adjustments: ["Reduce position to 10%"],
      rationale: "Acceptable with adjustments",
      aggressive_summary: "Go for it",
      conservative_summary: "Too risky",
      neutral_summary: "Moderate approach",
      rounds_completed: 2,
    },
    fund_manager_decision: {
      approved: true,
      final_action: "BUY",
      final_symbols: ["AAPL"],
      position_size_pct: 10,
      risk_adjustments_applied: ["Reduced from 15% to 10%"],
      rationale: "Approved with conservative sizing",
      raw_output: "...",
    },
    total_cost_usd: 0.5,
    pipeline_config: {
      max_debate_rounds: 2,
      max_risk_debate_rounds: 2,
      include_trade_memory: true,
      analyst_timeout_minutes: 8,
      debate_timeout_minutes: 5,
      trader_timeout_minutes: 5,
      risk_timeout_minutes: 5,
      manager_timeout_minutes: 3,
    },
  });

  it("generates a complete pipeline report", () => {
    const result = makePipelineResult();
    const report = formatPipelineReport(result);

    expect(report).toContain("TradingAgents Pipeline Report");
    expect(report).toContain("test-fund");
  });

  it("includes all 5 stages", () => {
    const result = makePipelineResult();
    const report = formatPipelineReport(result);

    expect(report).toContain("Stage 1: Analyst Reports");
    expect(report).toContain("Stage 2: Investment Debate");
    expect(report).toContain("Stage 3: Trader Decision");
    expect(report).toContain("Stage 4: Risk Management Debate");
    expect(report).toContain("Stage 5: Fund Manager Decision");
  });

  it("shows prevailing perspective from debate", () => {
    const result = makePipelineResult();
    const report = formatPipelineReport(result);

    expect(report).toContain("**bullish**");
    expect(report).toContain("Rounds: 2");
  });

  it("shows trader decision details", () => {
    const result = makePipelineResult();
    const report = formatPipelineReport(result);

    expect(report).toContain("**BUY**");
    expect(report).toContain("AAPL, MSFT");
    expect(report).toContain("80%");
  });

  it("shows risk debate outcome", () => {
    const result = makePipelineResult();
    const report = formatPipelineReport(result);

    expect(report).toContain("Approved: **true**");
    expect(report).toContain("Reduce position to 10%");
    expect(report).toContain("Aggressive view:");
    expect(report).toContain("Conservative view:");
    expect(report).toContain("Neutral view:");
  });

  it("shows fund manager final decision", () => {
    const result = makePipelineResult();
    const report = formatPipelineReport(result);

    expect(report).toContain("Final Action: **BUY**");
    expect(report).toContain("Position Size: 10%");
    expect(report).toContain("Reduced from 15% to 10%");
  });

  it("includes pipeline config as JSON", () => {
    const result = makePipelineResult();
    const report = formatPipelineReport(result);

    expect(report).toContain('"max_debate_rounds":2');
  });
});

// ── Full Pipeline Schema Validation ───────────────────────────

describe("debatePipelineResult schema", () => {
  it("validates a complete pipeline result", () => {
    const result = {
      fund: "test-fund",
      started_at: "2026-02-26T09:00:00Z",
      ended_at: "2026-02-26T09:30:00Z",
      analyst_reports: [
        {
          analyst_type: "macro",
          analyst_name: "Macro Analyst",
          signal: "bullish",
          confidence: 0.8,
          summary: "Strong",
          key_findings: [],
          raw_output: "...",
        },
      ],
      investment_debate: {
        prevailing_perspective: "bullish",
        confidence: 0.75,
        rationale: "Bull won",
        key_bull_arguments: ["arg1"],
        key_bear_arguments: ["arg2"],
        bull_history: [],
        bear_history: [],
        rounds_completed: 2,
      },
      trader_decision: {
        action: "BUY",
        symbols: ["AAPL"],
        reasoning: "Buy",
        conviction: 0.8,
        raw_output: "...",
      },
      risk_debate: {
        approved: true,
        adjusted_action: "BUY",
        risk_adjustments: [],
        rationale: "OK",
        aggressive_summary: "Go",
        conservative_summary: "Wait",
        neutral_summary: "Maybe",
        rounds_completed: 1,
      },
      fund_manager_decision: {
        approved: true,
        final_action: "BUY",
        final_symbols: ["AAPL"],
        rationale: "Approved",
        risk_adjustments_applied: [],
        raw_output: "...",
      },
      total_cost_usd: 0.5,
      pipeline_config: {
        max_debate_rounds: 2,
        max_risk_debate_rounds: 2,
        include_trade_memory: true,
        analyst_timeout_minutes: 8,
        debate_timeout_minutes: 5,
        trader_timeout_minutes: 5,
        risk_timeout_minutes: 5,
        manager_timeout_minutes: 3,
      },
    };

    const parsed = debatePipelineResultSchema.parse(result);
    expect(parsed.fund).toBe("test-fund");
    expect(parsed.investment_debate.prevailing_perspective).toBe("bullish");
    expect(parsed.trader_decision.action).toBe("BUY");
    expect(parsed.risk_debate.approved).toBe(true);
    expect(parsed.fund_manager_decision.approved).toBe(true);
  });
});
