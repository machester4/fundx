import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

vi.mock("../src/services/notify.service.js", () => ({
  notifyTrade: vi.fn(),
}));

import { notifyTrade } from "../src/services/notify.service.js";
import {
  tickTradeWatcher,
  __resetWatcherStateForTest,
} from "../src/services/trade-watcher.service.js";

describe("trade-watcher", () => {
  let dir: string;
  let journalPath: string;
  let cursorPath: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fundx-watcher-"));
    journalPath = path.join(dir, "trade_journal.sqlite");
    cursorPath = path.join(dir, "last_notify_cursor.json");
    db = new Database(journalPath);
    db.exec(`
      CREATE TABLE trades (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        fund TEXT,
        symbol TEXT,
        side TEXT,
        quantity REAL,
        price REAL,
        order_type TEXT,
        session_type TEXT
      );
    `);
    __resetWatcherStateForTest();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("emits a notification for a new trade row", async () => {
    db.prepare(
      `INSERT INTO trades (timestamp, fund, symbol, side, quantity, price, order_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("2026-05-11T10:00:00Z", "alpha", "AAPL", "buy", 10, 180.5, "market");

    await tickTradeWatcher("alpha", journalPath, cursorPath);
    expect(notifyTrade).toHaveBeenCalledTimes(1);
    expect(notifyTrade).toHaveBeenCalledWith("alpha", "buy", "AAPL", 10, 180.5);
  });

  it("does not re-notify the same trade after restart", async () => {
    db.prepare(
      `INSERT INTO trades (timestamp, fund, symbol, side, quantity, price, order_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("2026-05-11T10:00:00Z", "alpha", "AAPL", "buy", 10, 180.5, "market");

    await tickTradeWatcher("alpha", journalPath, cursorPath);
    __resetWatcherStateForTest();
    await tickTradeWatcher("alpha", journalPath, cursorPath);
    expect(notifyTrade).toHaveBeenCalledTimes(1);
  });

  it("skips stop_loss order_types (handled by stoploss.ts)", async () => {
    db.prepare(
      `INSERT INTO trades (timestamp, fund, symbol, side, quantity, price, order_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("2026-05-11T10:00:00Z", "alpha", "AAPL", "sell", 10, 175.0, "stop");

    await tickTradeWatcher("alpha", journalPath, cursorPath);
    expect(notifyTrade).not.toHaveBeenCalled();
  });

  it("skips trades with session_type=stop_loss even if order_type=market", async () => {
    db.prepare(
      `INSERT INTO trades (timestamp, fund, symbol, side, quantity, price, order_type, session_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("2026-05-11T10:00:00Z", "alpha", "AAPL", "sell", 10, 175.0, "market", "stop_loss");

    await tickTradeWatcher("alpha", journalPath, cursorPath);
    expect(notifyTrade).not.toHaveBeenCalled();
  });
});
