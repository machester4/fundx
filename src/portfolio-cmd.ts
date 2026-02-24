import { Command } from "commander";
import chalk from "chalk";
import { loadFundConfig } from "./fund.js";
import { readPortfolio } from "./state.js";
import { syncPortfolio } from "./sync.js";

export const portfolioCommand = new Command("portfolio")
  .description("View fund portfolio holdings")
  .argument("<fund>", "Fund name")
  .option("--sync", "Sync from broker before displaying")
  .action(async (fundName: string, opts: { sync?: boolean }) => {
    try {
      const config = await loadFundConfig(fundName);

      let portfolio;
      if (opts.sync) {
        try {
          portfolio = await syncPortfolio(fundName);
          console.log(chalk.dim("  Synced from broker.\n"));
        } catch (err) {
          console.log(chalk.yellow(`  Could not sync: ${err}. Showing local state.\n`));
          portfolio = await readPortfolio(fundName);
        }
      } else {
        portfolio = await readPortfolio(fundName);
      }

      console.log(chalk.bold(`\n  Portfolio: ${config.fund.display_name}`));
      console.log(chalk.dim(`  Last updated: ${portfolio.last_updated}\n`));

      // Summary
      const pnl = portfolio.total_value - config.capital.initial;
      const pnlPct = (pnl / config.capital.initial) * 100;
      const pnlStr = pnl >= 0
        ? chalk.green(`+$${pnl.toFixed(2)} (+${pnlPct.toFixed(1)}%)`)
        : chalk.red(`-$${Math.abs(pnl).toFixed(2)} (${pnlPct.toFixed(1)}%)`);

      console.log(`  Total Value:  $${portfolio.total_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
      console.log(`  Cash:         $${portfolio.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })} (${portfolio.total_value > 0 ? ((portfolio.cash / portfolio.total_value) * 100).toFixed(1) : "0.0"}%)`);
      console.log(`  P&L:          ${pnlStr}`);
      console.log();

      if (portfolio.positions.length === 0) {
        console.log(chalk.dim("  No open positions.\n"));
        return;
      }

      // Position headers
      console.log(
        `  ${chalk.bold(pad("Symbol", 8))} ${pad("Shares", 8)} ${pad("Avg Cost", 10)} ${pad("Price", 10)} ${pad("Mkt Value", 12)} ${pad("P&L", 12)} ${pad("P&L %", 8)} ${pad("Weight", 8)} ${pad("Stop", 8)}`,
      );
      console.log("  " + "─".repeat(94));

      for (const pos of portfolio.positions) {
        const pnlColor = pos.unrealized_pnl >= 0 ? chalk.green : chalk.red;
        const stopStr = pos.stop_loss ? `$${pos.stop_loss.toFixed(2)}` : "—";

        console.log(
          `  ${chalk.bold(pad(pos.symbol, 8))} ${pad(String(pos.shares), 8)} ${pad(`$${pos.avg_cost.toFixed(2)}`, 10)} ${pad(`$${pos.current_price.toFixed(2)}`, 10)} ${pad(`$${pos.market_value.toFixed(2)}`, 12)} ${pnlColor(pad(`$${pos.unrealized_pnl.toFixed(2)}`, 12))} ${pnlColor(pad(`${pos.unrealized_pnl_pct.toFixed(1)}%`, 8))} ${pad(`${pos.weight_pct.toFixed(1)}%`, 8)} ${pad(stopStr, 8)}`,
        );
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
    }
  });

function pad(str: string, width: number): string {
  return str.padEnd(width);
}
