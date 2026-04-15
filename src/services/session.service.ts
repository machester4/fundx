import { writeFile } from "node:fs/promises";
import { loadFundConfig } from "./fund.service.js";
import { writeSessionLog, readActiveSession, writeActiveSession, readSessionHistory, writeSessionHistory } from "../state.js";
import { runAgentQuery, SESSION_EXPIRED_PATTERN } from "../agent.js";
import { buildAnalystAgents } from "../subagent.js";
import { DAEMON_NEEDS_RESTART } from "../paths.js";
import type { SessionLogV2, UniverseResolution } from "../types.js";
import { readCachedUniverse } from "./universe.service.js";

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_SESSION_TIMEOUT_MINUTES = 15;

function renderUniverseBlock(resolution: UniverseResolution | null): string {
  if (!resolution) return "";
  const source = resolution.source.kind === "preset"
    ? `preset:${resolution.source.preset}`
    : `filters`;
  const resolvedAt = new Date(resolution.resolved_at).toISOString();
  const warning = resolution.resolved_from !== "fmp"
    ? `\n  freshness_warning: resolved from ${resolution.resolved_from} (universe data may be outdated)`
    : ``;
  const excludedTickers = resolution.exclude_tickers_config.length > 0
    ? `\n  excluded_tickers: [${resolution.exclude_tickers_config.join(", ")}]`
    : ``;
  const excludedSectors = resolution.exclude_sectors_config.length > 0
    ? `\n  excluded_sectors: [${resolution.exclude_sectors_config.join(", ")}]`
    : ``;
  const alwaysIncluded = resolution.include_applied.length > 0
    ? `\n  always_included: [${resolution.include_applied.join(", ")}]`
    : ``;
  return `<fund_universe>
  count: ${resolution.count}
  source: ${source}
  resolved_from: ${resolution.resolved_from}
  resolved_at: ${resolvedAt}${excludedTickers}${excludedSectors}${alwaysIncluded}${warning}
</fund_universe>`;
}

/** Escape HTML entities for Telegram */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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
  options?: { focus?: string; useDebateSkills?: boolean; maxTurns?: number; maxDurationMinutes?: number },
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
  const displayName = escapeHtml(config.fund.display_name);
  await notifySession(
    `<b>${displayName}</b> — ${sessionType} started\n<i>${escapeHtml(focus)}</i>`,
  );

  const today = new Date().toISOString().split("T")[0];
  const agents = buildAnalystAgents(fundName);

  const universeResolution = await readCachedUniverse(fundName);
  const universeBlock = renderUniverseBlock(universeResolution);

  const prompt = [
    `You are running a ${sessionType} session for fund '${fundName}'.`,
    ``,
    `Focus: ${focus}`,
    ``,
    ...(universeBlock ? [universeBlock, ``] : []),
    ...(options?.useDebateSkills
      ? [
          `This session should prioritize thorough analysis. Before any trading decisions,`,
          `apply your Investment Debate and Risk Assessment skills from your CLAUDE.md.`,
          `Use your analyst sub-agents (via the Task tool) to gather data from multiple`,
          `perspectives before making decisions.`,
          ``,
        ]
      : []),
    `Follow your session-init rule to orient yourself, then proceed with your Session Protocol.`,
    `Write analysis to analysis/${today}_${sessionType}.md.`,
  ].join("\n");

  const model = config.claude.model || undefined;
  const effectiveMaxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
  const effectiveDuration = options?.maxDurationMinutes
    ?? sessionConfig?.max_duration_minutes
    ?? DEFAULT_SESSION_TIMEOUT_MINUTES;
  const timeout = effectiveDuration * 60 * 1000;

  const startedAt = new Date().toISOString();

  const activeSession = await readActiveSession(fundName).catch(() => null);

  let result;
  try {
    result = await runAgentQuery({
      fundName,
      prompt,
      model,
      maxTurns: effectiveMaxTurns,
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
        maxTurns: effectiveMaxTurns,
        timeoutMs: timeout,
        agents,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await notifySession(
      `\u274C <b>${displayName}</b> — ${sessionType} FAILED\n<i>${escapeHtml(errMsg.slice(0, 400))}</i>`,
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
  const statusEmoji = result.status === "success" ? "\u2705" : "\u274C";
  const tokensIn = log.tokens_in ?? 0;
  const tokensOut = log.tokens_out ?? 0;

  // Truncate and escape summary for Telegram (max 800 chars, strip markdown artifacts)
  const rawSummary = result.output
    .replace(/^#+\s+/gm, "")          // strip markdown headers
    .replace(/\*\*([^*]+)\*\*/g, "$1") // strip bold markers
    .replace(/`([^`]+)`/g, "$1")       // strip inline code
    .replace(/\n{3,}/g, "\n\n")        // collapse multiple newlines
    .trim();
  const summary = rawSummary.slice(0, 800);
  const truncated = rawSummary.length > 800;

  await notifySession(
    `${statusEmoji} <b>${displayName}</b> — ${sessionType} (${durationStr})\n` +
    `<i>${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out | ${log.num_turns} turns</i>\n\n` +
    (summary ? `${escapeHtml(summary)}${truncated ? "..." : ""}` : "No output"),
  );

  // Update per-session-type history for catch-up detection
  try {
    const history = await readSessionHistory(fundName);
    history[sessionType] = new Date().toISOString();
    await writeSessionHistory(fundName, history);
  } catch {
    // Non-critical -- catch-up will still work from session_log.json fallback
  }

  // Detect probable auth failure: error status with zero tokens/turns means the SDK
  // couldn't authenticate (expired CLAUDE_CODE_OAUTH_TOKEN). Signal supervisor to restart.
  if (
    result.status === "error" &&
    (log.tokens_in ?? 0) === 0 &&
    (log.tokens_out ?? 0) === 0 &&
    (log.num_turns ?? 0) === 0
  ) {
    try {
      await writeFile(DAEMON_NEEDS_RESTART, new Date().toISOString(), "utf-8");
      await notifySession(
        `\u26A0\uFE0F <b>[Daemon]</b> Session failed for <b>${displayName}</b> — probable token expiry.\nRestarting daemon to refresh auth...`,
      );
    } catch { /* best effort */ }
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
