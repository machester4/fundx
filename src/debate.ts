import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { fundPaths } from "./paths.js";
import { runAgentQuery } from "./agent.js";
import {
  runSubAgents,
  getDefaultSubAgents,
} from "./subagent.js";
import type {
  SubAgentResult,
  AnalystReport,
  InvestmentDebateResult,
  DebateArgument,
  TraderDecision,
  RiskDebateResult,
  FundManagerDecision,
  DebatePipelineConfig,
  DebatePipelineResult,
} from "./types.js";
import { debatePipelineConfigSchema } from "./types.js";

/**
 * TradingAgents Debate Pipeline (adapted from arXiv:2412.20138)
 *
 * Implements the 5-stage multi-agent trading framework:
 *   1. Analyst Team — parallel data gathering (macro, technical, sentiment, news, risk)
 *   2. Researcher Team — bull vs bear dialectical debate (n rounds)
 *   3. Trader Agent — synthesizes analyst reports + debate → BUY/HOLD/SELL
 *   4. Risk Management Team — 3-way debate (aggressive, conservative, neutral)
 *   5. Fund Manager — final approval with risk adjustments
 *
 * All agents run via the Claude Agent SDK (runAgentQuery).
 */

// ── Stage 1: Analyst Team ─────────────────────────────────────

/**
 * Parse structured analyst reports from sub-agent raw outputs.
 * Extracts signal, confidence, and key findings from markdown output.
 */
export function parseAnalystReports(results: SubAgentResult[]): AnalystReport[] {
  return results
    .filter((r) => r.status === "success")
    .map((r) => {
      const signalMatch = r.output.match(
        /(?:MACRO_SIGNAL|TECHNICAL_SIGNAL|SENTIMENT_SIGNAL|NEWS_SIGNAL|RISK_LEVEL):\s*(\w+)/i,
      );
      const rawSignal = signalMatch?.[1]?.toLowerCase() ?? "neutral";
      const signal =
        rawSignal === "bullish" || rawSignal === "bearish" ? rawSignal : "neutral";

      const confidenceMatch = r.output.match(/CONFIDENCE:\s*([\d.]+)/i);
      const confidence = confidenceMatch
        ? Math.min(1, Math.max(0, parseFloat(confidenceMatch[1])))
        : 0.5;

      const findingsMatch = r.output.match(
        /KEY_FINDINGS:\s*\n((?:[-*]\s+.+\n?)+)/i,
      );
      const keyFindings = findingsMatch
        ? findingsMatch[1]
            .split("\n")
            .map((l) => l.replace(/^[-*]\s+/, "").trim())
            .filter(Boolean)
        : [];

      const summaryMatch = r.output.match(/SUMMARY:\s*(.+?)(?:\n\n|\n[A-Z_]+:)/s);
      const summary = summaryMatch?.[1]?.trim() ?? r.output.slice(0, 500);

      return {
        analyst_type: r.type,
        analyst_name: r.name,
        signal: signal as "bullish" | "neutral" | "bearish",
        confidence,
        summary,
        key_findings: keyFindings,
        raw_output: r.output,
      };
    });
}

/**
 * Format analyst reports as a structured context string for downstream agents.
 */
export function formatAnalystReportsForPrompt(reports: AnalystReport[]): string {
  const sections: string[] = ["## Analyst Team Reports\n"];

  for (const r of reports) {
    sections.push(`### ${r.analyst_name} (${r.analyst_type})`);
    sections.push(`Signal: **${r.signal}** (confidence: ${(r.confidence * 100).toFixed(0)}%)`);
    sections.push(`Summary: ${r.summary}`);
    if (r.key_findings.length > 0) {
      sections.push("Key findings:");
      for (const f of r.key_findings) {
        sections.push(`- ${f}`);
      }
    }
    sections.push("");
  }

  // Signal summary
  const signals = reports.map((r) => `${r.analyst_name}: ${r.signal}`);
  sections.push("### Signal Summary");
  for (const s of signals) {
    sections.push(`- ${s}`);
  }

  return sections.join("\n");
}

// ── Stage 2: Investment Debate (Bull vs Bear) ─────────────────

/**
 * Build the prompt for a bull researcher in a given debate round.
 */
function buildBullPrompt(
  fundName: string,
  reports: AnalystReport[],
  bearHistory: DebateArgument[],
  round: number,
  totalRounds: number,
  tradeMemory: string,
): string {
  const analysisContext = formatAnalystReportsForPrompt(reports);
  const lastBearArg = bearHistory.length > 0
    ? bearHistory[bearHistory.length - 1].argument
    : "No bear arguments yet — you are presenting the opening bullish case.";

  return [
    `You are the BULL RESEARCHER for fund '${fundName}'.`,
    `This is round ${round + 1} of ${totalRounds} in an investment debate.`,
    ``,
    `Your role: Build a strong, evidence-based case emphasizing growth potential,`,
    `competitive advantages, and positive market indicators for the fund's holdings and universe.`,
    ``,
    `## Analyst Reports`,
    analysisContext,
    ``,
    `## Bear Researcher's Previous Argument`,
    lastBearArg,
    ``,
    tradeMemory ? `## Historical Trade Lessons\n${tradeMemory}\n` : "",
    `## Instructions`,
    `1. Build on the analyst reports to argue FOR investment opportunities`,
    `2. Directly counter the bear researcher's arguments with specific data`,
    `3. Focus on: growth potential, competitive advantages, positive indicators`,
    `4. Be conversational — engage with the opposing argument, don't just list facts`,
    ``,
    `## Required Output Format`,
    `Provide your argument, then end with:`,
    `KEY_POINTS:`,
    `- point 1`,
    `- point 2`,
    `- ...`,
    `COUNTERPOINTS:`,
    `- counter to bear argument 1`,
    `- counter to bear argument 2`,
    `- ...`,
  ].join("\n");
}

/**
 * Build the prompt for a bear researcher in a given debate round.
 */
function buildBearPrompt(
  fundName: string,
  reports: AnalystReport[],
  bullHistory: DebateArgument[],
  round: number,
  totalRounds: number,
  tradeMemory: string,
): string {
  const analysisContext = formatAnalystReportsForPrompt(reports);
  const lastBullArg = bullHistory.length > 0
    ? bullHistory[bullHistory.length - 1].argument
    : "No bull arguments yet — you are presenting the opening bearish case.";

  return [
    `You are the BEAR RESEARCHER for fund '${fundName}'.`,
    `This is round ${round + 1} of ${totalRounds} in an investment debate.`,
    ``,
    `Your role: Present a well-reasoned argument emphasizing risks, challenges,`,
    `and negative indicators. Critically analyze the bull argument with specific data,`,
    `exposing weaknesses or over-optimistic assumptions.`,
    ``,
    `## Analyst Reports`,
    analysisContext,
    ``,
    `## Bull Researcher's Previous Argument`,
    lastBullArg,
    ``,
    tradeMemory ? `## Historical Trade Lessons\n${tradeMemory}\n` : "",
    `## Instructions`,
    `1. Build on the analyst reports to argue AGAINST or for CAUTION`,
    `2. Directly counter the bull researcher's arguments with specific data`,
    `3. Focus on: financial vulnerabilities, negative indicators, adverse news`,
    `4. Be conversational — engage with the opposing argument, don't just list facts`,
    ``,
    `## Required Output Format`,
    `Provide your argument, then end with:`,
    `KEY_POINTS:`,
    `- point 1`,
    `- point 2`,
    `- ...`,
    `COUNTERPOINTS:`,
    `- counter to bull argument 1`,
    `- counter to bull argument 2`,
    `- ...`,
  ].join("\n");
}

/**
 * Parse key points and counterpoints from a debate argument output.
 */
function parseDebateOutput(output: string): {
  keyPoints: string[];
  counterpoints: string[];
} {
  const keyPointsMatch = output.match(
    /KEY_POINTS:\s*\n((?:[-*]\s+.+\n?)+)/i,
  );
  const keyPoints = keyPointsMatch
    ? keyPointsMatch[1]
        .split("\n")
        .map((l) => l.replace(/^[-*]\s+/, "").trim())
        .filter(Boolean)
    : [];

  const counterpointsMatch = output.match(
    /COUNTERPOINTS:\s*\n((?:[-*]\s+.+\n?)+)/i,
  );
  const counterpoints = counterpointsMatch
    ? counterpointsMatch[1]
        .split("\n")
        .map((l) => l.replace(/^[-*]\s+/, "").trim())
        .filter(Boolean)
    : [];

  return { keyPoints, counterpoints };
}

/**
 * Run the investment debate: alternating bull/bear arguments for n rounds.
 * Each round consists of bull argument → bear response (or vice versa).
 */
export async function runInvestmentDebate(
  fundName: string,
  reports: AnalystReport[],
  config: DebatePipelineConfig,
  options?: { model?: string; tradeMemory?: string },
): Promise<InvestmentDebateResult> {
  const bullHistory: DebateArgument[] = [];
  const bearHistory: DebateArgument[] = [];
  const timeout = config.debate_timeout_minutes * 60 * 1000;
  const tradeMemory = options?.tradeMemory ?? "";

  for (let round = 0; round < config.max_debate_rounds; round++) {
    // Bull argues first
    const bullPrompt = buildBullPrompt(
      fundName, reports, bearHistory, round, config.max_debate_rounds, tradeMemory,
    );
    const bullResult = await runAgentQuery({
      fundName,
      prompt: bullPrompt,
      model: options?.model,
      maxTurns: 10,
      timeoutMs: timeout,
      maxBudgetUsd: 1.5,
    });

    const bullParsed = parseDebateOutput(bullResult.output);
    bullHistory.push({
      role: "bull",
      round: round + 1,
      argument: bullResult.output,
      key_points: bullParsed.keyPoints,
      counterpoints: bullParsed.counterpoints,
    });

    // Bear responds
    const bearPrompt = buildBearPrompt(
      fundName, reports, bullHistory, round, config.max_debate_rounds, tradeMemory,
    );
    const bearResult = await runAgentQuery({
      fundName,
      prompt: bearPrompt,
      model: options?.model,
      maxTurns: 10,
      timeoutMs: timeout,
      maxBudgetUsd: 1.5,
    });

    const bearParsed = parseDebateOutput(bearResult.output);
    bearHistory.push({
      role: "bear",
      round: round + 1,
      argument: bearResult.output,
      key_points: bearParsed.keyPoints,
      counterpoints: bearParsed.counterpoints,
    });
  }

  // Facilitator / judge reviews the debate and selects prevailing perspective
  const judgeResult = await runInvestmentJudge(
    fundName, reports, bullHistory, bearHistory, options?.model,
  );

  return judgeResult;
}

/**
 * The investment debate facilitator: reviews the full debate history
 * and determines the prevailing perspective.
 */
async function runInvestmentJudge(
  fundName: string,
  reports: AnalystReport[],
  bullHistory: DebateArgument[],
  bearHistory: DebateArgument[],
  model?: string,
): Promise<InvestmentDebateResult> {
  const debateTranscript = formatDebateTranscript(bullHistory, bearHistory);

  const prompt = [
    `You are the INVESTMENT DEBATE FACILITATOR for fund '${fundName}'.`,
    ``,
    `You have observed a structured debate between bull and bear researchers.`,
    `Your job is to objectively evaluate both sides and determine which perspective`,
    `is better supported by the evidence.`,
    ``,
    `## Debate Transcript`,
    debateTranscript,
    ``,
    `## Instructions`,
    `1. Evaluate the strength of arguments on both sides`,
    `2. Consider which side had stronger evidence and better countered the opposition`,
    `3. Determine the prevailing perspective`,
    `4. You MUST be decisive — leaning neutral is only appropriate if evidence is truly balanced`,
    ``,
    `## Required Output Format (strict — follow exactly)`,
    `PREVAILING_PERSPECTIVE: bullish | bearish | neutral`,
    `CONFIDENCE: 0.0 to 1.0`,
    `RATIONALE: your reasoning`,
    `KEY_BULL_ARGUMENTS:`,
    `- strongest bull point 1`,
    `- strongest bull point 2`,
    `KEY_BEAR_ARGUMENTS:`,
    `- strongest bear point 1`,
    `- strongest bear point 2`,
  ].join("\n");

  const result = await runAgentQuery({
    fundName,
    prompt,
    model,
    maxTurns: 5,
    timeoutMs: 3 * 60 * 1000,
    maxBudgetUsd: 1.0,
  });

  // Parse judge output
  const perspectiveMatch = result.output.match(
    /PREVAILING_PERSPECTIVE:\s*(\w+)/i,
  );
  const rawPerspective = perspectiveMatch?.[1]?.toLowerCase() ?? "neutral";
  const prevailing =
    rawPerspective === "bullish" || rawPerspective === "bearish"
      ? rawPerspective
      : "neutral";

  const confidenceMatch = result.output.match(/CONFIDENCE:\s*([\d.]+)/i);
  const confidence = confidenceMatch
    ? Math.min(1, Math.max(0, parseFloat(confidenceMatch[1])))
    : 0.5;

  const rationaleMatch = result.output.match(
    /RATIONALE:\s*(.+?)(?:\nKEY_BULL|$)/s,
  );
  const rationale = rationaleMatch?.[1]?.trim() ?? result.output.slice(0, 500);

  const bullArgsMatch = result.output.match(
    /KEY_BULL_ARGUMENTS:\s*\n((?:[-*]\s+.+\n?)+)/i,
  );
  const keyBullArgs = bullArgsMatch
    ? bullArgsMatch[1].split("\n").map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean)
    : [];

  const bearArgsMatch = result.output.match(
    /KEY_BEAR_ARGUMENTS:\s*\n((?:[-*]\s+.+\n?)+)/i,
  );
  const keyBearArgs = bearArgsMatch
    ? bearArgsMatch[1].split("\n").map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean)
    : [];

  return {
    prevailing_perspective: prevailing as "bullish" | "bearish" | "neutral",
    confidence,
    rationale,
    key_bull_arguments: keyBullArgs,
    key_bear_arguments: keyBearArgs,
    bull_history: bullHistory,
    bear_history: bearHistory,
    rounds_completed: bullHistory.length,
  };
}

/**
 * Format debate history into a readable transcript for the judge.
 */
function formatDebateTranscript(
  bullHistory: DebateArgument[],
  bearHistory: DebateArgument[],
): string {
  const lines: string[] = [];
  const maxRound = Math.max(bullHistory.length, bearHistory.length);

  for (let i = 0; i < maxRound; i++) {
    lines.push(`### Round ${i + 1}\n`);
    if (bullHistory[i]) {
      lines.push(`**Bull Researcher:**`);
      lines.push(bullHistory[i].argument);
      lines.push("");
    }
    if (bearHistory[i]) {
      lines.push(`**Bear Researcher:**`);
      lines.push(bearHistory[i].argument);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── Stage 3: Trader Agent ─────────────────────────────────────

/**
 * Run the trader agent: synthesizes analyst reports + debate result into a trade decision.
 */
export async function runTraderDecision(
  fundName: string,
  reports: AnalystReport[],
  debateResult: InvestmentDebateResult,
  config: DebatePipelineConfig,
  options?: { model?: string; tradeMemory?: string },
): Promise<TraderDecision> {
  const analysisContext = formatAnalystReportsForPrompt(reports);
  const tradeMemory = options?.tradeMemory ?? "";

  const prompt = [
    `You are the TRADER AGENT for fund '${fundName}'.`,
    ``,
    `Your job is to synthesize the analyst reports and investment debate results`,
    `into a concrete trading decision. You must decide: BUY, SELL, or HOLD.`,
    ``,
    analysisContext,
    ``,
    `## Investment Debate Result`,
    `Prevailing Perspective: **${debateResult.prevailing_perspective}** (confidence: ${(debateResult.confidence * 100).toFixed(0)}%)`,
    `Rationale: ${debateResult.rationale}`,
    ``,
    `Strongest bull arguments:`,
    ...debateResult.key_bull_arguments.map((a) => `- ${a}`),
    ``,
    `Strongest bear arguments:`,
    ...debateResult.key_bear_arguments.map((a) => `- ${a}`),
    ``,
    tradeMemory ? `## Historical Trade Lessons\n${tradeMemory}\n` : "",
    `## Instructions`,
    `1. Read the fund's portfolio.json and objective_tracker.json for current state`,
    `2. Consider the debate's prevailing perspective and ALL analyst signals`,
    `3. Determine which symbols to act on from the fund's universe`,
    `4. Size the position appropriately for the conviction level`,
    `5. Do NOT execute trades — only propose them`,
    ``,
    `## Required Output Format (strict — follow exactly)`,
    `FINAL_ACTION: BUY | SELL | HOLD`,
    `SYMBOLS: AAPL, MSFT (comma-separated, or "none" for HOLD)`,
    `CONVICTION: 0.0 to 1.0`,
    `POSITION_SIZE_PCT: 0 to 100 (percentage of available capital)`,
    `REASONING: detailed explanation`,
  ].join("\n");

  const timeout = config.trader_timeout_minutes * 60 * 1000;
  const result = await runAgentQuery({
    fundName,
    prompt,
    model: options?.model,
    maxTurns: 15,
    timeoutMs: timeout,
    maxBudgetUsd: 2.0,
  });

  return parseTraderOutput(result.output);
}

/**
 * Parse the trader agent's structured output into a TraderDecision.
 */
function parseTraderOutput(output: string): TraderDecision {
  const actionMatch = output.match(/FINAL_ACTION:\s*(BUY|SELL|HOLD)/i);
  const action = (actionMatch?.[1]?.toUpperCase() ?? "HOLD") as "BUY" | "SELL" | "HOLD";

  const symbolsMatch = output.match(/SYMBOLS:\s*(.+)/i);
  const symbolsRaw = symbolsMatch?.[1]?.trim() ?? "";
  const symbols =
    symbolsRaw.toLowerCase() === "none" || symbolsRaw === ""
      ? []
      : symbolsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  const convictionMatch = output.match(/CONVICTION:\s*([\d.]+)/i);
  const conviction = convictionMatch
    ? Math.min(1, Math.max(0, parseFloat(convictionMatch[1])))
    : 0.5;

  const sizePctMatch = output.match(/POSITION_SIZE_PCT:\s*([\d.]+)/i);
  const positionSizePct = sizePctMatch
    ? Math.min(100, Math.max(0, parseFloat(sizePctMatch[1])))
    : undefined;

  const reasoningMatch = output.match(/REASONING:\s*(.+)/s);
  const reasoning = reasoningMatch?.[1]?.trim() ?? output.slice(0, 500);

  return {
    action,
    symbols,
    reasoning,
    conviction,
    position_size_pct: positionSizePct,
    raw_output: output,
  };
}

// ── Stage 4: Risk Management Debate ───────────────────────────

/**
 * Build prompt for a risk debater (aggressive, conservative, or neutral).
 */
function buildRiskDebaterPrompt(
  fundName: string,
  perspective: "aggressive" | "conservative" | "neutral",
  traderDecision: TraderDecision,
  reports: AnalystReport[],
  otherResponses: { perspective: string; argument: string }[],
  round: number,
  totalRounds: number,
): string {
  const perspectiveInstructions: Record<string, string> = {
    aggressive: [
      `Champion high-reward, high-risk opportunities.`,
      `Emphasize bold strategies and competitive advantages.`,
      `Argue for larger position sizes and higher conviction trades.`,
      `Challenge overly cautious viewpoints with data-driven rebuttals.`,
    ].join("\n"),
    conservative: [
      `Prioritize capital preservation and downside protection.`,
      `Highlight potential losses, tail risks, and adverse scenarios.`,
      `Argue for smaller position sizes, tighter stops, and hedging.`,
      `Challenge overly optimistic assumptions with risk data.`,
    ].join("\n"),
    neutral: [
      `Take a balanced, objective view weighing both upside and downside.`,
      `Focus on risk-adjusted returns and optimal position sizing.`,
      `Mediate between aggressive and conservative viewpoints.`,
      `Identify the rational middle ground with evidence.`,
    ].join("\n"),
  };

  const analysisContext = formatAnalystReportsForPrompt(reports);
  const otherArgs = otherResponses.length > 0
    ? otherResponses.map((o) => `**${o.perspective}:** ${o.argument}`).join("\n\n")
    : "No responses from other perspectives yet — you are presenting your opening position.";

  return [
    `You are the ${perspective.toUpperCase()} RISK ANALYST for fund '${fundName}'.`,
    `This is round ${round + 1} of ${totalRounds} in a risk management debate.`,
    ``,
    `## Your Perspective`,
    perspectiveInstructions[perspective],
    ``,
    `## Trader's Proposed Decision`,
    `Action: ${traderDecision.action}`,
    `Symbols: ${traderDecision.symbols.join(", ") || "none"}`,
    `Conviction: ${(traderDecision.conviction * 100).toFixed(0)}%`,
    `Position Size: ${traderDecision.position_size_pct ?? "unspecified"}%`,
    `Reasoning: ${traderDecision.reasoning}`,
    ``,
    `## Analyst Context`,
    analysisContext,
    ``,
    `## Other Perspectives' Arguments`,
    otherArgs,
    ``,
    `## Instructions`,
    `1. Evaluate the trader's decision from your ${perspective} risk perspective`,
    `2. Respond directly to points made by other risk analysts`,
    `3. Read the fund's risk constraints from portfolio.json and fund config`,
    `4. Propose specific risk adjustments if needed`,
    ``,
    `## Required Output Format`,
    `Provide your argument, then end with:`,
    `RISK_RECOMMENDATION: approve | adjust | reject`,
    `ADJUSTMENTS:`,
    `- adjustment 1 (if any)`,
    `- adjustment 2 (if any)`,
  ].join("\n");
}

/**
 * Run the 3-way risk management debate: aggressive, conservative, neutral perspectives.
 */
export async function runRiskDebate(
  fundName: string,
  traderDecision: TraderDecision,
  reports: AnalystReport[],
  config: DebatePipelineConfig,
  options?: { model?: string },
): Promise<RiskDebateResult> {
  const perspectives = ["aggressive", "conservative", "neutral"] as const;
  const histories: Record<string, DebateArgument[]> = {
    aggressive: [],
    conservative: [],
    neutral: [],
  };
  const timeout = config.risk_timeout_minutes * 60 * 1000;

  for (let round = 0; round < config.max_risk_debate_rounds; round++) {
    // All three perspectives argue in sequence (each sees previous responses from this round)
    for (const perspective of perspectives) {
      const otherResponses = perspectives
        .filter((p) => p !== perspective)
        .map((p) => {
          const hist = histories[p];
          const latest = hist.length > 0 ? hist[hist.length - 1] : undefined;
          return {
            perspective: p,
            argument: latest?.argument ?? "(no response yet)",
          };
        });

      const prompt = buildRiskDebaterPrompt(
        fundName, perspective, traderDecision, reports,
        otherResponses, round, config.max_risk_debate_rounds,
      );

      const result = await runAgentQuery({
        fundName,
        prompt,
        model: options?.model,
        maxTurns: 10,
        timeoutMs: timeout,
        maxBudgetUsd: 1.0,
      });

      const parsed = parseDebateOutput(result.output);
      histories[perspective].push({
        role: perspective,
        round: round + 1,
        argument: result.output,
        key_points: parsed.keyPoints,
        counterpoints: parsed.counterpoints,
      });
    }
  }

  // Risk judge evaluates the 3-way debate
  const judgeResult = await runRiskJudge(
    fundName, traderDecision, histories, options?.model,
  );

  return judgeResult;
}

/**
 * Risk management judge: reviews the 3-way debate and produces final risk assessment.
 */
async function runRiskJudge(
  fundName: string,
  traderDecision: TraderDecision,
  histories: Record<string, DebateArgument[]>,
  model?: string,
): Promise<RiskDebateResult> {
  const debateLines: string[] = [];
  const maxRound = Math.max(
    histories.aggressive.length,
    histories.conservative.length,
    histories.neutral.length,
  );

  for (let i = 0; i < maxRound; i++) {
    debateLines.push(`### Round ${i + 1}\n`);
    for (const p of ["aggressive", "conservative", "neutral"]) {
      if (histories[p][i]) {
        debateLines.push(`**${p.charAt(0).toUpperCase() + p.slice(1)} Analyst:**`);
        debateLines.push(histories[p][i].argument);
        debateLines.push("");
      }
    }
  }

  const prompt = [
    `You are the RISK MANAGEMENT JUDGE for fund '${fundName}'.`,
    ``,
    `You observed a 3-way risk debate (aggressive, conservative, neutral)`,
    `evaluating the trader's proposed decision:`,
    ``,
    `## Trader's Proposal`,
    `Action: ${traderDecision.action}`,
    `Symbols: ${traderDecision.symbols.join(", ") || "none"}`,
    `Conviction: ${(traderDecision.conviction * 100).toFixed(0)}%`,
    `Position Size: ${traderDecision.position_size_pct ?? "unspecified"}%`,
    ``,
    `## Risk Debate Transcript`,
    debateLines.join("\n"),
    ``,
    `## Instructions`,
    `1. Evaluate all three risk perspectives`,
    `2. Determine if the trade should be approved, adjusted, or rejected`,
    `3. If adjusting, specify concrete changes (position size, stops, etc.)`,
    `4. Read the fund's risk parameters to ensure compliance`,
    ``,
    `## Required Output Format (strict)`,
    `APPROVED: true | false`,
    `ADJUSTED_ACTION: BUY | SELL | HOLD`,
    `RISK_ADJUSTMENTS:`,
    `- adjustment 1`,
    `- adjustment 2`,
    `RATIONALE: explanation`,
    `AGGRESSIVE_SUMMARY: one-line summary`,
    `CONSERVATIVE_SUMMARY: one-line summary`,
    `NEUTRAL_SUMMARY: one-line summary`,
  ].join("\n");

  const result = await runAgentQuery({
    fundName,
    prompt,
    model,
    maxTurns: 5,
    timeoutMs: 3 * 60 * 1000,
    maxBudgetUsd: 1.0,
  });

  // Parse risk judge output
  const approvedMatch = result.output.match(/APPROVED:\s*(true|false)/i);
  const approved = approvedMatch?.[1]?.toLowerCase() === "true";

  const adjustedActionMatch = result.output.match(
    /ADJUSTED_ACTION:\s*(BUY|SELL|HOLD)/i,
  );
  const adjustedAction = (adjustedActionMatch?.[1]?.toUpperCase() ??
    traderDecision.action) as "BUY" | "SELL" | "HOLD";

  const adjustmentsMatch = result.output.match(
    /RISK_ADJUSTMENTS:\s*\n((?:[-*]\s+.+\n?)+)/i,
  );
  const adjustments = adjustmentsMatch
    ? adjustmentsMatch[1].split("\n").map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean)
    : [];

  const rationaleMatch = result.output.match(
    /RATIONALE:\s*(.+?)(?:\nAGGRESSIVE_SUMMARY|$)/s,
  );
  const rationale = rationaleMatch?.[1]?.trim() ?? "";

  const aggMatch = result.output.match(/AGGRESSIVE_SUMMARY:\s*(.+)/i);
  const consMatch = result.output.match(/CONSERVATIVE_SUMMARY:\s*(.+)/i);
  const neutMatch = result.output.match(/NEUTRAL_SUMMARY:\s*(.+)/i);

  return {
    approved,
    adjusted_action: adjustedAction,
    risk_adjustments: adjustments,
    rationale,
    aggressive_summary: aggMatch?.[1]?.trim() ?? "",
    conservative_summary: consMatch?.[1]?.trim() ?? "",
    neutral_summary: neutMatch?.[1]?.trim() ?? "",
    rounds_completed: maxRound,
  };
}

// ── Stage 5: Fund Manager ─────────────────────────────────────

/**
 * Run the fund manager agent: final approval with risk adjustments applied.
 */
export async function runFundManagerApproval(
  fundName: string,
  traderDecision: TraderDecision,
  riskResult: RiskDebateResult,
  debateResult: InvestmentDebateResult,
  config: DebatePipelineConfig,
  options?: { model?: string },
): Promise<FundManagerDecision> {
  const prompt = [
    `You are the FUND MANAGER for fund '${fundName}'.`,
    ``,
    `You are the final decision-maker. Review the entire analysis pipeline:`,
    ``,
    `## Investment Debate Result`,
    `Prevailing Perspective: ${debateResult.prevailing_perspective} (${(debateResult.confidence * 100).toFixed(0)}%)`,
    `Rationale: ${debateResult.rationale}`,
    ``,
    `## Trader's Proposed Decision`,
    `Action: ${traderDecision.action}`,
    `Symbols: ${traderDecision.symbols.join(", ") || "none"}`,
    `Conviction: ${(traderDecision.conviction * 100).toFixed(0)}%`,
    `Position Size: ${traderDecision.position_size_pct ?? "unspecified"}%`,
    `Reasoning: ${traderDecision.reasoning}`,
    ``,
    `## Risk Management Team Result`,
    `Approved: ${riskResult.approved}`,
    `Adjusted Action: ${riskResult.adjusted_action}`,
    `Risk Adjustments:`,
    ...riskResult.risk_adjustments.map((a) => `- ${a}`),
    `Rationale: ${riskResult.rationale}`,
    ``,
    `## Instructions`,
    `1. Read the fund's state files (portfolio.json, objective_tracker.json)`,
    `2. Review the fund's risk constraints and objective`,
    `3. Apply risk management adjustments to the trader's decision`,
    `4. Make the final call: approve and execute, adjust, or reject`,
    `5. If approved, execute trades via MCP broker-alpaca tools`,
    `6. Update state files, send Telegram notifications if available`,
    `7. Log all trades in state/trade_journal.sqlite`,
    ``,
    `## Required Output Format`,
    `FINAL_APPROVED: true | false`,
    `FINAL_ACTION: BUY | SELL | HOLD`,
    `FINAL_SYMBOLS: AAPL, MSFT (comma-separated or "none")`,
    `FINAL_POSITION_SIZE_PCT: 0 to 100`,
    `RISK_ADJUSTMENTS_APPLIED:`,
    `- adjustment 1`,
    `- adjustment 2`,
    `RATIONALE: detailed explanation`,
  ].join("\n");

  const timeout = config.manager_timeout_minutes * 60 * 1000;
  const result = await runAgentQuery({
    fundName,
    prompt,
    model: options?.model,
    maxTurns: 30,
    timeoutMs: timeout,
    maxBudgetUsd: 3.0,
  });

  return parseFundManagerOutput(result.output);
}

/**
 * Parse the fund manager's structured output.
 */
function parseFundManagerOutput(output: string): FundManagerDecision {
  const approvedMatch = output.match(/FINAL_APPROVED:\s*(true|false)/i);
  const approved = approvedMatch?.[1]?.toLowerCase() === "true";

  const actionMatch = output.match(/FINAL_ACTION:\s*(BUY|SELL|HOLD)/i);
  const action = (actionMatch?.[1]?.toUpperCase() ?? "HOLD") as "BUY" | "SELL" | "HOLD";

  const symbolsMatch = output.match(/FINAL_SYMBOLS:\s*(.+)/i);
  const symbolsRaw = symbolsMatch?.[1]?.trim() ?? "";
  const symbols =
    symbolsRaw.toLowerCase() === "none" || symbolsRaw === ""
      ? []
      : symbolsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  const sizePctMatch = output.match(/FINAL_POSITION_SIZE_PCT:\s*([\d.]+)/i);
  const positionSizePct = sizePctMatch
    ? Math.min(100, Math.max(0, parseFloat(sizePctMatch[1])))
    : undefined;

  const adjustmentsMatch = output.match(
    /RISK_ADJUSTMENTS_APPLIED:\s*\n((?:[-*]\s+.+\n?)+)/i,
  );
  const adjustments = adjustmentsMatch
    ? adjustmentsMatch[1].split("\n").map((l) => l.replace(/^[-*]\s+/, "").trim()).filter(Boolean)
    : [];

  const rationaleMatch = output.match(/RATIONALE:\s*(.+)/s);
  const rationale = rationaleMatch?.[1]?.trim() ?? output.slice(0, 500);

  return {
    approved,
    final_action: action,
    final_symbols: symbols,
    position_size_pct: positionSizePct,
    risk_adjustments_applied: adjustments,
    rationale,
    raw_output: output,
  };
}

// ── Full Pipeline ─────────────────────────────────────────────

/**
 * Run the complete TradingAgents 5-stage pipeline:
 *   1. Analyst Team (parallel)
 *   2. Investment Debate (bull vs bear)
 *   3. Trader Decision
 *   4. Risk Management Debate (3-way)
 *   5. Fund Manager Approval + Execution
 */
export async function runTradingAgentsPipeline(
  fundName: string,
  pipelineConfig?: Partial<DebatePipelineConfig>,
  options?: { model?: string; tradeMemory?: string },
): Promise<DebatePipelineResult> {
  const config = debatePipelineConfigSchema.parse(pipelineConfig ?? {});
  const startedAt = new Date().toISOString();
  const totalCost = 0;

  // ── Stage 1: Analyst Team ──
  const analysts = getDefaultSubAgents(fundName);
  const analystResults = await runSubAgents(fundName, analysts, {
    timeoutMinutes: config.analyst_timeout_minutes,
    model: options?.model,
  });
  const reports = parseAnalystReports(analystResults);

  // ── Stage 2: Investment Debate ──
  const debateResult = await runInvestmentDebate(
    fundName, reports, config, options,
  );

  // ── Stage 3: Trader Decision ──
  const traderDecision = await runTraderDecision(
    fundName, reports, debateResult, config, options,
  );

  // ── Stage 4: Risk Management Debate ──
  const riskResult = await runRiskDebate(
    fundName, traderDecision, reports, config, options,
  );

  // ── Stage 5: Fund Manager Approval ──
  const managerDecision = await runFundManagerApproval(
    fundName, traderDecision, riskResult, debateResult, config, options,
  );

  const result: DebatePipelineResult = {
    fund: fundName,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    analyst_reports: reports,
    investment_debate: debateResult,
    trader_decision: traderDecision,
    risk_debate: riskResult,
    fund_manager_decision: managerDecision,
    total_cost_usd: totalCost,
    pipeline_config: config,
  };

  return result;
}

/**
 * Format the full pipeline result as a markdown report.
 */
export function formatPipelineReport(result: DebatePipelineResult): string {
  const sections: string[] = [
    `# TradingAgents Pipeline Report`,
    ``,
    `Fund: **${result.fund}**`,
    `Started: ${result.started_at}`,
    `Ended: ${result.ended_at}`,
    ``,
    `---`,
    ``,
    `## Stage 1: Analyst Reports`,
    ``,
  ];

  for (const r of result.analyst_reports) {
    sections.push(
      `- **${r.analyst_name}**: ${r.signal} (${(r.confidence * 100).toFixed(0)}%) — ${r.summary.slice(0, 200)}`,
    );
  }

  sections.push("", "---", "");
  sections.push(`## Stage 2: Investment Debate`);
  sections.push(
    `Prevailing Perspective: **${result.investment_debate.prevailing_perspective}** (${(result.investment_debate.confidence * 100).toFixed(0)}%)`,
  );
  sections.push(`Rounds: ${result.investment_debate.rounds_completed}`);
  sections.push(`Rationale: ${result.investment_debate.rationale}`);
  sections.push("");
  sections.push("Strongest bull arguments:");
  for (const a of result.investment_debate.key_bull_arguments) {
    sections.push(`- ${a}`);
  }
  sections.push("");
  sections.push("Strongest bear arguments:");
  for (const a of result.investment_debate.key_bear_arguments) {
    sections.push(`- ${a}`);
  }

  sections.push("", "---", "");
  sections.push(`## Stage 3: Trader Decision`);
  sections.push(`Action: **${result.trader_decision.action}**`);
  sections.push(
    `Symbols: ${result.trader_decision.symbols.join(", ") || "none"}`,
  );
  sections.push(
    `Conviction: ${(result.trader_decision.conviction * 100).toFixed(0)}%`,
  );
  if (result.trader_decision.position_size_pct !== undefined) {
    sections.push(
      `Position Size: ${result.trader_decision.position_size_pct}%`,
    );
  }
  sections.push(`Reasoning: ${result.trader_decision.reasoning.slice(0, 500)}`);

  sections.push("", "---", "");
  sections.push(`## Stage 4: Risk Management Debate`);
  sections.push(`Approved: **${result.risk_debate.approved}**`);
  sections.push(`Adjusted Action: ${result.risk_debate.adjusted_action}`);
  sections.push(`Rounds: ${result.risk_debate.rounds_completed}`);
  sections.push(`Rationale: ${result.risk_debate.rationale}`);
  if (result.risk_debate.risk_adjustments.length > 0) {
    sections.push("Risk adjustments:");
    for (const a of result.risk_debate.risk_adjustments) {
      sections.push(`- ${a}`);
    }
  }
  sections.push("");
  sections.push(
    `- Aggressive view: ${result.risk_debate.aggressive_summary}`,
  );
  sections.push(
    `- Conservative view: ${result.risk_debate.conservative_summary}`,
  );
  sections.push(`- Neutral view: ${result.risk_debate.neutral_summary}`);

  sections.push("", "---", "");
  sections.push(`## Stage 5: Fund Manager Decision`);
  sections.push(`Approved: **${result.fund_manager_decision.approved}**`);
  sections.push(`Final Action: **${result.fund_manager_decision.final_action}**`);
  sections.push(
    `Symbols: ${result.fund_manager_decision.final_symbols.join(", ") || "none"}`,
  );
  if (result.fund_manager_decision.position_size_pct !== undefined) {
    sections.push(
      `Position Size: ${result.fund_manager_decision.position_size_pct}%`,
    );
  }
  sections.push(`Rationale: ${result.fund_manager_decision.rationale.slice(0, 500)}`);
  if (result.fund_manager_decision.risk_adjustments_applied.length > 0) {
    sections.push("Applied risk adjustments:");
    for (const a of result.fund_manager_decision.risk_adjustments_applied) {
      sections.push(`- ${a}`);
    }
  }

  sections.push("", "---", "");
  sections.push(`Pipeline config: ${JSON.stringify(result.pipeline_config)}`);

  return sections.join("\n");
}

/**
 * Save pipeline result to disk.
 */
export async function savePipelineResult(
  fundName: string,
  result: DebatePipelineResult,
  sessionType: string,
): Promise<string> {
  const paths = fundPaths(fundName);
  const date = new Date().toISOString().split("T")[0];
  const filename = `${date}_${sessionType}_debate_pipeline.md`;
  const filePath = join(paths.analysis, filename);

  const report = formatPipelineReport(result);
  await mkdir(paths.analysis, { recursive: true });
  await writeFile(filePath, report, "utf-8");

  // Also save raw JSON result
  const jsonPath = join(paths.analysis, `${date}_${sessionType}_debate_pipeline.json`);
  await writeFile(jsonPath, JSON.stringify(result, null, 2), "utf-8");

  return filePath;
}

// ── CLI Command ───────────────────────────────────────────────

export const debateCommand = new Command("debate").description(
  "Run TradingAgents debate pipeline (arXiv:2412.20138)",
);

debateCommand
  .command("run")
  .description(
    "Run the full 5-stage TradingAgents pipeline: analysts → debate → trader → risk → manager",
  )
  .argument("<fund>", "Fund name")
  .option("-r, --rounds <n>", "Max investment debate rounds", "2")
  .option("--risk-rounds <n>", "Max risk debate rounds", "2")
  .option("-m, --model <model>", "Claude model override")
  .action(
    async (
      fund: string,
      opts: { rounds?: string; riskRounds?: string; model?: string },
    ) => {
      const pipelineConfig: Partial<DebatePipelineConfig> = {
        max_debate_rounds: parseInt(opts.rounds ?? "2", 10),
        max_risk_debate_rounds: parseInt(opts.riskRounds ?? "2", 10),
      };

      const spinner = ora(
        `Running TradingAgents pipeline for '${fund}'...`,
      ).start();

      try {
        spinner.text = `Stage 1/5: Running analyst team for '${fund}'...`;
        const result = await runTradingAgentsPipeline(fund, pipelineConfig, {
          model: opts.model,
        });

        spinner.succeed(`TradingAgents pipeline complete for '${fund}'.`);
        console.log();

        // Print summary
        const fm = result.fund_manager_decision;
        const icon = fm.approved ? chalk.green("APPROVED") : chalk.red("REJECTED");
        console.log(`  Final Decision: ${icon}`);
        console.log(
          `  Action: ${chalk.bold(fm.final_action)} ${fm.final_symbols.join(", ") || "(none)"}`,
        );
        if (fm.position_size_pct !== undefined) {
          console.log(`  Position Size: ${fm.position_size_pct}%`);
        }
        console.log();

        // Pipeline stages summary
        const debate = result.investment_debate;
        console.log(
          chalk.dim(
            `  Analysts: ${result.analyst_reports.length} reports | ` +
              `Debate: ${debate.prevailing_perspective} (${debate.rounds_completed} rounds) | ` +
              `Risk: ${result.risk_debate.approved ? "approved" : "adjusted"} (${result.risk_debate.rounds_completed} rounds)`,
          ),
        );

        // Save report
        const reportPath = await savePipelineResult(fund, result, "manual");
        console.log(chalk.dim(`  Report saved: ${reportPath}`));
      } catch (err) {
        spinner.fail(`Pipeline failed: ${err}`);
      }
    },
  );

debateCommand
  .command("analysts")
  .description("Run only the analyst team (Stage 1)")
  .argument("<fund>", "Fund name")
  .option("-m, --model <model>", "Claude model override")
  .action(async (fund: string, opts: { model?: string }) => {
    const spinner = ora(`Running analyst team for '${fund}'...`).start();
    try {
      const analysts = getDefaultSubAgents(fund);
      const results = await runSubAgents(fund, analysts, { model: opts.model });
      const reports = parseAnalystReports(results);

      spinner.succeed(`Analyst team complete: ${reports.length} reports.`);
      console.log();

      for (const r of reports) {
        const signalColor =
          r.signal === "bullish"
            ? chalk.green
            : r.signal === "bearish"
              ? chalk.red
              : chalk.yellow;
        console.log(
          `  ${signalColor(r.signal.toUpperCase().padEnd(7))} ${r.analyst_name} (${(r.confidence * 100).toFixed(0)}%)`,
        );
      }
    } catch (err) {
      spinner.fail(`Analyst team failed: ${err}`);
    }
  });
