import { Command } from "commander";
import chalk from "chalk";
import { listFundNames, loadFundConfig } from "./fund.js";
import { readPortfolio, readTracker, readSessionLog } from "./state.js";

export const statusCommand = new Command("status")
  .description("Dashboard of all funds")
  .action(async () => {
    const names = await listFundNames();

    if (names.length === 0) {
      console.log(chalk.dim("  No funds yet. Run 'fundx fund create'."));
      return;
    }

    console.log(chalk.bold("\n  FundX Dashboard\n"));

    for (const name of names) {
      try {
        const config = await loadFundConfig(name);
        const portfolio = await readPortfolio(name).catch(() => null);
        const tracker = await readTracker(name).catch(() => null);
        const lastSession = await readSessionLog(name);

        const statusIcon =
          config.fund.status === "active"
            ? chalk.green("●")
            : chalk.yellow("◐");

        const pnl = portfolio
          ? portfolio.total_value - config.capital.initial
          : 0;
        const pnlPct = portfolio
          ? ((pnl / config.capital.initial) * 100).toFixed(1)
          : "0.0";
        const pnlStr =
          pnl >= 0
            ? chalk.green(`+$${pnl.toFixed(0)} (+${pnlPct}%)`)
            : chalk.red(`-$${Math.abs(pnl).toFixed(0)} (${pnlPct}%)`);

        console.log(
          `  ${statusIcon} ${chalk.bold(config.fund.display_name)} (${name})`,
        );
        console.log(
          `    Capital: $${config.capital.initial.toLocaleString()} → $${(portfolio?.total_value ?? config.capital.initial).toLocaleString()} ${pnlStr}`,
        );

        if (tracker) {
          console.log(
            `    Progress: ${tracker.progress_pct.toFixed(1)}% — ${tracker.status}`,
          );
        }

        if (portfolio && portfolio.positions.length > 0) {
          console.log(`    Positions: ${portfolio.positions.length}`);
          const cashPct = (
            (portfolio.cash / portfolio.total_value) *
            100
          ).toFixed(0);
          console.log(`    Cash: ${cashPct}%`);
        }

        if (lastSession) {
          console.log(
            chalk.dim(`    Last session: ${lastSession.session_type} (${lastSession.started_at})`),
          );
        }

        console.log();
      } catch {
        console.log(`  ${chalk.red("✗")} ${name} — error reading state\n`);
      }
    }
  });
