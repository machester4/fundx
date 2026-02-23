import { Command } from "commander";
import chalk from "chalk";
import { loadFundConfig } from "./fund.js";
import { openJournal, getRecentTrades, getTradesInDays, getTradesByDate } from "./journal.js";
import type { TradeRecord } from "./types.js";

export const tradesCommand = new Command("trades")
  .description("View trade history")
  .argument("<fund>", "Fund name")
  .option("--today", "Show only today's trades")
  .option("--week", "Show trades from the last 7 days")
  .option("--month", "Show trades from the last 30 days")
  .option("-n, --limit <count>", "Number of trades to show", "20")
  .action(
    async (
      fundName: string,
      opts: { today?: boolean; week?: boolean; month?: boolean; limit: string },
    ) => {
      try {
        const config = await loadFundConfig(fundName);
        const db = openJournal(fundName);

        let trades: TradeRecord[];
        let label: string;

        if (opts.today) {
          const today = new Date().toISOString().split("T")[0];
          trades = getTradesByDate(db, fundName, today);
          label = "Today";
        } else if (opts.week) {
          trades = getTradesInDays(db, fundName, 7);
          label = "Last 7 days";
        } else if (opts.month) {
          trades = getTradesInDays(db, fundName, 30);
          label = "Last 30 days";
        } else {
          const limit = parseInt(opts.limit, 10);
          trades = getRecentTrades(db, fundName, limit);
          label = `Last ${limit} trades`;
        }

        db.close();

        console.log(
          chalk.bold(`\n  Trades: ${config.fund.display_name} (${label})\n`),
        );

        if (trades.length === 0) {
          console.log(chalk.dim("  No trades found.\n"));
          return;
        }

        console.log(
          `  ${chalk.bold(pad("Date", 20))} ${pad("Side", 6)} ${pad("Symbol", 8)} ${pad("Qty", 8)} ${pad("Price", 10)} ${pad("Total", 12)} ${pad("Type", 8)} ${pad("P&L", 12)}`,
        );
        console.log("  " + "─".repeat(84));

        for (const trade of trades) {
          const sideColor = trade.side === "buy" ? chalk.green : chalk.red;
          const date = trade.timestamp.replace("T", " ").slice(0, 19);
          const pnlStr =
            trade.pnl !== null && trade.pnl !== undefined
              ? trade.pnl >= 0
                ? chalk.green(`+$${trade.pnl.toFixed(2)}`)
                : chalk.red(`-$${Math.abs(trade.pnl).toFixed(2)}`)
              : chalk.dim("open");

          console.log(
            `  ${pad(date, 20)} ${sideColor(pad(trade.side.toUpperCase(), 6))} ${pad(trade.symbol, 8)} ${pad(String(trade.quantity), 8)} ${pad(`$${trade.price.toFixed(2)}`, 10)} ${pad(`$${trade.total_value.toFixed(2)}`, 12)} ${pad(trade.order_type, 8)} ${pnlStr}`,
          );

          if (trade.reasoning) {
            console.log(chalk.dim(`    ${trade.reasoning.slice(0, 100)}`));
          }
        }
        console.log();
      } catch (err) {
        console.error(chalk.red(`  Error: ${err}`));
      }
    },
  );

function pad(str: string, width: number): string {
  return str.padEnd(width);
}
