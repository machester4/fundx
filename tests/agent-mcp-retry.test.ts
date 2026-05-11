import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@anthropic-ai/claude-agent-sdk");
  return { ...actual, query: vi.fn() };
});

const mocked = await import("@anthropic-ai/claude-agent-sdk");
const { query } = mocked as unknown as { query: ReturnType<typeof vi.fn> };

import { runAgentQuery } from "../src/agent.js";

function stream(messages: unknown[], throwAtStart?: Error): AsyncGenerator<unknown> {
  return (async function* () {
    if (throwAtStart) throw throwAtStart;
    for (const m of messages) yield m;
  })();
}

describe("runAgentQuery MCP transport retry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retries once on EPIPE before any progress", async () => {
    const ok = [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "result", subtype: "success", result: "done", total_cost_usd: 0.01, num_turns: 1, modelUsage: {}, session_id: "s1" },
    ];
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    query.mockReturnValueOnce(stream([], epipe)).mockReturnValueOnce(stream(ok));

    const result = await runAgentQuery({ fundName: "fundx-audit", prompt: "test" });
    expect(result.status).toBe("success");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on application errors (non-transport)", async () => {
    const appError = new Error("tool execution failed: invalid input");
    query.mockReturnValueOnce(stream([], appError));

    const result = await runAgentQuery({ fundName: "fundx-audit", prompt: "test" });
    expect(result.status).toBe("error");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry MCP error after progress was made", async () => {
    // Stream emits a tool_use event (progress), then crashes
    const partialThenCrash = (async function* () {
      yield { type: "system", subtype: "init", session_id: "s1" };
      yield {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "tool_use", name: "mcp__broker-local__place_order" } },
      };
      yield {
        type: "stream_event",
        event: { type: "content_block_stop" },
      };
      throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    })();
    query.mockReturnValueOnce(partialThenCrash);

    const result = await runAgentQuery({ fundName: "fundx-audit", prompt: "test" });
    expect(result.status).toBe("error");
    expect(query).toHaveBeenCalledTimes(1); // no retry — there was progress (tool_use observed)
  });
});
