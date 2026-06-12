import { writeFile } from "node:fs/promises";
import { loadFundConfig } from "./fund.service.js";
import { writeSessionLog, readActiveSession, writeActiveSession, readSessionHistory, writeSessionHistory, readVerdicts, writeVerdicts, writeQuotaBackoff } from "../state.js";
import { runAgentQuery, SESSION_EXPIRED_PATTERN, QUOTA_EXHAUSTED_PATTERN } from "../agent.js";
import { buildAnalystAgents } from "../subagent.js";
import { DAEMON_NEEDS_RESTART, fundPaths } from "../paths.js";
import type { Budget, FundConfig, GlobalConfig, SessionLogV2, UniverseResolution } from "../types.js";
import { resolveUniverse } from "./universe.service.js";
import { loadGlobalConfig } from "../config.js";
import { sessionModePrefix } from "./chat.service.js";
import { buildStateSnapshot } from "./snapshot.service.js";
import { VerdictTracker, filterFreshVerdicts } from "./verdict-tracker.js";
import { archiveHandoffIfExists } from "./handoff-archive.service.js";
import { HandoffTracker } from "./handoff-tracker.js";
import {
  appendSessionLogEntry,
  readTodaysSessionUsage,
  type DailyUsage,
} from "./session-history.service.js";
import { notifyDailyCapReached } from "./daily-cap.service.js";
import type { SDKMessage, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { HookOutput } from "./verdict-tracker.js";

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_SESSION_TIMEOUT_MINUTES = 15;
const WATCHDOG_HARD_MS = 20 * 60 * 1000; // 20 minutes

/** How long the daemon refrains from launching sessions after a quota error. */
export const QUOTA_BACKOFF_MS = 60 * 60 * 1000;

/** Pure: whether the backoff window from the last quota error is still open. */
export function isQuotaBackoffActive(lastErrorAtMs: number | null, nowMs: number): boolean {
  return lastErrorAtMs !== null && nowMs - lastErrorAtMs < QUOTA_BACKOFF_MS;
}

export interface WatchdogInput {
  now: number;
  startedAtMs: number;
  hardCeilingMs: number;
  queryActive: boolean;
}

export interface WatchdogResult {
  shouldKill: boolean;
  elapsedMs: number;
}

/** Pure: decide whether the wall-clock watchdog should kill the session.
 *  Backup mechanism for when SDK timeoutMs/AbortController fails to fire
 *  (e.g., MCP server in deadlock). */
export function evaluateWatchdog(input: WatchdogInput): WatchdogResult {
  const elapsedMs = input.now - input.startedAtMs;
  return {
    shouldKill: input.queryActive && elapsedMs > input.hardCeilingMs,
    elapsedMs,
  };
}

/** Hardcoded per-session-type defaults — last layer of the budget cascade
 *  before the global FALLBACK_DEFAULT. Conservative on the high side so a
 *  default-only deployment doesn't trip caps in normal operation. */
const DEFAULTS_BY_SESSION_TYPE: Record<string, Budget> = {
  pre_market: { maxTurns: 40, maxUsd: 30 },
  mid_session: { maxTurns: 25, maxUsd: 18 },
  post_market: { maxTurns: 60, maxUsd: 40 },
};

/** Used when the session_type is not present in DEFAULTS_BY_SESSION_TYPE
 *  (e.g. a custom session type). Generous middle-of-the-road. */
const FALLBACK_DEFAULT: Budget = { maxTurns: 50, maxUsd: 22 };

/** Default daily-per-fund USD cap, used when neither fund nor global config sets one. */
const DEFAULT_DAILY_CAP_USD = 90;

/** Resolve the daily-per-fund USD cap through a 3-level cascade.
 *  Most-specific override wins:
 *    1. fund.budget.dailyCapUsd
 *    2. global.budget.dailyCapUsd
 *    3. DEFAULT_DAILY_CAP_USD
 *  Pure function — no I/O. Tested in tests/budget.test.ts. */
export function resolveDailyCapUsd(
  fund: FundConfig,
  global: GlobalConfig,
): number {
  return (
    fund.budget?.dailyCapUsd ??
    global.budget?.dailyCapUsd ??
    DEFAULT_DAILY_CAP_USD
  );
}

/** Read today's session usage and compare to the cap.
 *  allowed = totalUsd < cap. Pure read — caller emits alerts and writes log. */
export async function checkDailyCap(
  fundName: string,
  cap: number,
): Promise<{ allowed: boolean; usage: DailyUsage }> {
  const usage = await readTodaysSessionUsage(fundName);
  return { allowed: usage.totalUsd < cap, usage };
}

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
      `This session has extra time budget for deeper analysis — gather multiple perspectives before any trade decisions.`,
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

/** Escape HTML entities (legacy: alert bodies were formatted as HTML;
 *  OS notifications strip tags downstream, so escaping is now defensive only). */
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

/** Finalized result of an autonomous run, surfaced to the eval harness via the
 *  `onComplete` option. Mirrors the fields the eval runner's RunChatTurnResult
 *  needs (tool history + output for the judge + cost/turn/token accounting). */
export interface AutonomousRunResult {
  output: string;
  toolHistory: Array<{ name: string; elapsed: number }>;
  costUsd: number;
  numTurns: number;
  tokensIn: number;
  tokensOut: number;
  sessionId: string;
  status: string;
}

/** Format a budget-kill alert for a session that the SDK hard-killed on a
 *  budget cap. Returns the message body — caller passes it to notifySession()
 *  which strips tags before handing it to the OS notification center. Pure
 *  function, tested in tests/budget.test.ts. */
export function buildBudgetAlert(input: BuildBudgetAlertInput): string {
  const safeName = escapeHtml(input.displayName);
  return [
    `🛑 <b>${safeName}</b> — ${input.sessionType} stopped at budget`,
    `Limit: ${input.budget.maxTurns} turns / $${input.budget.maxUsd}`,
    `Used: ${input.numTurns} turns / $${input.costUsd.toFixed(2)}`,
    `Reason: <code>${input.status}</code>`,
  ].join("\n");
}

/** Send a session notification via the OS desktop (best-effort, never throws) */
async function notifySession(message: string): Promise<void> {
  try {
    const { notifyGeneric } = await import("./notify.service.js");
    notifyGeneric("session", message.replace(/<[^>]+>/g, ""));
  } catch { /* best-effort */ }
}

/** Launch a Claude Code session for a fund */
export async function runFundSession(
  fundName: string,
  sessionType: string,
  options?: {
    focus?: string;
    useDebateSkills?: boolean;
    maxTurns?: number;
    maxDurationMinutes?: number;
    /** Override the default autonomous prompt builder. When provided, the
     *  caller is responsible for emitting the session-mode prefix and any
     *  state snapshot. Used by meta-reflection sessions which need a
     *  different prompt envelope (handoffs + journal + current memory). */
    promptBuilder?: (ctx: { today: string }) => string;
    /** Test-only override for the watchdog hard ceiling + poll interval.
     *  Production callers should never set this; the default 20min ceiling /
     *  30s poll applies. Tests inject small values to verify the watchdog
     *  wiring without waiting minutes. */
    _testOnly_watchdog?: { hardMs: number; pollMs?: number };
    /** Eval-only hook. Invoked once with the finalized run result after the
     *  session completes (not called on the daily-cap skip path or on a
     *  non-watchdog throw). The eval harness uses this to capture tool_history
     *  and output for the autonomous surface without changing the void return. */
    onComplete?: (result: AutonomousRunResult) => void;
  },
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

  // Phase 4: pre-session daily cap check. Skip BEFORE any side effects.
  const dailyCap = resolveDailyCapUsd(config, globalConfig);
  const capCheck = await checkDailyCap(fundName, dailyCap);
  if (!capCheck.allowed) {
    const skipNow = new Date().toISOString();
    const skipLog: SessionLogV2 = {
      fund: fundName,
      session_type: sessionType,
      started_at: skipNow,
      ended_at: skipNow,
      trades_executed: 0,
      summary: `Skipped: daily cap $${dailyCap} reached ($${capCheck.usage.totalUsd.toFixed(2)} used in ${capCheck.usage.sessionCount} sessions)`,
      cost_usd: 0,
      status: "skipped_daily_cap",
    };
    await writeSessionLog(fundName, skipLog);
    await appendSessionLogEntry(fundName, skipLog);
    await notifyDailyCapReached(fundName, dailyCap, capCheck.usage);
    return;
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

  // Archive previous handoff to state/handoffs/<ts>_<type>.md (no-op on first session).
  // Skip for meta_reflection: it writes to memory/*.md, not session-handoff.md, so archiving
  // would mislabel the previous trading session's handoff as a meta_reflection artifact.
  const archivedPath = sessionType === "meta_reflection"
    ? null
    : await archiveHandoffIfExists(fundName, sessionType);
  if (archivedPath) {
    console.log(`[handoff-archive] archived to ${archivedPath}`);
  }

  const stateSnapshot = await buildStateSnapshot(fundName);

  const prompt = options?.promptBuilder
    ? options.promptBuilder({ today })
    : buildAutonomousPrompt({
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

  // Seed the pre-trade gate with verdicts persisted from recent sessions
  // (24h TTL). Without this, executing a previously-validated trigger
  // requires re-running both validators inside the executing session —
  // impossible in a 10-turn news_reaction follow-up.
  const persistedVerdicts = await readVerdicts(fundName).catch(() => []);
  const verdictTracker = new VerdictTracker(
    filterFreshVerdicts(persistedVerdicts, Date.now()),
  );

  /** Wrap a single runAgentQuery call with a wall-clock watchdog.
   *  Both the initial call and the SESSION_EXPIRED retry use this helper so
   *  neither can run forever if the SDK timeoutMs/AbortController fails. */
  const watchdogHardMs = options?._testOnly_watchdog?.hardMs ?? WATCHDOG_HARD_MS;
  const watchdogPollMs = options?._testOnly_watchdog?.pollMs ?? 30_000;
  const runWithWatchdog = async (queryArgs: Parameters<typeof runAgentQuery>[0]) => {
    let queryActive = true;
    let watchdogFired = false;
    let watchdogTimer: ReturnType<typeof setInterval> | null = null;

    const watchdogPromise = new Promise<never>((_, reject) => {
      watchdogTimer = setInterval(() => {
        const r = evaluateWatchdog({
          now: Date.now(),
          startedAtMs,
          hardCeilingMs: watchdogHardMs,
          queryActive,
        });
        if (r.shouldKill) {
          watchdogFired = true;
          if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
          reject(new Error(`watchdog_killed after ${Math.round(r.elapsedMs / 1000)}s`));
        }
      }, watchdogPollMs);
    });

    try {
      return await Promise.race([
        runAgentQuery(queryArgs).finally(() => {
          queryActive = false;
          if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
        }),
        watchdogPromise,
      ]);
    } catch (err) {
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      if (watchdogFired) {
        // Re-throw with a sentinel so the outer catch can build the watchdog_killed result
        const wErr = new Error(err instanceof Error ? err.message : String(err));
        (wErr as { isWatchdog?: boolean }).isWatchdog = true;
        throw wErr;
      }
      throw err;
    }
  };

  let result;
  try {
    result = await runWithWatchdog({
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

    // If resumption failed (expired session), retry without resume — also watchdog-guarded
    if (
      result.status === "error" &&
      activeSession?.session_id &&
      result.error &&
      SESSION_EXPIRED_PATTERN.test(result.error)
    ) {
      console.warn(`[session] Session ${activeSession.session_id} expired, starting fresh`);
      result = await runWithWatchdog({
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
    if ((err as { isWatchdog?: boolean }).isWatchdog) {
      await notifySession(
        `❌ <b>${displayName}</b> — ${sessionType} <b>WATCHDOG KILLED</b>\n<i>${escapeHtml(errMsg)}</i>`,
      );
      result = {
        output: "",
        cost_usd: 0,
        duration_ms: Date.now() - startedAtMs,
        num_turns: 0,
        usage: {},
        session_id: "",
        status: "watchdog_killed" as const,
        error: errMsg,
        toolHistory: [],
        tokens_in: 0,
        tokens_out: 0,
      };
    } else {
      await notifySession(
        `❌ <b>${displayName}</b> — ${sessionType} FAILED\n<i>${escapeHtml(errMsg.slice(0, 400))}</i>`,
      );
      throw err;
    }
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
  await appendSessionLogEntry(fundName, log);

  // Persist verdicts (seeded + observed this session) for the next session's gate.
  try {
    await writeVerdicts(fundName, filterFreshVerdicts(verdictTracker.verdicts, Date.now()));
  } catch (err) {
    console.warn(
      `[verdict-gate] failed to persist verdicts for ${fundName}:`,
      err instanceof Error ? err.message : err,
    );
  }

  options?.onComplete?.({
    output: result.output,
    toolHistory: result.toolHistory ?? [],
    costUsd: result.cost_usd,
    numTurns: result.num_turns,
    tokensIn: log.tokens_in ?? 0,
    tokensOut: log.tokens_out ?? 0,
    sessionId: result.session_id,
    status: result.status,
  });

  // Notify session completion
  const duration = Math.round((new Date(log.ended_at!).getTime() - new Date(log.started_at).getTime()) / 1000);
  const durationStr = duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m ${duration % 60}s`;
  const statusEmoji = result.status === "success" ? "✅" : "❌";
  const tokensIn = log.tokens_in ?? 0;
  const tokensOut = log.tokens_out ?? 0;

  // Truncate and escape summary for the notification body (max 800 chars, strip markdown artifacts)
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

  const quotaKilled =
    result.status === "error" && QUOTA_EXHAUSTED_PATTERN.test(result.output ?? "");

  // Update per-session-type history for catch-up detection.
  // Quota-killed sessions are deliberately NOT stamped: the session did not
  // actually run, and the wake/recovery catch-up must be able to re-run it.
  if (!quotaKilled) {
    try {
      const history = await readSessionHistory(fundName);
      history[sessionType] = new Date().toISOString();
      await writeSessionHistory(fundName, history);
    } catch {
      // Non-critical -- catch-up will still work from session_log.json fallback
    }
  }

  if (quotaKilled) {
    try {
      await writeQuotaBackoff({ last_quota_error_at: new Date().toISOString() });
    } catch { /* best effort */ }
    await notifySession(
      `⏳ <b>${displayName}</b> — ${sessionType} blocked: Claude subscription usage exhausted. ` +
      `Daemon will pause session launches ~1h and catch up after the window resets.`,
    );
  }

  // Detect probable auth failure: error status with zero tokens/turns means the SDK
  // couldn't authenticate (expired CLAUDE_CODE_OAUTH_TOKEN). Signal supervisor to restart.
  // Quota exhaustion is excluded — restarting the daemon cannot refill the usage window.
  if (
    !quotaKilled &&
    result.status === "error" &&
    (log.tokens_in ?? 0) === 0 &&
    (log.tokens_out ?? 0) === 0 &&
    (log.num_turns ?? 0) === 0
  ) {
    try {
      await writeFile(DAEMON_NEEDS_RESTART, new Date().toISOString(), "utf-8");
      await notifySession(
        `⚠️ <b>[Daemon]</b> Session failed for <b>${displayName}</b> — probable token expiry.\nRestarting daemon to refresh auth...`,
      );
    } catch { /* best effort */ }
  }

  if (log.handoff_written === false && log.status === "success" && sessionType !== "meta_reflection") {
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
