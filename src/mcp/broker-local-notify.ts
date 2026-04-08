/**
 * Pure, testable notification helpers for the broker-local MCP server.
 *
 * This module has no MCP dependencies — it can be imported in both
 * the MCP server process and unit tests without any SDK scaffolding.
 */

// ── Quiet Hours (env-var based, matching telegram-notify.ts) ──────────────────

/**
 * Check whether the current time falls inside a quiet-hours window.
 *
 * @param start - "HH:MM" string (e.g. "23:00"), read from env var
 * @param end   - "HH:MM" string (e.g. "07:00"), read from env var
 * @param currentMinutesOverride - optional override for the current time
 *   expressed as minutes since midnight (used in tests to avoid real clock)
 */
export function isInQuietHoursEnv(
  start: string | undefined,
  end: string | undefined,
  currentMinutesOverride?: number,
): boolean {
  if (!start || !end) return false;
  const now =
    currentMinutesOverride ??
    new Date().getHours() * 60 + new Date().getMinutes();
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const startMin = startH! * 60 + startM!;
  const endMin = endH! * 60 + endM!;
  if (startMin <= endMin) return now >= startMin && now < endMin;
  // Midnight-wrapping window (e.g. 23:00 – 07:00)
  return now >= startMin || now < endMin;
}

/**
 * Decide whether to send a notification given quiet-hours state.
 *
 * @param inQuietHours  - true if current time is inside the quiet window
 * @param isCritical    - true for stop-loss / urgent alerts
 * @param allowCritical - true if QUIET_HOURS_ALLOW_CRITICAL=true
 */
export function shouldSendNotification(
  inQuietHours: boolean,
  isCritical: boolean,
  allowCritical: boolean,
): boolean {
  if (!inQuietHours) return true;
  if (isCritical && allowCritical) return true;
  return false;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format a trade alert message in Telegram HTML.
 *
 * @param fund    - Fund display name
 * @param symbol  - Ticker symbol (uppercased)
 * @param side    - "buy" or "sell"
 * @param qty     - Number of shares
 * @param price   - Execution price per share
 * @param reason  - Optional trade thesis / entry reason
 */
export function formatTradeAlert(
  fund: string,
  symbol: string,
  side: "buy" | "sell",
  qty: number,
  price: number,
  reason?: string,
): string {
  const emoji = side === "buy" ? "🟢" : "🔴";
  const action = side === "buy" ? "BUY" : "SELL";
  const total = (qty * price).toFixed(2);
  const lines = [
    `${emoji} <b>${fund}</b> — ${action} ${qty} ${symbol} @ $${price.toFixed(2)}`,
    `Total: $${total}`,
  ];
  if (reason) lines.push(`Reason: ${reason}`);
  return lines.join("\n");
}

/**
 * Format a stop-loss alert message in Telegram HTML.
 *
 * @param fund    - Fund display name
 * @param symbol  - Ticker symbol (uppercased)
 * @param shares  - Number of shares sold
 * @param price   - Execution price per share
 * @param loss    - Dollar loss (negative means a loss)
 * @param lossPct - Percentage loss (negative means a loss)
 */
export function formatStopLossAlert(
  fund: string,
  symbol: string,
  shares: number,
  price: number,
  loss: number,
  lossPct: number,
): string {
  return [
    `⚠️ <b>${fund}</b> — STOP-LOSS ${symbol}`,
    `${shares} shares sold @ $${price.toFixed(2)} (stop triggered)`,
    `Loss: $${loss.toFixed(2)} (${lossPct.toFixed(1)}%)`,
  ].join("\n");
}

// ── Send ──────────────────────────────────────────────────────────────────────

/**
 * Send a message to a Telegram chat via HTTP POST (best-effort).
 *
 * Errors are swallowed — a notification failure must never fail the trade.
 *
 * @param token  - Telegram bot token
 * @param chatId - Telegram chat ID
 * @param text   - HTML-formatted message text
 */
export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch {
    // Best effort — never fail the trade because of a notification error
  }
}
