import { loadFundConfig } from "./fund.service.js";
import { writeSessionLog, readActiveSession, writeActiveSession, readSessionHistory, writeSessionHistory } from "../state.js";
import { runAgentQuery, SESSION_EXPIRED_PATTERN } from "../agent.js";
import { buildAnalystAgents } from "../subagent.js";
import type { SessionLogV2 } from "../types.js";

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_SESSION_TIMEOUT_MINUTES = 15;

/** Send a Telegram notification (best-effort, never throws) */
async function notifySession(message: string): Promise<void> {
  try {
    const { sendTelegramNotification } = await import("./gateway.service.js");
    await sendTelegramNotification(message);
  } catch { /* best effort */ }
}

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

  // Notify session start
  const displayName = config.fund.display_name;
  await notifySession(
    `<b>${displayName}</b> — ${sessionType} started\n<i>${focus}</i>`,
  );

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

  const activeSession = await readActiveSession(fundName).catch(() => null);

  let result;
  try {
    result = await runAgentQuery({
      fundName,
      prompt,
      model,
      maxTurns: DEFAULT_MAX_TURNS,
      timeoutMs: timeout,
      agents,
      resumeSessionId: activeSession?.session_id,
    });

    // If resumption failed (expired session), retry without resume
    if (
      result.status === "error" &&
      activeSession?.session_id &&
      result.error &&
      SESSION_EXPIRED_PATTERN.test(result.error)
    ) {
      console.warn(`[session] Session ${activeSession.session_id} expired, starting fresh`);
      result = await runAgentQuery({
        fundName,
        prompt,
        model,
        maxTurns: DEFAULT_MAX_TURNS,
        timeoutMs: timeout,
        agents,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await notifySession(
      `<b>${displayName}</b> — ${sessionType} FAILED\n<i>${errMsg.slice(0, 200)}</i>`,
    );
    throw err;
  }

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

  // Notify session completion
  const duration = Math.round((new Date(log.ended_at!).getTime() - new Date(log.started_at).getTime()) / 1000);
  const durationStr = duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`;
  const statusIcon = result.status === "success" ? "OK" : "ERR";
  const summary = result.output.slice(0, 200).replace(/\n/g, " ").trim();

  await notifySession(
    `<b>${displayName}</b> — ${sessionType} ${statusIcon} (${durationStr})\n` +
    `Tokens: ${(log.tokens_in ?? 0).toLocaleString()} in / ${(log.tokens_out ?? 0).toLocaleString()} out | ${log.num_turns} turns\n` +
    (summary ? `<i>${summary}${result.output.length > 200 ? "..." : ""}</i>` : ""),
  );

  // Update per-session-type history for catch-up detection
  try {
    const history = await readSessionHistory(fundName);
    history[sessionType] = new Date().toISOString();
    await writeSessionHistory(fundName, history);
  } catch {
    // Non-critical -- catch-up will still work from session_log.json fallback
  }

  if (result.session_id && result.status === "success") {
    try {
      await writeActiveSession(fundName, {
        session_id: result.session_id,
        updated_at: new Date().toISOString(),
        source: "daemon",
      });
    } catch (err) {
      console.error(
        `[session] Failed to persist active session for '${fundName}':`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}


function sumTokens(
  usage: Record<string, { inputTokens: number; outputTokens: number }>,
  field: "inputTokens" | "outputTokens",
): number {
  return Object.values(usage).reduce((sum, u) => sum + u[field], 0);
}
