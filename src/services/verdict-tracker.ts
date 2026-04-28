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
  systemMessage?: string;
}

const APPROVED_VALUES = new Set(["PROCEED", "APPROVED"]);

const TRADE_EVAL_RE = /<trade_evaluation>([\s\S]*?)<\/trade_evaluation>/g;
const RISK_VAL_RE = /<risk_validation>([\s\S]*?)<\/risk_validation>/g;

const TICKER_RE = /^[ \t]*TICKER:\s*([A-Z][A-Z0-9.-]*)\s*$/m;
const SIDE_RE = /^[ \t]*SIDE:\s*(buy|sell)\s*$/m;
const RECOMMENDATION_RE = /^[ \t]*RECOMMENDATION:\s*(PROCEED|RECONSIDER|REJECT)\s*$/m;
const VERDICT_RE = /^[ \t]*VERDICT:\s*(APPROVED|REJECTED)\s*$/m;

export class VerdictTracker {
  /** Public for test introspection only — do not use externally. */
  _verdicts: Verdict[] = [];

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
      return {
        decision: "block",
        systemMessage:
          `place_order denied: BUY ${symbol} requires both trade-evaluator PROCEED and risk-guardian APPROVED for (${symbol}, buy). ` +
          `Found: trade-evaluator=${evalStatus}, risk-guardian=${guardStatus}. ` +
          `Required: invoke trade-evaluator (Task tool) and risk-guardian for this trade before retrying.`,
      };
    }

    if (side === "sell") {
      if (guardian?.approved) {
        return { decision: "approve" };
      }
      const guardStatus = guardian?.recommendation ?? "none found";
      return {
        decision: "block",
        systemMessage:
          `place_order denied: SELL ${symbol} requires risk-guardian APPROVED for (${symbol}, sell). ` +
          `Found: risk-guardian=${guardStatus}. ` +
          `Required: invoke risk-guardian (Task tool) for this trade before retrying.`,
      };
    }

    console.warn(`[verdict-tracker] unknown side '${side}' for ${symbol} — allowing place_order`);
    return { decision: "approve" };
  }
}
