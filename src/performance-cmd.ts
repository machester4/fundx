import { Command } from "commander";
import chalk from "chalk";
import { loadFundConfig } from "./fund.js";
import { readPortfolio, readTracker } from "./state.js";
import { openJournal, getTradeSummary, getTradesInDays } from "./journal.js";

export const performanceCommand = new Command("performance")
  .description("View fund performance metrics")
  .argument("<fund>", "Fund name")
  .action(async (fundName: string) => {
    try {
      const config = await loadFundConfig(fundName);
      const portfolio = await readPortfolio(fundName);
      const tracker = await readTracker(fundName).catch(() => null);

      console.log(chalk.bold(`\n  Performance: ${config.fund.display_name}\n`));

      // Portfolio metrics
      const totalReturn = portfolio.total_value - config.capital.initial;
      const totalReturnPct = (totalReturn / config.capital.initial) * 100;
      const returnColor = totalReturn >= 0 ? chalk.green : chalk.red;

      console.log(chalk.bold("  Portfolio"));
      console.log(`  Initial Capital:  $${config.capital.initial.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
      console.log(`  Current Value:    $${portfolio.total_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
      console.log(`  Total Return:     ${returnColor(`$${totalReturn.toFixed(2)} (${totalReturnPct.toFixed(2)}%)`)}`);
      console.log(`  Cash:             $${portfolio.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })} (${portfolio.total_value > 0 ? ((portfolio.cash / portfolio.total_value) * 100).toFixed(1) : "0.0"}%)`);
      console.log(`  Positions:        ${portfolio.positions.length}`);
      console.log();

      // Objective progress
      if (tracker) {
        const statusColors: Record<string, (s: string) => string> = {
          on_track: chalk.green,
          ahead: chalk.green,
          behind: chalk.yellow,
          completed: chalk.cyan,
        };
        const statusColor = statusColors[tracker.status] ?? chalk.white;

        console.log(chalk.bold("  Objective Progress"));
        console.log(`  Type:             ${tracker.type}`);
        console.log(`  Progress:         ${tracker.progress_pct.toFixed(1)}%`);
        console.log(`  Status:           ${statusColor(tracker.status)}`);
        console.log();
      }

      // Trade statistics
      let db;
      try {
        db = openJournal(fundName);
        const summary = getTradeSummary(db, fundName);

        if (summary.total_trades > 0) {
          const winRate =
            summary.total_trades > 0
              ? ((summary.winning_trades / summary.total_trades) * 100).toFixed(1)
              : "0.0";

          console.log(chalk.bold("  Trade Statistics (Closed Trades)"));
          console.log(`  Total Trades:     ${summary.total_trades}`);
          console.log(`  Winning:          ${chalk.green(String(summary.winning_trades))}`);
          console.log(`  Losing:           ${chalk.red(String(summary.losing_trades))}`);
          console.log(`  Win Rate:         ${winRate}%`);
          console.log(`  Total P&L:        ${summary.total_pnl >= 0 ? chalk.green(`+$${summary.total_pnl.toFixed(2)}`) : chalk.red(`-$${Math.abs(summary.total_pnl).toFixed(2)}`)}`);
          console.log(`  Avg P&L %:        ${summary.avg_pnl_pct >= 0 ? chalk.green(`+${summary.avg_pnl_pct.toFixed(2)}%`) : chalk.red(`${summary.avg_pnl_pct.toFixed(2)}%`)}`);
          console.log(`  Best Trade:       ${chalk.green(`+$${summary.best_trade_pnl.toFixed(2)}`)}`);
          console.log(`  Worst Trade:      ${chalk.red(`$${summary.worst_trade_pnl.toFixed(2)}`)}`);
          console.log();
        }

        // Recent activity
        const weekTrades = getTradesInDays(db, fundName, 7);
        const monthTrades = getTradesInDays(db, fundName, 30);

        if (weekTrades.length > 0 || monthTrades.length > 0) {
          console.log(chalk.bold("  Recent Activity"));
          console.log(`  Trades (7d):      ${weekTrades.length}`);
          console.log(`  Trades (30d):     ${monthTrades.length}`);
          console.log();
        }
      } catch {
        // No journal yet — that's fine
      } finally {
        db?.close();
      }

      // Risk profile
      console.log(chalk.bold("  Risk Profile"));
      console.log(`  Profile:          ${config.risk.profile}`);
      console.log(`  Max Drawdown:     ${config.risk.max_drawdown_pct}%`);
      console.log(`  Max Position:     ${config.risk.max_position_pct}%`);
      console.log(`  Stop Loss:        ${config.risk.stop_loss_pct}%`);

      // Check if any position exceeds max weight
      const overweight = portfolio.positions.filter(
        (p) => p.weight_pct > config.risk.max_position_pct,
      );
      if (overweight.length > 0) {
        console.log(chalk.yellow(`\n  ⚠ Overweight positions:`));
        for (const p of overweight) {
          console.log(chalk.yellow(`    ${p.symbol}: ${p.weight_pct.toFixed(1)}% (max: ${config.risk.max_position_pct}%)`));
        }
      }

      console.log();
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
    }
  });
