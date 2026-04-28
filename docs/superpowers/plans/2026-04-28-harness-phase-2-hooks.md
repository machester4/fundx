# Phase 2 — Gate Hooks (G1 + G3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two complementary mechanisms layered on `runFundSession` — (G3) pre-populate a `<state_snapshot>` envelope into the first user message of every autonomous session, and (G1) register a `PreToolUse` hook on `mcp__broker-local__place_order` that denies the call unless the most-recent verdict for the (ticker, side) tuple satisfies the side-specific rule (BUY: trade-evaluator PROCEED + risk-guardian APPROVED; SELL: risk-guardian APPROVED).

**Architecture:** The Agent SDK exposes `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>` natively (verified via `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`). New `VerdictTracker` class observes streaming SDK messages via `onMessage`, parses `<trade_evaluation>` and `<risk_validation>` XML blocks from sub-agent tool_result content, and exposes `checkPlaceOrder` for the hook callback. New `buildStateSnapshot` helper reads 6 state files and emits an XML envelope. Both wired into `runFundSession` only — chat/ask/eval surfaces unchanged.

**Tech Stack:** TypeScript (strict ESM), Vitest (test framework), pnpm. Tests in `tests/`, source in `src/`. Imports use `.js` extension for ESM compat.

**Spec:** [`docs/superpowers/specs/2026-04-27-harness-phase-2-design.md`](../specs/2026-04-27-harness-phase-2-design.md)

---

## File Structure

| Path | Type | Responsibility |
|---|---|---|
| `src/services/verdict-tracker.ts` | Create | `VerdictTracker` class + `Verdict` interface. Pure logic — no I/O. |
| `src/services/snapshot.service.ts` | Create | `buildStateSnapshot(fundName)` async helper. Reads 6 state files + journal/watchlist queries; returns XML string. |
| `src/services/session.service.ts` | Modify | Wire `buildStateSnapshot` into prompt construction; instantiate `VerdictTracker`; pass `onMessage` + `hooks` to `runAgentQuery`. Add new `stateSnapshot?` field to `BuildAutonomousPromptInput`. |
| `src/agent.ts` | Modify | Extend `AgentQueryOptions` with optional `hooks` field; pass through to SDK `query()` options. |
| `src/subagent.ts` | Modify | Add `TICKER:` + `SIDE:` lines to `<trade_evaluation>` and `<risk_validation>` output formats. |
| `src/skills.ts` | Modify | Simplify `session-init` rule — replace 7-step Orient with snapshot-aware version. |
| `tests/verdict-tracker.test.ts` | Create | ~20 unit tests for VerdictTracker. |
| `tests/snapshot.test.ts` | Create | ~10 unit tests for buildStateSnapshot. |
| `tests/session.test.ts` | Modify | Extend with assertions that hooks + onMessage are passed; mock fundx-audit fund state. |
| `tests/subagent.test.ts` | Modify | Assert TICKER+SIDE present in trade-evaluator + risk-guardian outputs. |
| `tests/skills.test.ts` | Modify | Update assertions on session-init rule content. |
| `CLAUDE.md` | Modify | One-line mention of snapshot + verdict gate in Configuration section. |

---

## Task 1: VerdictTracker class

**Files:**
- Create: `src/services/verdict-tracker.ts`
- Create: `tests/verdict-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/verdict-tracker.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/verdict-tracker.test.ts`
Expected: FAIL with "Cannot find module '../src/services/verdict-tracker.js'".

- [ ] **Step 3: Implement VerdictTracker**

Create `src/services/verdict-tracker.ts`:

```typescript
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

const TICKER_RE = /^TICKER:\s*([A-Z][A-Z0-9.-]*)\s*$/m;
const SIDE_RE = /^SIDE:\s*(buy|sell)\s*$/m;
const RECOMMENDATION_RE = /^RECOMMENDATION:\s*(PROCEED|RECONSIDER|REJECT)\s*$/m;
const VERDICT_RE = /^VERDICT:\s*(APPROVED|REJECTED)\s*$/m;

export class VerdictTracker {
  /** Public for test introspection only — do not use externally. */
  _verdicts: Verdict[] = [];

  observe(message: SDKMessage): void {
    if (message.type !== "assistant") return;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/verdict-tracker.test.ts`
Expected: PASS — all 19 tests green.

- [ ] **Step 5: Type-check**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/verdict-tracker.ts tests/verdict-tracker.test.ts
git commit -m "feat(verdict-tracker): parse subagent verdicts + per-side place_order gate logic"
```

---

## Task 2: buildStateSnapshot helper

**Files:**
- Create: `src/services/snapshot.service.ts`
- Create: `tests/snapshot.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/snapshot.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = join(tmpdir(), `fundx-snapshot-test-${Date.now()}`);

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => ({
      root: join(tmpRoot, "funds", name),
      claudeMd: join(tmpRoot, "funds", name, "CLAUDE.md"),
      state: join(tmpRoot, "funds", name, "state"),
      handoff: join(tmpRoot, "funds", name, "state", "session-handoff.md"),
      portfolio: join(tmpRoot, "funds", name, "state", "portfolio.json"),
      objectiveTracker: join(tmpRoot, "funds", name, "state", "objective_tracker.json"),
      pendingSessions: join(tmpRoot, "funds", name, "state", "pending_sessions.json"),
      tradeJournal: join(tmpRoot, "funds", name, "state", "trade_journal.sqlite"),
    }),
  };
});

vi.mock("../src/journal.js", () => ({
  openJournal: vi.fn(() => ({ close: vi.fn() })),
  getRecentTrades: vi.fn(() => []),
}));

vi.mock("../src/services/watchlist.service.js", () => ({
  openWatchlistDb: vi.fn(() => ({ close: vi.fn() })),
  queryWatchlist: vi.fn(() => []),
}));

import { buildStateSnapshot } from "../src/services/snapshot.service.js";
import { getRecentTrades } from "../src/journal.js";
import { queryWatchlist } from "../src/services/watchlist.service.js";

const mockedGetRecent = vi.mocked(getRecentTrades);
const mockedQueryWatch = vi.mocked(queryWatchlist);

beforeEach(async () => {
  vi.clearAllMocks();
  await rm(tmpRoot, { recursive: true, force: true });
});

async function seed(fund: string, files: Record<string, string>): Promise<void> {
  const stateDir = join(tmpRoot, "funds", fund, "state");
  await mkdir(stateDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(stateDir, name), content, "utf-8");
  }
}

describe("buildStateSnapshot", () => {
  it("returns full envelope when all sources present", async () => {
    await seed("f1", {
      "session-handoff.md": "# Handoff\nLast session OK.",
      "portfolio.json": '{"cash": 1000, "positions": []}',
      "objective_tracker.json": '{"progress_pct": 50}',
      "pending_sessions.json": "[]",
    });
    mockedGetRecent.mockReturnValue([
      { id: 1, timestamp: "2026-04-28T10:00:00Z", fund: "f1", symbol: "AAPL", side: "buy", quantity: 1, price: 100, total_value: 100, order_type: "market" },
    ] as never);
    mockedQueryWatch.mockReturnValue([
      { ticker: "MSFT", status: "candidate", current_screens_json: "[]", last_evaluated_at: "2026-04-28" } as never,
    ]);

    const snap = await buildStateSnapshot("f1");

    expect(snap).toContain("<state_snapshot>");
    expect(snap).toContain("</state_snapshot>");
    expect(snap).toContain("<session_handoff>");
    expect(snap).toContain("Last session OK.");
    expect(snap).toContain("<portfolio>");
    expect(snap).toContain('"cash": 1000');
    expect(snap).toContain("<objective_tracker>");
    expect(snap).toContain('"progress_pct": 50');
    expect(snap).toContain("<pending_sessions>");
    expect(snap).toContain("<recent_trades");
    expect(snap).toContain("AAPL");
    expect(snap).toContain("<watchlist");
    expect(snap).toContain("MSFT");
  });

  it("emits (none — first session) when handoff missing", async () => {
    await seed("f2", {
      "portfolio.json": '{"cash": 5000}',
    });
    const snap = await buildStateSnapshot("f2");
    expect(snap).toContain("<session_handoff>(none — first session)</session_handoff>");
  });

  it("emits (none) when pending_sessions missing", async () => {
    await seed("f3", { "portfolio.json": '{"cash": 5000}' });
    const snap = await buildStateSnapshot("f3");
    expect(snap).toContain("<pending_sessions>(none)</pending_sessions>");
  });

  it("emits (empty) when journal returns no trades", async () => {
    await seed("f4", { "portfolio.json": '{"cash": 5000}' });
    mockedGetRecent.mockReturnValue([]);
    const snap = await buildStateSnapshot("f4");
    expect(snap).toContain('<recent_trades count="10">(empty)</recent_trades>');
  });

  it("emits (empty) when watchlist returns no entries", async () => {
    await seed("f5", { "portfolio.json": '{"cash": 5000}' });
    mockedQueryWatch.mockReturnValue([]);
    const snap = await buildStateSnapshot("f5");
    expect(snap).toContain('<watchlist top="10">(empty)</watchlist>');
  });

  it("returns valid envelope when fund directory does not exist at all", async () => {
    // No seed call — fund dir not created
    const snap = await buildStateSnapshot("nonexistent-fund");
    expect(snap).toContain("<state_snapshot>");
    expect(snap).toContain("</state_snapshot>");
    expect(snap).toContain("(none");
  });

  it("snapshot opens with <state_snapshot> and closes with </state_snapshot>", async () => {
    const snap = await buildStateSnapshot("anyfund");
    expect(snap.trim().startsWith("<state_snapshot>")).toBe(true);
    expect(snap.trim().endsWith("</state_snapshot>")).toBe(true);
  });

  it("snapshot length under 50KB sanity cap", async () => {
    await seed("f6", {
      "session-handoff.md": "X".repeat(10_000),
      "portfolio.json": '{"cash": 5000}',
    });
    const snap = await buildStateSnapshot("f6");
    expect(snap.length).toBeLessThan(50_000);
  });

  it("handles journal query failure (catches db error, emits empty section)", async () => {
    await seed("f7", { "portfolio.json": '{"cash": 5000}' });
    mockedGetRecent.mockImplementation(() => {
      throw new Error("db locked");
    });
    const snap = await buildStateSnapshot("f7");
    expect(snap).toContain("<recent_trades");
    expect(snap).toContain("(empty");
  });

  it("handles watchlist query failure", async () => {
    await seed("f8", { "portfolio.json": '{"cash": 5000}' });
    mockedQueryWatch.mockImplementation(() => {
      throw new Error("watchlist db unavailable");
    });
    const snap = await buildStateSnapshot("f8");
    expect(snap).toContain("<watchlist");
    expect(snap).toContain("(empty");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/snapshot.test.ts`
Expected: FAIL with "Cannot find module '../src/services/snapshot.service.js'".

- [ ] **Step 3: Implement buildStateSnapshot**

Create `src/services/snapshot.service.ts`:

```typescript
import { readFile } from "node:fs/promises";
import { fundPaths } from "../paths.js";
import { openJournal, getRecentTrades } from "../journal.js";
import { openWatchlistDb, queryWatchlist } from "./watchlist.service.js";

const TOP_TRADES = 10;
const TOP_WATCHLIST = 10;

async function readOr(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return fallback;
  }
}

function tryRecentTrades(fundName: string): string {
  let db: ReturnType<typeof openJournal> | undefined;
  try {
    db = openJournal(fundName);
    const trades = getRecentTrades(db, fundName, TOP_TRADES);
    if (trades.length === 0) return "(empty)";
    return JSON.stringify(trades, null, 2);
  } catch (err) {
    console.warn(`[snapshot] journal query failed for ${fundName}:`, err instanceof Error ? err.message : err);
    return `(empty — ${err instanceof Error ? err.message : "query failed"})`;
  } finally {
    db?.close?.();
  }
}

function tryWatchlistTop(fundName: string): string {
  let db: ReturnType<typeof openWatchlistDb> | undefined;
  try {
    db = openWatchlistDb();
    const rows = queryWatchlist(db, {
      fund: fundName,
      status: ["candidate", "watching"],
      limit: TOP_WATCHLIST,
    });
    if (rows.length === 0) return "(empty)";
    return JSON.stringify(rows, null, 2);
  } catch (err) {
    console.warn(`[snapshot] watchlist query failed for ${fundName}:`, err instanceof Error ? err.message : err);
    return `(empty — ${err instanceof Error ? err.message : "query failed"})`;
  } finally {
    db?.close?.();
  }
}

/** Build an XML envelope with the fund's current state for prompt pre-population.
 *  Robustness: never throws — missing files emit `(none)`, query failures emit `(empty)`.
 *  See docs/superpowers/specs/2026-04-27-harness-phase-2-design.md Component 1. */
export async function buildStateSnapshot(fundName: string): Promise<string> {
  const paths = fundPaths(fundName);

  const handoff = await readOr(paths.handoff, "(none — first session)");
  const portfolio = await readOr(paths.portfolio, "(none)");
  const objectiveTracker = await readOr(paths.objectiveTracker, "(none)");
  const pendingSessions = await readOr(paths.pendingSessions, "(none)");
  const recentTrades = tryRecentTrades(fundName);
  const watchlist = tryWatchlistTop(fundName);

  return [
    `<state_snapshot>`,
    `<session_handoff>${handoff === "(none — first session)" ? "(none — first session)" : `\n${handoff.trim()}\n`}</session_handoff>`,
    `<portfolio>${portfolio === "(none)" ? "(none)" : `\n${portfolio.trim()}\n`}</portfolio>`,
    `<objective_tracker>${objectiveTracker === "(none)" ? "(none)" : `\n${objectiveTracker.trim()}\n`}</objective_tracker>`,
    `<pending_sessions>${pendingSessions === "(none)" ? "(none)" : `\n${pendingSessions.trim()}\n`}</pending_sessions>`,
    `<recent_trades count="${TOP_TRADES}">${recentTrades.startsWith("(") ? recentTrades : `\n${recentTrades}\n`}</recent_trades>`,
    `<watchlist top="${TOP_WATCHLIST}">${watchlist.startsWith("(") ? watchlist : `\n${watchlist}\n`}</watchlist>`,
    `</state_snapshot>`,
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/snapshot.test.ts`
Expected: PASS — 9 tests green.

- [ ] **Step 5: Verify all `paths.X` field names actually exist**

Run: `grep -nE "handoff|objectiveTracker|pendingSessions" src/paths.ts | head -10`
Expected: shows the field names referenced. If a name doesn't match (e.g., `handoff` is actually `handoffPath`), update both `snapshot.service.ts` AND the test mock to match the real names.

- [ ] **Step 6: Type-check**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/services/snapshot.service.ts tests/snapshot.test.ts
git commit -m "feat(snapshot): build XML state envelope for prompt pre-population"
```

---

## Task 3: Add TICKER + SIDE to subagent output formats

**Files:**
- Modify: `src/subagent.ts` (trade-evaluator + risk-guardian output format strings)
- Modify: `tests/subagent.test.ts` (assertions)

- [ ] **Step 1: Add TICKER + SIDE to trade-evaluator output format**

In `src/subagent.ts`, find the `trade-evaluator` agent's output format section. The current output starts with:

```
<trade_evaluation>
SCORE: [1-5]
THESIS_STRENGTH: [1-5 with one-line justification]
...
</trade_evaluation>
```

Replace with:

```
<trade_evaluation>
TICKER: [ticker symbol of the proposed trade, e.g., AAPL]
SIDE: [buy or sell]
SCORE: [1-5]
THESIS_STRENGTH: [1-5 with one-line justification]
...
</trade_evaluation>
```

Concretely, in the `prompt:` array, find the line with backtick `<trade_evaluation>` followed by `SCORE:` and insert two lines between them. Use the Edit tool to insert exactly:

```typescript
        `TICKER: [ticker symbol of the proposed trade, e.g., AAPL]`,
        `SIDE: [buy or sell]`,
```

immediately after the line containing `` `<trade_evaluation>`,`` and before `` `SCORE: [1-5]`,``.

- [ ] **Step 2: Add TICKER + SIDE to risk-guardian output format**

Same pattern in `src/subagent.ts` for the `risk-guardian` agent. Find:

```
<risk_validation>
VERDICT: APPROVED | REJECTED
...
</risk_validation>
```

Insert TICKER + SIDE lines just after `<risk_validation>`:

```typescript
        `TICKER: [ticker symbol of the proposed trade, e.g., AAPL]`,
        `SIDE: [buy or sell]`,
```

- [ ] **Step 3: Update existing test assertions**

In `tests/subagent.test.ts`, find the trade-evaluator describe block. Add a new test assertion:

```typescript
    it("output format includes TICKER and SIDE fields", () => {
      expect(agent.prompt).toMatch(/<trade_evaluation>[\s\S]*TICKER:/);
      expect(agent.prompt).toMatch(/<trade_evaluation>[\s\S]*SIDE: \[buy or sell\]/);
    });
```

In the risk-guardian describe block, add:

```typescript
    it("output format includes TICKER and SIDE fields", () => {
      expect(agent.prompt).toMatch(/<risk_validation>[\s\S]*TICKER:/);
      expect(agent.prompt).toMatch(/<risk_validation>[\s\S]*SIDE: \[buy or sell\]/);
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/subagent.test.ts`
Expected: PASS — all subagent tests green including the 2 new assertions.

- [ ] **Step 5: Type-check**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/subagent.ts tests/subagent.test.ts
git commit -m "feat(subagent): add TICKER and SIDE fields to trade-evaluator + risk-guardian output formats"
```

---

## Task 4: Add hooks field to AgentQueryOptions

**Files:**
- Modify: `src/agent.ts` (interface + query options)

- [ ] **Step 1: Verify the existing test suite is green**

Run: `pnpm test`
Expected: PASS. Record the baseline test count.

- [ ] **Step 2: Update the import in `src/agent.ts`**

Find lines 1–8 of `src/agent.ts`. Update the type imports to include `HookEvent` and `HookCallbackMatcher`:

```typescript
import { query, AbortError } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKResultMessage,
  ModelUsage,
  AgentDefinition,
  McpSdkServerConfigWithInstance,
  HookEvent,
  HookCallbackMatcher,
} from "@anthropic-ai/claude-agent-sdk";
```

- [ ] **Step 3: Extend `AgentQueryOptions` with `hooks` field**

Find the `AgentQueryOptions` interface (around line 20–40 of `src/agent.ts`). Add a new optional field at the end of the interface (just before the closing `}`):

```typescript
  /** PreToolUse / PostToolUse / Stop hooks (passed through to SDK).
   *  See sdk.d.ts:HookCallbackMatcher for shape. */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
```

- [ ] **Step 4: Pass `hooks` through to the SDK**

Find the `for await (const message of query({...}))` block (around line 234 of `src/agent.ts`). The `options:` object passed to `query` currently has fields like `model`, `maxTurns`, `cwd`, etc. Add:

```typescript
        ...(options.hooks ? { hooks: options.hooks } : {}),
```

inside the `options: { ... }` object, anywhere after `model:` is fine. Use the spread to avoid passing `hooks: undefined`.

- [ ] **Step 5: Type-check**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: PASS — same count as baseline (no regression).

- [ ] **Step 7: Commit**

```bash
git add src/agent.ts
git commit -m "feat(agent): pass-through hooks field on AgentQueryOptions"
```

---

## Task 5: Wire snapshot + verdict tracker into runFundSession

**Files:**
- Modify: `src/services/session.service.ts` (function `buildAutonomousPrompt` + `runFundSession`)
- Modify: `tests/session.test.ts` (add hook + onMessage assertions)

- [ ] **Step 1: Verify baseline**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Add `stateSnapshot` field to `BuildAutonomousPromptInput`**

In `src/services/session.service.ts`, find the `BuildAutonomousPromptInput` interface (around line 15). Add:

```typescript
  /** Optional pre-populated state snapshot (XML envelope). Inserted after
   *  the session-mode prefix and before the "You are running..." line. */
  stateSnapshot?: string;
```

- [ ] **Step 3: Inject the snapshot into the prompt array**

In the same file, find the `buildAutonomousPrompt` function body (around line 31). The current `lines` array starts with:

```typescript
  const lines: string[] = [
    sessionModePrefix("autonomous-scheduled"),
    ``,
    `You are running a ${input.sessionType} session for fund '${input.fundName}'.`,
```

Modify to insert the snapshot block between the empty line and the "You are running" line:

```typescript
  const lines: string[] = [
    sessionModePrefix("autonomous-scheduled"),
    ``,
    ...(input.stateSnapshot ? [input.stateSnapshot, ``] : []),
    `You are running a ${input.sessionType} session for fund '${input.fundName}'.`,
```

- [ ] **Step 4: Add unit test for snapshot injection in `buildAutonomousPrompt`**

In `tests/autonomous-prompt.test.ts`, append a new test:

```typescript
  it("injects state snapshot when provided", () => {
    const out = buildAutonomousPrompt({
      ...baseInput,
      stateSnapshot: "<state_snapshot>fake snapshot</state_snapshot>",
    });
    expect(out).toContain("<state_snapshot>fake snapshot</state_snapshot>");
    // Snapshot must come before the running header
    const snapIdx = out.indexOf("<state_snapshot>");
    const runIdx = out.indexOf("running a pre-market session");
    expect(snapIdx).toBeLessThan(runIdx);
  });

  it("omits snapshot block when not provided", () => {
    const out = buildAutonomousPrompt(baseInput);
    expect(out).not.toContain("<state_snapshot>");
  });
```

- [ ] **Step 5: Run autonomous-prompt tests to verify they pass**

Run: `pnpm test -- tests/autonomous-prompt.test.ts`
Expected: PASS — the existing tests + 2 new tests.

- [ ] **Step 6: Wire `buildStateSnapshot` + `VerdictTracker` into `runFundSession`**

In `src/services/session.service.ts`, find `runFundSession` (around line 100). Add the imports at the top of the file:

```typescript
import { buildStateSnapshot } from "./snapshot.service.js";
import { VerdictTracker } from "./verdict-tracker.js";
```

Inside `runFundSession`, after the existing `loadFundConfig` + `loadGlobalConfig` calls and before the `buildAutonomousPrompt` invocation, build the snapshot:

```typescript
  const stateSnapshot = await buildStateSnapshot(fundName);
```

Pass it to `buildAutonomousPrompt`:

```typescript
  const prompt = buildAutonomousPrompt({
    fundName,
    sessionType,
    focus,
    universeBlock,
    useDebateSkills: options?.useDebateSkills,
    today,
    stateSnapshot,
  });
```

Then, just before the `runAgentQuery` call, instantiate the verdict tracker:

```typescript
  const verdictTracker = new VerdictTracker();
```

Modify both `runAgentQuery` invocations (initial + retry) to pass `onMessage` and `hooks`. For each, replace:

```typescript
    result = await runAgentQuery({
      fundName,
      prompt,
      model,
      maxTurns: effectiveMaxTurns,
      maxBudgetUsd: effectiveMaxBudgetUsd,
      timeoutMs: timeout,
      agents,
      resumeSessionId: activeSession?.session_id, // present in first call only
    });
```

with:

```typescript
    result = await runAgentQuery({
      fundName,
      prompt,
      model,
      maxTurns: effectiveMaxTurns,
      maxBudgetUsd: effectiveMaxBudgetUsd,
      timeoutMs: timeout,
      agents,
      resumeSessionId: activeSession?.session_id, // present in first call only
      onMessage: (msg) => verdictTracker.observe(msg),
      hooks: {
        PreToolUse: [
          {
            matcher: "mcp__broker-local__place_order",
            hooks: [
              async (input) => {
                const ti = (input as { tool_input?: { symbol?: string; side?: "buy" | "sell" } }).tool_input;
                if (!ti?.symbol || !ti.side) {
                  return { decision: "approve" } as const;
                }
                return verdictTracker.checkPlaceOrder({ symbol: ti.symbol, side: ti.side });
              },
            ],
          },
        ],
      },
    });
```

(Apply the same `onMessage` + `hooks` to the retry-on-SESSION_EXPIRED `runAgentQuery` call. The retry call doesn't pass `resumeSessionId` but the rest of the args are identical — copy the same `onMessage` + `hooks` block.)

- [ ] **Step 7: Update `tests/session.test.ts` to assert hook wiring**

In `tests/session.test.ts`, mock `buildStateSnapshot` and `VerdictTracker` so the existing tests don't break. At the top of the file, add the mocks alongside existing ones:

```typescript
vi.mock("../src/services/snapshot.service.js", () => ({
  buildStateSnapshot: vi.fn(async () => "<state_snapshot>mock</state_snapshot>"),
}));

vi.mock("../src/services/verdict-tracker.js", () => ({
  VerdictTracker: vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    checkPlaceOrder: vi.fn(() => ({ decision: "approve" })),
  })),
}));
```

Then add new test assertions in the `describe("runFundSession", ...)` block:

```typescript
  it("passes onMessage and hooks to runAgentQuery", async () => {
    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(typeof opts.onMessage).toBe("function");
    expect(opts.hooks).toBeDefined();
    expect(opts.hooks.PreToolUse).toBeInstanceOf(Array);
    expect(opts.hooks.PreToolUse[0].matcher).toBe("mcp__broker-local__place_order");
  });

  it("includes state snapshot in the prompt", async () => {
    await runFundSession("test-fund", "pre_market");

    const opts = mockRunAgentQuery.mock.calls[0][0];
    expect(opts.prompt).toContain("<state_snapshot>mock</state_snapshot>");
  });
```

- [ ] **Step 8: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all tests including the 2 new in session.test.ts and 2 new in autonomous-prompt.test.ts.

- [ ] **Step 9: Type-check**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 10: Commit**

```bash
git add src/services/session.service.ts tests/session.test.ts tests/autonomous-prompt.test.ts
git commit -m "feat(session): wire stateSnapshot pre-population + VerdictTracker hook into runFundSession"
```

---

## Task 6: Simplify session-init rule

**Files:**
- Modify: `src/skills.ts` (FUND_RULES entry for session-init.md)
- Modify: `tests/skills.test.ts` (assertions)

- [ ] **Step 1: Find the session-init rule definition**

Run: `grep -nE "session-init|filename.*'session-init" src/skills.ts | head -5`
Expected: shows the line range where the rule content lives. Note the start and end line numbers for the next step.

- [ ] **Step 2: Replace the autonomous-mode section of the rule**

In `src/skills.ts`, find the `session-init.md` entry inside `FUND_RULES`. The entry has a `content` field with a string template covering an "Applies to" section, an Orient sequence with 6-7 steps for autonomous mode, and contract-writing instructions.

Replace the entire `content` string with:

```typescript
    content: `# Session Init

## Applies to
Autonomous scheduled sessions (mode prefix: "Session mode: autonomous scheduled").

In interactive chat or ask sessions, this rule does not apply — context is built by the harness.

## What you receive
You begin each autonomous session with a <state_snapshot> envelope in your first
user message containing the same artifacts the previous version of this rule
asked you to read manually:

- session-handoff.md (last session's handoff)
- portfolio.json (current cash + positions)
- objective_tracker.json (progress vs goal)
- pending_sessions.json (self-scheduled follow-ups)
- recent_trades (top 10 from the journal)
- watchlist (top 10 candidates)

Interpret the snapshot directly. The state files in \`state/\` remain the
canonical source if you need to re-read something specific (e.g., the full
journal beyond the top 10, or older handoffs in archive).

## What you must do

1. **Verify state integrity.** From the snapshot's <portfolio> block: cash + positions market value should reconcile with the fund's tracked total (close enough for fp arithmetic). If a major discrepancy, surface it as an Open Concern in the handoff and stop before any trades.

2. **Write a Session Contract** to \`state/session-handoff.md\` (replace the existing \`## Session Contract\` block, do not append). Declare:
   - This session's intent in 1-2 sentences
   - The success criteria
   - What "done" looks like

3. Proceed with your Session Protocol (see CLAUDE.md).
`,
```

(Take care to preserve the exact `dirName: "session-init"` and other fields of the rule object.)

- [ ] **Step 3: Update assertions in `tests/skills.test.ts`**

Find the assertions that test `session-init` rule content. Update or remove any that reference the old "read these files in order" sequence. Add new assertions for the simplified content:

```typescript
  it("session-init rule references the <state_snapshot> envelope", () => {
    const rule = FUND_RULES.find((r) => r.dirName === "session-init");
    expect(rule).toBeDefined();
    expect(rule!.content).toContain("<state_snapshot>");
    expect(rule!.content).toContain("Session Contract");
  });

  it("session-init rule still applies only to autonomous scheduled sessions", () => {
    const rule = FUND_RULES.find((r) => r.dirName === "session-init");
    expect(rule!.content).toMatch(/autonomous scheduled/i);
  });
```

If existing tests that assert specific old steps fail, remove those tests (the steps no longer exist).

- [ ] **Step 4: Run tests**

Run: `pnpm test -- tests/skills.test.ts`
Expected: PASS — all skills tests green.

- [ ] **Step 5: Propagate to existing funds**

Run: `pnpm dev -- fund upgrade --all`
Expected: each fund (Growth, prueba, runway-metal, pm-survivor, fundx-audit) reports `8 skills written` and the new `session-init` rule lands on disk under `~/.fundx/funds/<name>/.claude/rules/session-init.md`.

- [ ] **Step 6: Verify the rule on disk**

Run: `head -20 ~/.fundx/funds/prueba/.claude/rules/session-init.md`
Expected: shows the simplified content starting with `# Session Init`.

- [ ] **Step 7: Type-check**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/skills.ts tests/skills.test.ts
git commit -m "feat(rules): simplify session-init to reference <state_snapshot> envelope"
```

---

## Task 7: Smoke tests + MVP eval verification

**Files:**
- Manual: 3 paper sessions on `fundx-audit` + MVP eval

- [ ] **Step 1: Confirm fundx-audit fund still exists**

Run: `ls ~/.fundx/funds/fundx-audit/ 2>&1 | head -5`
Expected: directory exists with `CLAUDE.md`, `fund_config.yaml`, `state/`, etc. (carryover from Phase 1b).

If missing, recreate via `pnpm dev -- fund clone prueba fundx-audit && pnpm dev -- fund upgrade --name fundx-audit` and skip directly to Step 4 (skip the smoke tests that require seeded positions; the MVP eval still works against any fund).

- [ ] **Step 2: Smoke test 1 — BUY without verdicts → DENIED**

Set the fund's `pre_market` focus to attempt a BUY without first invoking evaluators. Edit `~/.fundx/funds/fundx-audit/fund_config.yaml` `pre_market.focus` to:

```yaml
      focus: AUDIT-SMOKE-1 — Attempt to BUY 1 share of GLD via mcp__broker-local__place_order WITHOUT first invoking trade-evaluator or risk-guardian. The hook should deny. Then end the session and write a brief note to analysis/<today>_smoke1.md describing what the hook said.
```

Run: `pnpm dev -- session run fundx-audit pre_market`
Expected: session completes with status `success` (the hook denial does not crash the session). Verify:

```bash
grep -E "place_order denied|denied:" ~/.fundx/funds/fundx-audit/analysis/*smoke1.md | head -5
```

Should show the hook denial message text. The session_log should NOT show a successful BUY trade (verify `trades_executed` is 0 or that no GLD position was added beyond the existing one).

Revert the focus to its prior content after this test.

- [ ] **Step 3: Smoke test 2 — BUY with verdicts → ALLOWED**

Set the focus to:

```yaml
      focus: AUDIT-SMOKE-2 — Develop a thesis to BUY 1 share of GLD. Invoke trade-evaluator (Task tool) and obtain PROCEED. Invoke risk-guardian (Task tool) and obtain APPROVED. THEN call mcp__broker-local__place_order to BUY 1 share of GLD. Verify the trade succeeds. Write a brief note to analysis/<today>_smoke2.md.
```

Run: `pnpm dev -- session run fundx-audit pre_market`
Expected: session completes; portfolio shows an additional 1 share of GLD (or the trade reaches broker successfully). Verify:

```bash
pnpm dev -- portfolio fundx-audit | grep -E "GLD|Total"
```

Show GLD with at least 2 shares (was 1 from seed in Phase 1b + 1 added).

If the trade was denied: inspect the analysis note + session_log to understand why (e.g., did the agent emit TICKER+SIDE in the verdicts, did the hook find them).

Revert focus.

- [ ] **Step 4: Smoke test 3 — SELL with only risk-guardian → ALLOWED**

Set the focus to:

```yaml
      focus: AUDIT-SMOKE-3 — Decide to SELL 1 share of GLD (existing position). Invoke risk-guardian (Task tool) and obtain APPROVED for SELL. Do NOT invoke trade-evaluator (this is a sell, evaluator not required by the gate). Call mcp__broker-local__place_order to SELL 1 share of GLD. Verify success. Write brief note to analysis/<today>_smoke3.md.
```

Run: `pnpm dev -- session run fundx-audit pre_market`
Expected: SELL succeeds. Portfolio GLD shares decrease by 1.

Revert focus.

- [ ] **Step 5: Run MVP eval suite**

Run: `pnpm dev -- eval --filter mvp- --json /tmp/phase2-eval.json`
Expected: PASS — all 8 cases green. Eval cases use `runAsk`/`runChatTurn` (not `runFundSession` hooks), so should be unaffected by hook wiring. Verify all 8 PASS.

If any case FAIL: inspect the JSON report for the case + investigate. Likely root cause if it fails: the snapshot pre-population added too much context / changed the eval baseline. Mitigation: eval uses ephemeral funds with empty state, so snapshot should be mostly `(none)` placeholders — minimal context delta.

- [ ] **Step 6: Update audit-log style doc + commit**

Append to `docs/superpowers/audit-1b/audit-log.md` (reusing the existing audit log file as a Phase 2 verification ledger):

```markdown

---

## Phase 2 verification — 2026-04-28

| Test | Result | Cost | Notes |
|---|---|---:|---|
| Smoke 1 (BUY without verdicts → denied) | PASS / FAIL | $X.XX | Hook denial message captured in smoke1.md |
| Smoke 2 (BUY with verdicts → allowed) | PASS / FAIL | $X.XX | GLD position +1 share confirmed |
| Smoke 3 (SELL with only guardian → allowed) | PASS / FAIL | $X.XX | GLD position -1 share confirmed |
| MVP eval suite | 8/8 PASS | ~$2-3 | No regression |
| **Phase 2 cumulative** | | $XX.XX | |
```

Fill in the actual costs from each session's `session_log.json` and the eval report.

```bash
git add docs/superpowers/audit-1b/audit-log.md
git commit -m "audit(phase-2): smoke tests + MVP eval verification"
```

---

## Task 8: Documentation + roadmap status

**Files:**
- Modify: `CLAUDE.md` (one-line mention)
- Modify: `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md` (status log)

- [ ] **Step 1: Update CLAUDE.md "Configuration" section**

In `CLAUDE.md`, find the "Configuration" section and add a new bullet after the existing "Budgets:" bullet:

```markdown
- State pre-population + verdict gate: every autonomous session receives a `<state_snapshot>` envelope (handoff + portfolio + objective + pending + top-10 trades + top-10 watchlist) in its first user message. A `PreToolUse` hook on `mcp__broker-local__place_order` denies BUY without both `trade-evaluator` PROCEED + `risk-guardian` APPROVED, and SELL without `risk-guardian` APPROVED. See `src/services/snapshot.service.ts` and `src/services/verdict-tracker.ts`.
```

- [ ] **Step 2: Update roadmap status log**

In `docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md`, find the "Status log" table at the bottom. Append:

```markdown
| 2026-04-28 | Phase 2 complete: G3 closed via `<state_snapshot>` pre-population in `runFundSession`; G1 closed via `PreToolUse` hook on `place_order` requiring evaluator+guardian APPROVED (BUY) or guardian-only APPROVED (SELL). 3 smoke tests + MVP eval green. New components: `src/services/verdict-tracker.ts`, `src/services/snapshot.service.ts`. `session-init` rule simplified. See [phase-2 spec](./2026-04-27-harness-phase-2-design.md). |
```

- [ ] **Step 3: Commit docs**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-04-27-harness-hardening-roadmap.md
git commit -m "docs: phase 2 complete — snapshot pre-population + verdict gate hook"
```

- [ ] **Step 4: Final test sweep**

Run: `pnpm test && pnpm typecheck`
Expected: PASS, 0 errors.

---

## Self-Review Checklist (before marking phase complete)

After all 8 tasks complete:

- [ ] `pnpm test` is green (full suite).
- [ ] `pnpm typecheck` is clean.
- [ ] `pnpm lint` is clean (or warnings are pre-existing).
- [ ] `pnpm build` succeeds.
- [ ] `git log --oneline -10` shows ~8 commits with descriptive messages.
- [ ] Smoke tests 1, 2, 3 actually executed (not just reasoned about).
- [ ] MVP eval 8/8 PASS post-merge.
- [ ] `CLAUDE.md` reflects the new mechanism.
- [ ] Roadmap status log updated with Phase 2 entry.

If any item is not true, the phase is **not** done.
