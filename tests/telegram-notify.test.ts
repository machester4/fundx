import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for src/mcp/telegram-notify.ts
 *
 * We mock:
 * - @modelcontextprotocol/sdk/server/mcp.js   — capture tool handlers without a real MCP server
 * - @modelcontextprotocol/sdk/server/stdio.js  — prevent stdio transport setup
 * - globalThis.fetch                           — assert Telegram API calls
 *
 * We test:
 * - isEnabled / isInQuietHours / isSuppressedByQuietHours helper logic
 * - Every tool: flag guard, quiet-hours suppression, actual send payload
 * - Critical vs. non-critical quiet-hours bypass (allow_critical)
 */

// ── Tool handler capture ──────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

// vi.hoisted ensures this Map is initialized before vi.mock factories run
const { toolHandlers } = vi.hoisted(() => ({
  toolHandlers: new Map<string, ToolHandler>(),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    tool: vi.fn(
      (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        toolHandlers.set(name, handler);
      },
    ),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => ({})),
}));

// ── Import AFTER mocks (module runs main() at load time) ──────

import {
  isEnabled,
  isInQuietHours,
  isSuppressedByQuietHours,
} from "../src/mcp/telegram-notify.js";

// ── Env + fetch helpers ───────────────────────────────────────

const NOTIFY_FLAGS = [
  "NOTIFY_TRADE_ALERTS",
  "NOTIFY_STOP_LOSS_ALERTS",
  "NOTIFY_DAILY_DIGEST",
  "NOTIFY_WEEKLY_DIGEST",
  "NOTIFY_MILESTONE_ALERTS",
  "NOTIFY_DRAWDOWN_ALERTS",
  "QUIET_HOURS_START",
  "QUIET_HOURS_END",
  "QUIET_HOURS_ALLOW_CRITICAL",
];

function clearEnv() {
  ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", ...NOTIFY_FLAGS].forEach(
    (k) => delete process.env[k],
  );
}

function setEnv(vars: Record<string, string>) {
  Object.assign(process.env, vars);
}

const BASE_ENV = { TELEGRAM_BOT_TOKEN: "bot:TOKEN", TELEGRAM_CHAT_ID: "42" };

const fetchMock = vi.fn();

function mockTelegramOk() {
  fetchMock.mockResolvedValue({
    json: async () => ({ ok: true, result: {} }),
  });
}

function suppressed(reason: string) {
  return { content: [{ type: "text", text: `Notification suppressed: ${reason}.` }] };
}

function tool(name: string) {
  const handler = toolHandlers.get(name);
  if (!handler) throw new Error(`Tool "${name}" not registered`);
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearEnv();
  setEnv(BASE_ENV);
  mockTelegramOk();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── isEnabled ─────────────────────────────────────────────────

describe("isEnabled", () => {
  it("returns true when env var is unset", () => {
    expect(isEnabled("NOTIFY_TRADE_ALERTS")).toBe(true);
  });

  it("returns true when env var is 'true'", () => {
    setEnv({ NOTIFY_TRADE_ALERTS: "true" });
    expect(isEnabled("NOTIFY_TRADE_ALERTS")).toBe(true);
  });

  it("returns false when env var is 'false'", () => {
    setEnv({ NOTIFY_TRADE_ALERTS: "false" });
    expect(isEnabled("NOTIFY_TRADE_ALERTS")).toBe(false);
  });
});

// ── isInQuietHours ────────────────────────────────────────────

describe("isInQuietHours", () => {
  it("returns false when env vars are not set", () => {
    expect(isInQuietHours()).toBe(false);
  });

  it("returns true during quiet hours (same-day window)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 14, 30, 0)); // 14:30 local
    setEnv({ QUIET_HOURS_START: "14:00", QUIET_HOURS_END: "16:00" });

    expect(isInQuietHours()).toBe(true);
  });

  it("returns false outside quiet hours (same-day window)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 17, 0, 0)); // 17:00 local
    setEnv({ QUIET_HOURS_START: "14:00", QUIET_HOURS_END: "16:00" });

    expect(isInQuietHours()).toBe(false);
  });

  it("returns true during midnight-wrapping quiet hours (after start)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    expect(isInQuietHours()).toBe(true);
  });

  it("returns true during midnight-wrapping quiet hours (before end)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 5, 0, 0)); // 05:00 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    expect(isInQuietHours()).toBe(true);
  });

  it("returns false outside midnight-wrapping quiet hours", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0)); // 12:00 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    expect(isInQuietHours()).toBe(false);
  });
});

// ── isSuppressedByQuietHours ──────────────────────────────────

describe("isSuppressedByQuietHours", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local — inside quiet hours
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });
  });

  it("suppresses non-critical messages during quiet hours", () => {
    expect(isSuppressedByQuietHours(false)).toBe(true);
  });

  it("suppresses critical messages when allow_critical is off", () => {
    setEnv({ QUIET_HOURS_ALLOW_CRITICAL: "false" });
    expect(isSuppressedByQuietHours(true)).toBe(true);
  });

  it("allows critical messages when allow_critical is on (default)", () => {
    // QUIET_HOURS_ALLOW_CRITICAL unset → isEnabled returns true
    expect(isSuppressedByQuietHours(true)).toBe(false);
  });

  it("allows critical messages when allow_critical is explicitly true", () => {
    setEnv({ QUIET_HOURS_ALLOW_CRITICAL: "true" });
    expect(isSuppressedByQuietHours(true)).toBe(false);
  });

  it("returns false when not in quiet hours regardless of criticality", () => {
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0)); // 12:00 local — outside quiet hours
    expect(isSuppressedByQuietHours(false)).toBe(false);
    expect(isSuppressedByQuietHours(true)).toBe(false);
  });
});

// ── send_message ──────────────────────────────────────────────

describe("send_message tool", () => {
  it("sends message at normal priority", async () => {
    const result = await tool("send_message")({ text: "Hello", parse_mode: "HTML", priority: "normal" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: [{ type: "text", text: "Message sent successfully." }] });
  });

  it("suppresses normal priority during quiet hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    const result = await tool("send_message")({ text: "Hello", parse_mode: "HTML", priority: "normal" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("quiet hours active"));
  });

  it("sends critical priority during quiet hours when allow_critical is on", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00", QUIET_HOURS_ALLOW_CRITICAL: "true" });

    const result = await tool("send_message")({ text: "URGENT", parse_mode: "HTML", priority: "critical" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: [{ type: "text", text: "Message sent successfully." }] });
  });

  it("suppresses critical priority during quiet hours when allow_critical is off", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00", QUIET_HOURS_ALLOW_CRITICAL: "false" });

    const result = await tool("send_message")({ text: "URGENT", parse_mode: "HTML", priority: "critical" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("quiet hours active"));
  });
});

// ── send_trade_alert ──────────────────────────────────────────

const tradeArgs = { fund: "runway", symbol: "GLD", side: "buy", quantity: 10, price: 185.5 };

describe("send_trade_alert tool", () => {
  it("sends alert when flag is enabled (default)", async () => {
    const result = await tool("send_trade_alert")(tradeArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: [{ type: "text", text: "Trade alert sent for GLD." }] });
  });

  it("suppresses when NOTIFY_TRADE_ALERTS=false", async () => {
    setEnv({ NOTIFY_TRADE_ALERTS: "false" });
    const result = await tool("send_trade_alert")(tradeArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("trade_alerts disabled"));
  });

  it("suppresses during quiet hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    const result = await tool("send_trade_alert")(tradeArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("quiet hours active"));
  });

  it("sends correct HTML payload to Telegram", async () => {
    await tool("send_trade_alert")({ ...tradeArgs, reasoning: "Hedge against inflation" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chat_id).toBe("42");
    expect(body.text).toContain("Bought 10 GLD @ $185.50");
    expect(body.text).toContain("Reason: Hedge against inflation");
    expect(body.parse_mode).toBe("HTML");
  });
});

// ── send_stop_loss_alert ──────────────────────────────────────

const stopLossArgs = {
  fund: "runway", symbol: "SLV", trigger_price: 22.5,
  shares: 50, loss: -125, loss_pct: -5.2, action_taken: "Moved to cash",
};

describe("send_stop_loss_alert tool", () => {
  it("sends alert when flag is enabled (default)", async () => {
    const result = await tool("send_stop_loss_alert")(stopLossArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: [{ type: "text", text: "Stop-loss alert sent for SLV." }] });
  });

  it("suppresses when NOTIFY_STOP_LOSS_ALERTS=false", async () => {
    setEnv({ NOTIFY_STOP_LOSS_ALERTS: "false" });
    const result = await tool("send_stop_loss_alert")(stopLossArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("stop_loss_alerts disabled"));
  });

  it("bypasses quiet hours by default (allow_critical=true by default)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    await tool("send_stop_loss_alert")(stopLossArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("respects quiet hours when allow_critical=false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({
      QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00",
      QUIET_HOURS_ALLOW_CRITICAL: "false",
    });

    const result = await tool("send_stop_loss_alert")(stopLossArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("quiet hours active (allow_critical is off)"));
  });
});

// ── send_daily_digest ─────────────────────────────────────────

const digestArgs = {
  fund: "runway", date: "Feb 28", pnl: 120, pnl_pct: 0.4,
  cash_pct: 30, exposure_pct: 70,
};

describe("send_daily_digest tool", () => {
  it("sends digest when flag is enabled (default)", async () => {
    const result = await tool("send_daily_digest")(digestArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: [{ type: "text", text: "Daily digest sent." }] });
  });

  it("suppresses when NOTIFY_DAILY_DIGEST=false", async () => {
    setEnv({ NOTIFY_DAILY_DIGEST: "false" });
    const result = await tool("send_daily_digest")(digestArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("daily_digest disabled"));
  });

  it("suppresses during quiet hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    const result = await tool("send_daily_digest")(digestArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("quiet hours active"));
  });
});

// ── send_weekly_digest ────────────────────────────────────────

const weeklyArgs = {
  fund: "runway", week: "Feb 24 – Feb 28", pnl: 540, pnl_pct: 1.8, total_trades: 3,
};

describe("send_weekly_digest tool", () => {
  it("sends digest when flag is enabled (default)", async () => {
    const result = await tool("send_weekly_digest")(weeklyArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: [{ type: "text", text: "Weekly digest sent." }] });
  });

  it("suppresses when NOTIFY_WEEKLY_DIGEST=false", async () => {
    setEnv({ NOTIFY_WEEKLY_DIGEST: "false" });
    const result = await tool("send_weekly_digest")(weeklyArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("weekly_digest disabled"));
  });

  it("suppresses during quiet hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    const result = await tool("send_weekly_digest")(weeklyArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("quiet hours active"));
  });

  it("sends correct payload including optional fields", async () => {
    await tool("send_weekly_digest")({
      ...weeklyArgs,
      best_trade: "GLD +4.1%",
      worst_trade: "SLV -2.3%",
      objective_status: "Runway: 15.6 months",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain("Feb 24 – Feb 28");
    expect(body.text).toContain("Best: GLD +4.1%");
    expect(body.text).toContain("Worst: SLV -2.3%");
    expect(body.text).toContain("Runway: 15.6 months");
  });
});

// ── send_milestone_alert ──────────────────────────────────────

const milestoneArgs = {
  fund: "growth", milestone: "Reached 50% of target",
  current_value: 15000, initial_value: 10000, target_description: "Target: $20,000 (2x)",
};

describe("send_milestone_alert tool", () => {
  it("sends alert when flag is enabled (default)", async () => {
    const result = await tool("send_milestone_alert")(milestoneArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: [{ type: "text", text: "Milestone alert sent." }] });
  });

  it("suppresses when NOTIFY_MILESTONE_ALERTS=false", async () => {
    setEnv({ NOTIFY_MILESTONE_ALERTS: "false" });
    const result = await tool("send_milestone_alert")(milestoneArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("milestone_alerts disabled"));
  });

  it("suppresses during quiet hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    const result = await tool("send_milestone_alert")(milestoneArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("quiet hours active"));
  });
});

// ── send_drawdown_alert ───────────────────────────────────────

const drawdownArgs = {
  fund: "runway", drawdown_pct: 12, drawdown_usd: 3600,
  peak_value: 30000, current_value: 26400, max_drawdown_pct: 15,
};

describe("send_drawdown_alert tool", () => {
  it("sends alert when flag is enabled (default)", async () => {
    const result = await tool("send_drawdown_alert")(drawdownArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ content: [{ type: "text", text: "Drawdown alert sent." }] });
  });

  it("suppresses when NOTIFY_DRAWDOWN_ALERTS=false", async () => {
    setEnv({ NOTIFY_DRAWDOWN_ALERTS: "false" });
    const result = await tool("send_drawdown_alert")(drawdownArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("drawdown_alerts disabled"));
  });

  it("bypasses quiet hours by default (critical alert)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({ QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00" });

    await tool("send_drawdown_alert")(drawdownArgs);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("respects quiet hours when allow_critical=false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 23, 30, 0)); // 23:30 local
    setEnv({
      QUIET_HOURS_START: "23:00", QUIET_HOURS_END: "07:00",
      QUIET_HOURS_ALLOW_CRITICAL: "false",
    });

    const result = await tool("send_drawdown_alert")(drawdownArgs);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual(suppressed("quiet hours active (allow_critical is off)"));
  });

  it("sends correct payload with drawdown percentage of limit", async () => {
    await tool("send_drawdown_alert")(drawdownArgs); // 12% of 15% limit = 80%

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain("-12.0%");
    expect(body.text).toContain("80% of max allowed drawdown (15%)");
  });
});
