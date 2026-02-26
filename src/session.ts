import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { loadFundConfig } from "./fund.js";
import { writeSessionLog } from "./state.js";
import { runAgentQuery } from "./agent.js";
import {
  runSubAgents,
  getDefaultSubAgents,
  mergeSubAgentResults,
  saveSubAgentAnalysis,
  buildAnalystAgents,
} from "./subagent.js";
import type { SessionLogV2 } from "./types.js";

/** Default max turns per session query */
const DEFAULT_MAX_TURNS = 50;
/** Default session timeout in minutes when not configured */
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

/**
 * Launch a fund session with parallel sub-agents for analysis.
 *
 * Sub-agents (macro, technical, sentiment, risk) run in parallel first,
 * then a main session incorporates their combined analysis.
 */
export async function runFundSessionWithSubAgents(
  fundName: string,
  sessionType: string,
): Promise<void> {
  const config = await loadFundConfig(fundName);

  const sessionConfig = config.schedule.sessions[sessionType];
  if (!sessionConfig) {
    throw new Error(
      `Session type '${sessionType}' not found in fund '${fundName}'`,
    );
  }

  const today = new Date().toISOString().split("T")[0];
  const startedAt = new Date().toISOString();

  // Run sub-agents in parallel via Agent SDK
  const agents = getDefaultSubAgents(fundName);
  const results = await runSubAgents(fundName, agents, {
    timeoutMinutes: 8,
    model: config.claude.model || undefined,
  });

  // Save sub-agent analysis
  const analysisPath = await saveSubAgentAnalysis(fundName, results, sessionType);
  const combinedAnalysis = mergeSubAgentResults(results);

  // Phase 2: Run main decision-making session with sub-agent context (via SDK)
  const prompt = [
    `You are running a ${sessionType} session for fund '${fundName}'.`,
    ``,
    `Focus: ${sessionConfig.focus}`,
    ``,
    `## Sub-Agent Analysis`,
    `Your analysis team has completed their research. Here is their combined output:`,
    ``,
    combinedAnalysis.slice(0, 8000),
    ``,
    `## Your Task`,
    `Review the sub-agent analysis above and make trading decisions.`,
    `Start by reading your state files, then:`,
    `1. Synthesize the macro, technical, sentiment, and risk analysis`,
    `2. Decide on trades that align with all signals and fund constraints`,
    `3. Execute trades via MCP broker-alpaca tools`,
    `4. Update state files after any changes`,
    `5. Write your synthesis to analysis/${today}_${sessionType}.md`,
    `6. Use MCP telegram-notify tools to send alerts (if available)`,
    `7. Update objective_tracker.json`,
    `8. Log all trades in state/trade_journal.sqlite`,
  ].join("\n");

  const model = config.claude.model || undefined;
  const timeout = (sessionConfig.max_duration_minutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES) * 60 * 1000;

  const result = await runAgentQuery({
    fundName,
    prompt,
    model,
    maxTurns: DEFAULT_MAX_TURNS,
    timeoutMs: timeout,
  });

  const successCount = results.filter((r) => r.status === "success").length;

  const log: SessionLogV2 = {
    fund: fundName,
    session_type: `${sessionType}_parallel`,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    trades_executed: 0,
    analysis_file: analysisPath,
    summary: `Sub-agents: ${successCount}/${results.length} OK. ${result.output.slice(0, 300)}`,
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

/** Sum a token field across all models in usage */
function sumTokens(
  usage: Record<string, { inputTokens: number; outputTokens: number }>,
  field: "inputTokens" | "outputTokens",
): number {
  return Object.values(usage).reduce((sum, u) => sum + u[field], 0);
}

// ── CLI Commands ───────────────────────────────────────────────

export const sessionCommand = new Command("session").description(
  "Manage Claude Code sessions",
);

sessionCommand
  .command("run")
  .description("Manually trigger a session")
  .argument("<fund>", "Fund name")
  .argument("<type>", "Session type (pre_market, mid_session, post_market)")
  .option("-p, --parallel", "Use sub-agent parallel analysis (forced pre-gathering)")
  .option("-d, --debate", "Prioritize thorough analysis using debate and risk skills")
  .action(async (fund: string, type: string, opts: {
    parallel?: boolean;
    debate?: boolean;
  }) => {
    const useParallel = opts.parallel ?? false;
    const useDebate = opts.debate ?? false;
    const mode = useParallel ? "parallel" : useDebate ? "debate" : "standard";
    const spinner = ora(
      `Running ${type} session for '${fund}' (${mode})...`,
    ).start();
    try {
      if (useParallel) {
        spinner.text = `Running sub-agent analysis for '${fund}'...`;
        await runFundSessionWithSubAgents(fund, type);
        spinner.succeed(
          `Parallel session complete for '${fund}'.`,
        );
      } else {
        await runFundSession(fund, type, { useDebateSkills: useDebate });
        spinner.succeed(`Session complete for '${fund}'.`);
      }
    } catch (err) {
      spinner.fail(`Session failed: ${err}`);
    }
  });

sessionCommand
  .command("agents")
  .description("Run only the sub-agent analysis (no trading)")
  .argument("<fund>", "Fund name")
  .option("-m, --model <model>", "Claude model (sonnet, opus, haiku, or full model ID)")
  .action(async (fund: string, opts: { model?: string }) => {
    const spinner = ora(
      `Running sub-agent analysis for '${fund}'...`,
    ).start();
    try {
      const agents = getDefaultSubAgents(fund);
      spinner.text = `Launching ${agents.length} sub-agents in parallel...`;

      const results = await runSubAgents(fund, agents, {
        model: opts.model,
      });

      const analysisPath = await saveSubAgentAnalysis(fund, results, "manual");

      const successCount = results.filter((r) => r.status === "success").length;
      const errorCount = results.filter((r) => r.status === "error").length;
      const timeoutCount = results.filter((r) => r.status === "timeout").length;

      spinner.succeed(`Sub-agent analysis complete.`);
      console.log();

      for (const r of results) {
        const icon =
          r.status === "success"
            ? chalk.green("OK")
            : r.status === "timeout"
              ? chalk.yellow("TIMEOUT")
              : chalk.red("ERR");
        const started = new Date(r.started_at).getTime();
        const ended = new Date(r.ended_at).getTime();
        const dur = ((ended - started) / 1000).toFixed(0);
        console.log(`  ${icon}  ${r.name} (${dur}s)`);
      }

      console.log();
      console.log(
        chalk.dim(
          `  ${successCount} succeeded, ${errorCount} errors, ${timeoutCount} timeouts`,
        ),
      );
      console.log(chalk.dim(`  Analysis saved: ${analysisPath}`));
    } catch (err) {
      spinner.fail(`Sub-agent analysis failed: ${err}`);
    }
  });
