import { writeFile } from "node:fs/promises";
import { loadFundConfig } from "./fund.service.js";
import { writeSessionLog, readActiveSession, writeActiveSession, readSessionHistory, writeSessionHistory } from "../state.js";
import { runAgentQuery, SESSION_EXPIRED_PATTERN } from "../agent.js";
import { buildAnalystAgents } from "../subagent.js";
import { DAEMON_NEEDS_RESTART, fundPaths } from "../paths.js";
import type { Budget, FundConfig, GlobalConfig, SessionLogV2, UniverseResolution } from "../types.js";
import { resolveUniverse } from "./universe.service.js";
import { loadGlobalConfig } from "../config.js";
import { sessionModePrefix } from "./chat.service.js";
import { buildStateSnapshot } from "./snapshot.service.js";
import { VerdictTracker } from "./verdict-tracker.js";
import { archiveHandoffIfExists } from "./handoff-archive.service.js";
import { HandoffTracker } from "./handoff-tracker.js";
import type { SDKMessage, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { HookOutput } from "./verdict-tracker.js";

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_SESSION_TIMEOUT_MINUTES = 15;

/** Hardcoded per-session-type defaults — last layer of the budget cascade
 *  before the global FALLBACK_DEFAULT. Conservative on the high side so a
 *  default-only deployment doesn't trip caps in normal operation. */
const DEFAULTS_BY_SESSION_TYPE: Record<string, Budget> = {
  pre_market: { maxTurns: 40, maxUsd: 5 },
  mid_session: { maxTurns: 25, maxUsd: 3 },
  post_market: { maxTurns: 60, maxUsd: 7 },
};

/** Used when the session_type is not present in DEFAULTS_BY_SESSION_TYPE
 *  (e.g. a custom session type). Generous middle-of-the-road. */
const FALLBACK_DEFAULT: Budget = { maxTurns: 50, maxUsd: 5 };

/** Build the tracker-attached hook + onMessage options shared by both
 *  runAgentQuery invocations (initial call + retry-on-SESSION_EXPIRED).
 *  Extracted to avoid drift between the two call sites. */
function buildTrackerHookOptions(
  verdictTracker: VerdictTracker,
  handoffTracker?: HandoffTracker,
) {
  return {
    onMessage: (msg: SDKMessage) => verdictTracker.observe(msg),
    hooks: {
      PreToolUse: [
        {
          matcher: "mcp__broker-local__place_order",
          hooks: [
            async (input: HookInput) => {
              const ti = (input as { tool_input?: { symbol?: string; side?: "buy" | "sell" } }).tool_input;
              if (!ti?.symbol || !ti.side) {
                return { decision: "approve" } satisfies HookOutput;
              }
              return verdictTracker.checkPlaceOrder({ symbol: ti.symbol, side: ti.side });
            },
          ],
        },
      ],
      ...(handoffTracker
        ? {
            Stop: [
              {
                hooks: [
                  async () => {
                    const { written } = handoffTracker.checkOnStop();
                    if (!written) {
                      console.warn(
                        `[stop-hook] handoff not written this session — flagged in session_log`,
                      );
                    }
                    return {};
                  },
                ],
              },
            ],
          }
        : {}),
    },
  };
}

/** Resolve the budget for a session through a 6-level cascade.
 *  Most-specific override wins:
 *    1. fund.budget.perSessionType[sessionType]
 *    2. fund.budget.default
 *    3. global.budget.perSessionType[sessionType]
 *    4. global.budget.default
 *    5. DEFAULTS_BY_SESSION_TYPE[sessionType]
 *    6. FALLBACK_DEFAULT
 *  Pure function — no I/O. Tested in tests/budget.test.ts. */
export function resolveBudget(
  fund: FundConfig,
  global: GlobalConfig,
  sessionType: string,
): Budget {
  return (
    fund.budget?.perSessionType?.[sessionType] ??
    fund.budget?.default ??
    global.budget?.perSessionType?.[sessionType] ??
    global.budget?.default ??
    DEFAULTS_BY_SESSION_TYPE[sessionType] ??
    FALLBACK_DEFAULT
  );
}

export interface BuildAutonomousPromptInput {
  fundName: string;
  sessionType: string;
  focus: string;
  universeBlock?: string | null;
  useDebateSkills?: boolean;
  today?: string;
  /** Optional pre-populated state snapshot (XML envelope). Inserted after
   *  the session-mode prefix and before the "You are running..." line. */
  stateSnapshot?: string;
}

/** Pure helper: builds the prompt for an autonomous scheduled session.
 *
 *  The prompt prefix tells the model it's in autonomous mode (so the
 *  session-init rule's `## Applies to` section directs it to follow the
 *  Orient sequence). Factored out from `runFundSession`'s inline array
 *  to make the prompt unit-testable.
 */
export function buildAutonomousPrompt(input: BuildAutonomousPromptInput): string {
  const today = input.today ?? new Date().toISOString().split("T")[0];
  const lines: string[] = [
    sessionModePrefix("autonomous-scheduled"),
    ``,
    ...(input.stateSnapshot ? [input.stateSnapshot, ``] : []),
    `You are running a ${input.sessionType} session for fund '${input.fundName}'.`,
    ``,
    `Focus: ${input.focus}`,
    ``,
  ];
  if (input.universeBlock) {
    lines.push(input.universeBlock, ``);
  }
  if (input.useDebateSkills) {
    lines.push(
      `This session should prioritize thorough analysis. Before any trading decisions,`,
      `apply your Investment Debate and Risk Assessment skills from your CLAUDE.md.`,
      `Use your analyst sub-agents (via the Task tool) to gather data from multiple`,
      `perspectives before making decisions.`,
      ``,
    );
  }
  lines.push(
    `Follow your session-init rule to orient yourself, then proceed with your Session Protocol.`,
    `Write analysis to analysis/${today}_${input.sessionType}.md.`,
  );
  return lines.join("\n");
}

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

export interface BuildBudgetAlertInput {
  displayName: string;
  sessionType: string;
  status: "error_max_budget" | "error_max_turns";
  budget: Budget;
  numTurns: number;
  costUsd: number;
}

/** Format a Telegram alert (HTML parse-mode) for a session that the SDK
 *  hard-killed on a budget cap. Returns the message body — caller passes
 *  it to notifySession(). Pure function, tested in tests/budget.test.ts. */
export function buildBudgetAlert(input: BuildBudgetAlertInput): string {
  const safeName = escapeHtml(input.displayName);
  return [
    `🛑 <b>${safeName}</b> — ${input.sessionType} stopped at budget`,
    `Limit: ${input.budget.maxTurns} turns / $${input.budget.maxUsd}`,
    `Used: ${input.numTurns} turns / $${input.costUsd.toFixed(2)}`,
    `Reason: <code>${input.status}</code>`,
  ].join("\n");
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
  const globalConfig = await loadGlobalConfig();

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

  let universeResolution: UniverseResolution | null = null;
  try {
    const gcfg = globalConfig;
    const apiKey = gcfg.market_data?.fmp_api_key ?? "";
    universeResolution = await resolveUniverse(fundName, config.universe, apiKey);
  } catch (err) {
    console.warn(`[session] universe resolution failed for ${fundName}:`, err instanceof Error ? err.message : err);
  }
  const universeBlock = renderUniverseBlock(universeResolution);

  // Archive previous handoff to state/handoffs/<ts>_<type>.md (no-op on first session)
  const archivedPath = await archiveHandoffIfExists(fundName, sessionType);
  if (archivedPath) {
    console.log(`[handoff-archive] archived to ${archivedPath}`);
  }

  const stateSnapshot = await buildStateSnapshot(fundName);

  const prompt = buildAutonomousPrompt({
    fundName,
    sessionType,
    focus,
    universeBlock,
    useDebateSkills: options?.useDebateSkills,
    today,
    stateSnapshot,
  });

  const model = config.claude.model || undefined;
  const budget = resolveBudget(config, globalConfig, sessionType);
  const effectiveMaxTurns = options?.maxTurns ?? budget.maxTurns;
  const effectiveMaxBudgetUsd = budget.maxUsd;
  const effectiveDuration = options?.maxDurationMinutes
    ?? sessionConfig?.max_duration_minutes
    ?? DEFAULT_SESSION_TIMEOUT_MINUTES;
  const timeout = effectiveDuration * 60 * 1000;

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.parse(startedAt);
  const paths = fundPaths(fundName);
  const handoffTracker = new HandoffTracker(paths.state.sessionHandoff, startedAtMs);

  const activeSession = await readActiveSession(fundName).catch(() => null);

  const verdictTracker = new VerdictTracker();

  let result;
  try {
    result = await runAgentQuery({
      fundName,
      prompt,
      model,
      maxTurns: effectiveMaxTurns,
      maxBudgetUsd: effectiveMaxBudgetUsd,
      timeoutMs: timeout,
      agents,
      resumeSessionId: activeSession?.session_id,
      ...buildTrackerHookOptions(verdictTracker, handoffTracker),
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
        maxBudgetUsd: effectiveMaxBudgetUsd,
        timeoutMs: timeout,
        agents,
        ...buildTrackerHookOptions(verdictTracker, handoffTracker),
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
    budget_resolved: budget,
    handoff_written: handoffTracker.handoffWritten,
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

  if (result.status === "error_max_budget" || result.status === "error_max_turns") {
    // buildBudgetAlert escapes the display name internally — pass raw, not the pre-escaped local
    await notifySession(
      buildBudgetAlert({
        displayName: config.fund.display_name,
        sessionType,
        status: result.status,
        budget,
        numTurns: log.num_turns ?? 0,
        costUsd: log.cost_usd ?? 0,
      }),
    );
  } else {
    await notifySession(
      `${statusEmoji} <b>${displayName}</b> — ${sessionType} (${durationStr})\n` +
      `<i>${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out | ${log.num_turns} turns</i>\n\n` +
      (summary ? `${escapeHtml(summary)}${truncated ? "..." : ""}` : "No output"),
    );
  }

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

  if (log.handoff_written === false && log.status === "success") {
    await notifySession(
      `⚠️ <b>${displayName}</b> — ${sessionType} ended successfully but did NOT write a handoff. Next session will read stale state.`,
    );
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
