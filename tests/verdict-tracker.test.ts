import { describe, it, expect } from "vitest";
import { VerdictTracker } from "../src/services/verdict-tracker.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Helper: build a mock assistant message with one tool_result block.
function mockToolResult(text: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "tool_result", tool_use_id: "fake", content: text },
      ],
    },
  } as unknown as SDKMessage;
}

// Realistic shape: tool_result blocks live on user-typed messages per SDK spec.
function mockToolResultOnUserMessage(text: string): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "fake", content: text },
      ],
    },
  } as unknown as SDKMessage;
}

const evalApproved = `<trade_evaluation>
TICKER: AAPL
SIDE: buy
SCORE: 4
RECOMMENDATION: PROCEED
</trade_evaluation>`;

const evalReject = `<trade_evaluation>
TICKER: AAPL
SIDE: buy
SCORE: 2
RECOMMENDATION: REJECT
</trade_evaluation>`;

const guardApproved = `<risk_validation>
TICKER: AAPL
SIDE: buy
VERDICT: APPROVED
</risk_validation>`;

const guardRejected = `<risk_validation>
TICKER: AAPL
SIDE: buy
VERDICT: REJECTED
</risk_validation>`;

describe("VerdictTracker.observe", () => {
  it("extracts trade-evaluator verdict from tool_result", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(evalApproved));
    expect(t._verdicts).toHaveLength(1);
    expect(t._verdicts[0]).toMatchObject({
      ticker: "AAPL",
      side: "buy",
      source: "trade-evaluator",
      recommendation: "PROCEED",
      approved: true,
    });
  });

  it("extracts risk-guardian verdict from tool_result", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(guardApproved));
    expect(t._verdicts[0]).toMatchObject({
      ticker: "AAPL",
      side: "buy",
      source: "risk-guardian",
      recommendation: "APPROVED",
      approved: true,
    });
  });

  it("ignores messages without verdict XML", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult("Just some plain text response."));
    expect(t._verdicts).toHaveLength(0);
  });

  it("ignores non-assistant messages", () => {
    const t = new VerdictTracker();
    t.observe({ type: "user", message: { role: "user", content: evalApproved } } as unknown as SDKMessage);
    expect(t._verdicts).toHaveLength(0);
  });

  it("handles multiple verdicts in a single message", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(`${evalApproved}\n\n${guardApproved}`));
    expect(t._verdicts).toHaveLength(2);
  });

  it("handles malformed XML gracefully (missing TICKER) — does not push", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(`<trade_evaluation>SIDE: buy\nRECOMMENDATION: PROCEED</trade_evaluation>`));
    expect(t._verdicts).toHaveLength(0);
  });

  it("handles tool_result with non-string content gracefully", () => {
    const t = new VerdictTracker();
    const msg = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: evalApproved }] }] },
    } as unknown as SDKMessage;
    expect(() => t.observe(msg)).not.toThrow();
  });

  it("RECONSIDER recommendation maps to approved=false", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(`<trade_evaluation>
TICKER: NVDA
SIDE: buy
RECOMMENDATION: RECONSIDER
</trade_evaluation>`));
    expect(t._verdicts[0].approved).toBe(false);
  });

  it("extracts verdict from user-typed message (real SDK shape)", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResultOnUserMessage(evalApproved));
    expect(t._verdicts).toHaveLength(1);
    expect(t._verdicts[0].ticker).toBe("AAPL");
  });

  it("extracts verdict from both user and assistant message types", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResultOnUserMessage(evalApproved));     // user-typed
    t.observe(mockToolResult(guardApproved));                 // assistant-typed (defensive coverage)
    expect(t._verdicts).toHaveLength(2);
  });

  it("ignores 'system' or other message types", () => {
    const t = new VerdictTracker();
    t.observe({ type: "system", subtype: "init" } as unknown as SDKMessage);
    t.observe({ type: "result" } as unknown as SDKMessage);
    expect(t._verdicts).toHaveLength(0);
  });

  it("tolerates leading whitespace in field lines", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResultOnUserMessage(`<trade_evaluation>
    TICKER: AAPL
    SIDE: buy
    SCORE: 4
    RECOMMENDATION: PROCEED
</trade_evaluation>`));
    expect(t._verdicts).toHaveLength(1);
    expect(t._verdicts[0].ticker).toBe("AAPL");
  });
});

describe("VerdictTracker.checkPlaceOrder — BUY", () => {
  it("approves BUY when both verdicts approved", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(evalApproved));
    t.observe(mockToolResult(guardApproved));
    const out = t.checkPlaceOrder({ symbol: "AAPL", side: "buy" });
    expect(out).toEqual({ decision: "approve" });
  });

  it("blocks BUY when only evaluator approved (missing guardian)", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(evalApproved));
    const out = t.checkPlaceOrder({ symbol: "AAPL", side: "buy" });
    expect(out.decision).toBe("block");
    expect(out.systemMessage).toContain("place_order denied");
    expect(out.systemMessage).toContain("risk-guardian=none found");
  });

  it("blocks BUY when only guardian approved (missing evaluator)", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(guardApproved));
    const out = t.checkPlaceOrder({ symbol: "AAPL", side: "buy" });
    expect(out.decision).toBe("block");
    expect(out.systemMessage).toContain("trade-evaluator=none found");
  });

  it("blocks BUY when evaluator REJECT", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(evalReject));
    t.observe(mockToolResult(guardApproved));
    const out = t.checkPlaceOrder({ symbol: "AAPL", side: "buy" });
    expect(out.decision).toBe("block");
    expect(out.systemMessage).toContain("trade-evaluator=REJECT");
  });

  it("blocks BUY when guardian REJECTED", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(evalApproved));
    t.observe(mockToolResult(guardRejected));
    const out = t.checkPlaceOrder({ symbol: "AAPL", side: "buy" });
    expect(out.decision).toBe("block");
    expect(out.systemMessage).toContain("risk-guardian=REJECTED");
  });

  it("blocks BUY for ticker that has no verdicts at all", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(evalApproved));   // for AAPL
    t.observe(mockToolResult(guardApproved));  // for AAPL
    const out = t.checkPlaceOrder({ symbol: "MSFT", side: "buy" });
    expect(out.decision).toBe("block");
  });
});

describe("VerdictTracker.checkPlaceOrder — SELL", () => {
  const guardSellApproved = `<risk_validation>
TICKER: AAPL
SIDE: sell
VERDICT: APPROVED
</risk_validation>`;

  it("approves SELL when only risk-guardian approved (no evaluator needed)", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(guardSellApproved));
    const out = t.checkPlaceOrder({ symbol: "AAPL", side: "sell" });
    expect(out).toEqual({ decision: "approve" });
  });

  it("blocks SELL when no risk-guardian verdict for sell", () => {
    const t = new VerdictTracker();
    const out = t.checkPlaceOrder({ symbol: "AAPL", side: "sell" });
    expect(out.decision).toBe("block");
    expect(out.systemMessage).toContain("SELL AAPL");
    expect(out.systemMessage).toContain("risk-guardian=none found");
  });

  it("blocks SELL when guardian verdict is for buy (wrong side)", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(guardApproved));  // SIDE: buy
    const out = t.checkPlaceOrder({ symbol: "AAPL", side: "sell" });
    expect(out.decision).toBe("block");
  });
});

describe("VerdictTracker.checkPlaceOrder — most-recent wins", () => {
  it("subsequent verdict for same (source, ticker, side) overrides earlier", () => {
    const t = new VerdictTracker();
    t.observe(mockToolResult(evalApproved));   // PROCEED
    t.observe(mockToolResult(guardApproved));
    // Re-evaluate: now REJECT
    t.observe(mockToolResult(evalReject));
    const out = t.checkPlaceOrder({ symbol: "AAPL", side: "buy" });
    expect(out.decision).toBe("block");
    expect(out.systemMessage).toContain("trade-evaluator=REJECT");
  });
});
