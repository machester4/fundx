import { loadFundConfig } from "./fund.service.js";
import { writeSessionLog } from "../state.js";
import { runAgentQuery } from "../agent.js";
import { buildAnalystAgents } from "../subagent.js";
import type { SessionLogV2 } from "../types.js";

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_SESSION_TIMEOUT_MINUTES = 15;

/** Launch a Claude Code session for a fund */
export async function runFundSession(
  fundName: string,
  sessionType: string,
  options?: { focus?: string; useDebateSkills?: boolean },
): Promise<void> {
  const config = await loadFundConfig(fundName);

  const sessionConfig = config.schedule.sessions[sessionType];
  const focus = options?.focus ?? sessionConfig?.focus;
  if (!focus) {
    throw new Error(
      `Session type '${sessionType}' not found in fund '${fundName}'`,
    );
  }

  const today = new Date().toISOString().split("T")[0];
  const agents = buildAnalystAgents(fundName);

  const prompt = [
    `You are running a ${sessionType} session for fund '${fundName}'.`,
    ``,
    `Focus: ${focus}`,
    ``,
    ...(options?.useDebateSkills
      ? [
          `This session should prioritize thorough analysis. Before any trading decisions,`,
          `apply your Investment Debate and Risk Assessment skills from your CLAUDE.md.`,
          `Use your analyst sub-agents (via the Task tool) to gather data from multiple`,
          `perspectives before making decisions.`,
          ``,
        ]
      : []),
    `Start by reading your state files, then proceed with analysis`,
    `and actions as appropriate. Remember to:`,
    `1. Update state files after any changes`,
    `2. Write analysis to analysis/${today}_${sessionType}.md`,
    `3. Use MCP broker-alpaca tools for trading and position management`,
    `4. Use MCP market-data tools for price data and market analysis`,
    `5. Use MCP telegram-notify tools to send trade alerts, digests, and notifications (if available)`,
    `6. Update objective_tracker.json`,
    `7. Log all trades in state/trade_journal.sqlite`,
  ].join("\n");

  const model = config.claude.model || undefined;
  const timeout = (sessionConfig?.max_duration_minutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES) * 60 * 1000;

  const startedAt = new Date().toISOString();

  const result = await runAgentQuery({
    fundName,
    prompt,
    model,
    maxTurns: DEFAULT_MAX_TURNS,
    timeoutMs: timeout,
    agents,
  });

  const log: SessionLogV2 = {
    fund: fundName,
    session_type: sessionType,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    trades_executed: 0,
    summary: result.output.slice(0, 500),
    cost_usd: result.cost_usd,
    tokens_in: sumTokens(result.usage, "inputTokens"),
    tokens_out: sumTokens(result.usage, "outputTokens"),
    model_used: Object.keys(result.usage)[0],
    num_turns: result.num_turns,
    session_id: result.session_id,
    status: result.status,
  };

  await writeSessionLog(fundName, log);
}


function sumTokens(
  usage: Record<string, { inputTokens: number; outputTokens: number }>,
  field: "inputTokens" | "outputTokens",
): number {
  return Object.values(usage).reduce((sum, u) => sum + u[field], 0);
}
