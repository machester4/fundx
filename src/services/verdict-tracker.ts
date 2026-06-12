import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export interface Verdict {
  ticker: string;
  side: "buy" | "sell";
  source: "trade-evaluator" | "risk-guardian";
  recommendation: "PROCEED" | "RECONSIDER" | "REJECT" | "APPROVED" | "REJECTED";
  approved: boolean;
  observedAt: number;
}

export interface HookOutput {
  decision: "approve" | "block";
  /** Surfaced to the human operator (SDK does NOT relay this to the agent). */
  systemMessage?: string;
  /** Legacy model-facing denial reason — the SDK relays this back to the agent. */
  reason?: string;
  /** Canonical PreToolUse deny payload. `permissionDecisionReason` is the text
   *  the agent reads to learn how to satisfy the gate. */
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

const APPROVED_VALUES = new Set(["PROCEED", "APPROVED"]);

/** Verdicts persist across sessions for this long. Long enough to bridge a
 *  post_market approval to the next pre_market execution; short enough that a
 *  materially-moved market forces re-validation. */
export const VERDICT_TTL_MS = 24 * 60 * 60 * 1000;

/** Pure: drop verdicts whose observedAt is outside the TTL window. */
export function filterFreshVerdicts(verdicts: Verdict[], nowMs: number): Verdict[] {
  return verdicts.filter((v) => nowMs - v.observedAt <= VERDICT_TTL_MS);
}

/** Build a PreToolUse deny that reaches BOTH the operator (systemMessage) and
 *  the agent (reason + permissionDecisionReason). Putting the actionable text
 *  only in systemMessage hid it from the model and deadlocked exit queues. */
function denyPlaceOrder(message: string): HookOutput {
  return {
    decision: "block",
    systemMessage: message,
    reason: message,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message,
    },
  };
}

const TRADE_EVAL_RE = /<trade_evaluation>([\s\S]*?)<\/trade_evaluation>/g;
const RISK_VAL_RE = /<risk_validation>([\s\S]*?)<\/risk_validation>/g;

const TICKER_RE = /^[ \t]*TICKER:\s*([A-Z][A-Z0-9.-]*)\s*$/m;
const SIDE_RE = /^[ \t]*SIDE:\s*(buy|sell)\s*$/m;
// Accept trailing qualifiers after the keyword ("APPROVED (with warnings)",
// "PROCEED — half size"). Anchoring with \s*$ silently discarded legitimate
// verdicts and produced unexplained denials with both validators run.
const RECOMMENDATION_RE = /^[ \t]*RECOMMENDATION:\s*(PROCEED|RECONSIDER|REJECT)\b/m;
const VERDICT_RE = /^[ \t]*VERDICT:\s*(APPROVED|REJECTED)\b/m;

export class VerdictTracker {
  /** Public for test introspection only — do not use externally. */
  _verdicts: Verdict[] = [];

  /** `initialVerdicts` seeds the gate with verdicts persisted from recent
   *  sessions (caller applies the TTL filter), so a previously-validated
   *  trade can execute without re-running both validators in-session. */
  constructor(initialVerdicts: Verdict[] = []) {
    this._verdicts = [...initialVerdicts];
  }

  /** All seeded + observed verdicts, for persistence at session end. */
  get verdicts(): Verdict[] {
    return [...this._verdicts];
  }

  observe(message: SDKMessage): void {
    // Verdicts arrive as <trade_evaluation> / <risk_validation> XML blocks
    // inside tool_result content. Per SDK types, tool_result blocks live on
    // user-typed messages (SDKUserMessage carrying MessageParam content).
    // Assistant messages carry text + tool_use blocks but not tool_result.
    // We accept both types defensively in case the SDK ever changes shape.
    if (message.type !== "user" && message.type !== "assistant") return;
    const content = (message as { message?: { content?: unknown[] } }).message?.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: string; content?: unknown };
      if (b.type !== "tool_result") continue;

      // tool_result.content can be string or an array of {type:'text', text:string} blocks
      const text = this.extractText(b.content);
      if (!text) continue;

      this.parseEvaluations(text);
      this.parseValidations(text);
    }
  }

  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c && typeof c === "object" && (c as { text?: string }).text) || "")
        .join("\n");
    }
    return "";
  }

  private parseEvaluations(text: string): void {
    for (const match of text.matchAll(TRADE_EVAL_RE)) {
      const inner = match[1];
      const ticker = inner.match(TICKER_RE)?.[1];
      const side = inner.match(SIDE_RE)?.[1] as "buy" | "sell" | undefined;
      const rec = inner.match(RECOMMENDATION_RE)?.[1] as
        | "PROCEED" | "RECONSIDER" | "REJECT" | undefined;

      if (!ticker || !side || !rec) {
        console.warn(`[verdict-tracker] malformed <trade_evaluation> — missing TICKER/SIDE/RECOMMENDATION`);
        continue;
      }

      this._verdicts.push({
        ticker,
        side,
        source: "trade-evaluator",
        recommendation: rec,
        approved: APPROVED_VALUES.has(rec),
        observedAt: Date.now(),
      });
    }
  }

  private parseValidations(text: string): void {
    for (const match of text.matchAll(RISK_VAL_RE)) {
      const inner = match[1];
      const ticker = inner.match(TICKER_RE)?.[1];
      const side = inner.match(SIDE_RE)?.[1] as "buy" | "sell" | undefined;
      const verdict = inner.match(VERDICT_RE)?.[1] as
        | "APPROVED" | "REJECTED" | undefined;

      if (!ticker || !side || !verdict) {
        console.warn(`[verdict-tracker] malformed <risk_validation> — missing TICKER/SIDE/VERDICT`);
        continue;
      }

      this._verdicts.push({
        ticker,
        side,
        source: "risk-guardian",
        recommendation: verdict,
        approved: APPROVED_VALUES.has(verdict),
        observedAt: Date.now(),
      });
    }
  }

  private mostRecent(
    source: Verdict["source"],
    ticker: string,
    side: "buy" | "sell",
  ): Verdict | undefined {
    for (let i = this._verdicts.length - 1; i >= 0; i--) {
      const v = this._verdicts[i];
      if (v.source === source && v.ticker === ticker && v.side === side) return v;
    }
    return undefined;
  }

  checkPlaceOrder(input: { symbol: string; side: "buy" | "sell" }): HookOutput {
    const { symbol, side } = input;
    const evaluator = this.mostRecent("trade-evaluator", symbol, side);
    const guardian = this.mostRecent("risk-guardian", symbol, side);

    if (side === "buy") {
      if (evaluator?.approved && guardian?.approved) {
        return { decision: "approve" };
      }
      const evalStatus = evaluator?.recommendation ?? "none found";
      const guardStatus = guardian?.recommendation ?? "none found";
      return denyPlaceOrder(
        `place_order denied: BUY ${symbol} requires both trade-evaluator PROCEED and risk-guardian APPROVED for (${symbol}, buy). ` +
          `Found: trade-evaluator=${evalStatus}, risk-guardian=${guardStatus}. ` +
          `Required: invoke trade-evaluator (Task tool) and risk-guardian for this trade before retrying. ` +
          `Verdicts persist 24h, so approvals from a recent prior session also count.`,
      );
    }

    if (side === "sell") {
      if (guardian?.approved) {
        return { decision: "approve" };
      }
      const guardStatus = guardian?.recommendation ?? "none found";
      return denyPlaceOrder(
        `place_order denied: SELL ${symbol} requires risk-guardian APPROVED for (${symbol}, sell). ` +
          `Found: risk-guardian=${guardStatus}. ` +
          `Required: invoke risk-guardian (Task tool) for this trade before retrying. ` +
          `Verdicts persist 24h, so approvals from a recent prior session also count.`,
      );
    }

    console.warn(`[verdict-tracker] unknown side '${side}' for ${symbol} — allowing place_order`);
    return { decision: "approve" };
  }
}
