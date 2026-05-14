import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { notifyTrade } from "./notify.service.js";

interface CursorState {
  last_trade_id: number;
}

const inMemoryCursor = new Map<string, number>();

export function __resetWatcherStateForTest(): void {
  inMemoryCursor.clear();
}

async function loadCursor(cursorPath: string, fund: string): Promise<number> {
  if (inMemoryCursor.has(fund)) return inMemoryCursor.get(fund)!;
  if (!existsSync(cursorPath)) return 0;
  try {
    const raw = await readFile(cursorPath, "utf8");
    const parsed = JSON.parse(raw) as CursorState;
    inMemoryCursor.set(fund, parsed.last_trade_id ?? 0);
    return parsed.last_trade_id ?? 0;
  } catch {
    return 0;
  }
}

async function saveCursor(cursorPath: string, fund: string, lastId: number): Promise<void> {
  inMemoryCursor.set(fund, lastId);
  const state: CursorState = { last_trade_id: lastId };
  await writeFile(cursorPath, JSON.stringify(state), "utf8");
}

export async function tickTradeWatcher(
  fund: string,
  journalPath: string,
  cursorPath: string,
): Promise<void> {
  if (!existsSync(journalPath)) return;
  const cursor = await loadCursor(cursorPath, fund);
  const db = new Database(journalPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, fund, symbol, side, quantity, price, order_type, session_type
         FROM trades WHERE id > ? ORDER BY id ASC`,
      )
      .all(cursor) as Array<{
        id: number;
        fund: string;
        symbol: string;
        side: "buy" | "sell";
        quantity: number;
        price: number;
        order_type: string;
        session_type: string | null;
      }>;

    let maxId = cursor;
    for (const r of rows) {
      const isStopOrder =
        r.order_type === "stop" || r.order_type === "stop_limit" || r.order_type === "trailing_stop";
      const isStopLossFill = r.session_type === "stop_loss";
      if (!isStopOrder && !isStopLossFill) {
        notifyTrade(fund, r.side, r.symbol, r.quantity, r.price);
      }
      maxId = Math.max(maxId, r.id);
    }

    if (maxId > cursor) {
      await saveCursor(cursorPath, fund, maxId);
    }
  } finally {
    db.close();
  }
}
