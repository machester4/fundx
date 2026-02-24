import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Telegram REST client ─────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org";

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN must be set");
  return token;
}

function getChatId(): string {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID must be set");
  return chatId;
}

async function telegramRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const token = getBotToken();
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = (await resp.json()) as { ok: boolean; description?: string; result?: unknown };
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description ?? "unknown error"}`);
  }
  return data.result;
}

// ── Quiet hours check ────────────────────────────────────────

function isInQuietHours(): boolean {
  const start = process.env.QUIET_HOURS_START;
  const end = process.env.QUIET_HOURS_END;
  if (!start || !end) return false;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Wraps midnight (e.g. 23:00 -> 07:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

// ── MCP Server ───────────────────────────────────────────────

const server = new McpServer(
  { name: "telegram-notify", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── Tools ────────────────────────────────────────────────────

server.tool(
  "send_message",
  "Send a text message to the user via Telegram. Use HTML parse mode for formatting: <b>bold</b>, <i>italic</i>, <code>code</code>, <pre>preformatted</pre>.",
  {
    text: z.string().describe("Message text (supports HTML formatting)"),
    parse_mode: z
      .enum(["HTML", "MarkdownV2", "Markdown"])
      .default("HTML")
      .describe("Parse mode for message formatting"),
    priority: z
      .enum(["low", "normal", "critical"])
      .default("normal")
      .describe("Message priority. Critical messages bypass quiet hours."),
  },
  async ({ text, parse_mode, priority }) => {
    if (isInQuietHours() && priority !== "critical") {
      return {
        content: [
          {
            type: "text",
            text: "Message suppressed: quiet hours active. Use priority 'critical' to override.",
          },
        ],
      };
    }

    await telegramRequest("sendMessage", {
      chat_id: getChatId(),
      text,
      parse_mode,
    });
    return {
      content: [{ type: "text", text: "Message sent successfully." }],
    };
  },
);

server.tool(
  "send_trade_alert",
  "Send a formatted trade execution alert to the user via Telegram.",
  {
    fund: z.string().describe("Fund name"),
    symbol: z.string().describe("Ticker symbol"),
    side: z.enum(["buy", "sell"]).describe("Trade side"),
    quantity: z.number().positive().describe("Number of shares"),
    price: z.number().positive().describe("Execution price"),
    reasoning: z.string().optional().describe("Brief reasoning for the trade"),
  },
  async ({ fund, symbol, side, quantity, price, reasoning }) => {
    const emoji = side === "buy" ? "🟢" : "🔴";
    const action = side === "buy" ? "Bought" : "Sold";
    const total = (quantity * price).toFixed(2);

    let text = `${emoji} <b>Trade — ${fund}</b>\n`;
    text += `──────────────────────────\n`;
    text += `${action} ${quantity} ${symbol} @ $${price.toFixed(2)}\n`;
    text += `Total: $${total}\n`;
    if (reasoning) text += `Reason: ${reasoning}`;

    await telegramRequest("sendMessage", {
      chat_id: getChatId(),
      text,
      parse_mode: "HTML",
    });
    return {
      content: [{ type: "text", text: `Trade alert sent for ${symbol}.` }],
    };
  },
);

server.tool(
  "send_stop_loss_alert",
  "Send a stop-loss triggered alert to the user via Telegram. This is always sent as critical priority.",
  {
    fund: z.string().describe("Fund name"),
    symbol: z.string().describe("Ticker symbol"),
    trigger_price: z.number().positive().describe("Price at which stop-loss was triggered"),
    shares: z.number().positive().describe("Number of shares closed"),
    loss: z.number().describe("Dollar loss amount (negative number)"),
    loss_pct: z.number().describe("Percentage loss"),
    action_taken: z.string().describe("What was done (e.g. 'Moved to cash')"),
  },
  async ({ fund, symbol, trigger_price, shares, loss, loss_pct, action_taken }) => {
    let text = `⚠️ <b>STOP-LOSS — ${fund}</b>\n`;
    text += `──────────────────────────\n`;
    text += `${symbol} hit stop-loss at $${trigger_price.toFixed(2)} (${loss_pct.toFixed(1)}%)\n`;
    text += `Position closed: ${shares} shares\n`;
    text += `Loss: -$${Math.abs(loss).toFixed(2)}\n`;
    text += `Action: ${action_taken}`;

    // Stop-loss alerts always bypass quiet hours
    await telegramRequest("sendMessage", {
      chat_id: getChatId(),
      text,
      parse_mode: "HTML",
    });
    return {
      content: [
        { type: "text", text: `Stop-loss alert sent for ${symbol}.` },
      ],
    };
  },
);

server.tool(
  "send_daily_digest",
  "Send a daily digest summary to the user via Telegram.",
  {
    fund: z.string().describe("Fund name"),
    date: z.string().describe("Date string (e.g. Feb 22)"),
    pnl: z.number().describe("Daily P&L in dollars"),
    pnl_pct: z.number().describe("Daily P&L percentage"),
    trades_summary: z.string().optional().describe("Summary of trades executed"),
    cash_pct: z.number().describe("Cash allocation percentage"),
    exposure_pct: z.number().describe("Market exposure percentage"),
    top_mover: z.string().optional().describe("Top mover of the day (e.g. 'AGQ +3.2%')"),
    objective_status: z.string().optional().describe("Objective-specific metric (e.g. 'Runway: 15.6 months')"),
  },
  async ({ fund, date, pnl, pnl_pct, trades_summary, cash_pct, exposure_pct, top_mover, objective_status }) => {
    const pnlSign = pnl >= 0 ? "+" : "";
    let text = `📊 <b>Daily Digest — ${fund} (${date})</b>\n`;
    text += `──────────────────────────\n`;
    text += `P&amp;L: ${pnlSign}$${pnl.toFixed(0)} (${pnlSign}${pnl_pct.toFixed(1)}%)\n`;
    if (objective_status) text += `${objective_status}\n`;
    if (trades_summary) text += `Trades: ${trades_summary}\n`;
    text += `Cash: ${cash_pct.toFixed(0)}% | Exposure: ${exposure_pct.toFixed(0)}%\n`;
    if (top_mover) text += `Top mover: ${top_mover}`;

    await telegramRequest("sendMessage", {
      chat_id: getChatId(),
      text,
      parse_mode: "HTML",
    });
    return {
      content: [{ type: "text", text: "Daily digest sent." }],
    };
  },
);

server.tool(
  "send_milestone_alert",
  "Send an objective milestone alert to the user via Telegram.",
  {
    fund: z.string().describe("Fund name"),
    milestone: z.string().describe("Milestone description (e.g. 'Reached 50% of target')"),
    current_value: z.number().describe("Current fund value"),
    initial_value: z.number().describe("Initial fund value"),
    target_description: z.string().describe("Target description (e.g. 'Target: $20,000 (2x)')"),
  },
  async ({ fund, milestone, current_value, initial_value, target_description }) => {
    const gain_pct = (((current_value - initial_value) / initial_value) * 100).toFixed(0);
    let text = `🎯 <b>Milestone — ${fund}</b>\n`;
    text += `──────────────────────────\n`;
    text += `${milestone}\n`;
    text += `$${initial_value.toLocaleString()} → $${current_value.toLocaleString()} (+${gain_pct}%)\n`;
    text += target_description;

    await telegramRequest("sendMessage", {
      chat_id: getChatId(),
      text,
      parse_mode: "HTML",
    });
    return {
      content: [{ type: "text", text: "Milestone alert sent." }],
    };
  },
);

// ── Start ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("telegram-notify MCP server error:", err);
  process.exit(1);
});
