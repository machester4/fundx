import { writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadFundConfig, listFundNames } from "./fund.js";
import { readPortfolio, readTracker } from "./state.js";
import { openJournal, getTradesInDays } from "./journal.js";
import { fundPaths } from "./paths.js";
import type { FundConfig, Portfolio, ObjectiveTracker, TradeRecord } from "./types.js";

// ── Report Generation ────────────────────────────────────────

interface ReportData {
  fund: FundConfig;
  portfolio: Portfolio;
  tracker: ObjectiveTracker | null;
  trades: TradeRecord[];
  period: "daily" | "weekly" | "monthly";
  date: string;
}

/** Generate a daily report for a fund */
export async function generateDailyReport(fundName: string): Promise<string> {
  const data = await gatherReportData(fundName, "daily", 1);
  const report = formatReport(data);
  const filePath = await saveReport(fundName, "daily", report);
  return filePath;
}

/** Generate a weekly report for a fund */
export async function generateWeeklyReport(fundName: string): Promise<string> {
  const data = await gatherReportData(fundName, "weekly", 7);
  const report = formatReport(data);
  const filePath = await saveReport(fundName, "weekly", report);
  return filePath;
}

/** Generate a monthly report for a fund */
export async function generateMonthlyReport(fundName: string): Promise<string> {
  const data = await gatherReportData(fundName, "monthly", 30);
  const report = formatReport(data);
  const filePath = await saveReport(fundName, "monthly", report);
  return filePath;
}

async function gatherReportData(
  fundName: string,
  period: "daily" | "weekly" | "monthly",
  days: number,
): Promise<ReportData> {
  const config = await loadFundConfig(fundName);
  const portfolio = await readPortfolio(fundName);
  const tracker = await readTracker(fundName).catch(() => null);

  let trades: TradeRecord[] = [];
  try {
    const db = openJournal(fundName);
    try {
      trades = getTradesInDays(db, fundName, days);
    } finally {
      db.close();
    }
  } catch {
    // No journal yet
  }

  return {
    fund: config,
    portfolio,
    tracker,
    trades,
    period,
    date: new Date().toISOString().split("T")[0],
  };
}

function formatReport(data: ReportData): string {
  const { fund, portfolio, tracker, trades, period, date } = data;
  const periodLabel =
    period === "daily" ? "Daily" : period === "weekly" ? "Weekly" : "Monthly";

  const totalReturn = portfolio.total_value - fund.capital.initial;
  const totalReturnPct = (totalReturn / fund.capital.initial) * 100;

  const lines: string[] = [
    `# ${periodLabel} Report — ${fund.fund.display_name}`,
    ``,
    `**Date:** ${date}`,
    `**Period:** ${periodLabel}`,
    `**Status:** ${fund.fund.status}`,
    ``,
    `---`,
    ``,
    `## Portfolio Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Initial Capital | $${fund.capital.initial.toLocaleString()} |`,
    `| Current Value | $${portfolio.total_value.toLocaleString(undefined, { minimumFractionDigits: 2 })} |`,
    `| Total Return | $${totalReturn.toFixed(2)} (${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(2)}%) |`,
    `| Cash | $${portfolio.cash.toLocaleString(undefined, { minimumFractionDigits: 2 })} (${portfolio.total_value > 0 ? ((portfolio.cash / portfolio.total_value) * 100).toFixed(1) : "0.0"}%) |`,
    `| Positions | ${portfolio.positions.length} |`,
    ``,
  ];

  // Objective progress
  if (tracker) {
    lines.push(`## Objective Progress`);
    lines.push(``);
    lines.push(`- **Type:** ${tracker.type}`);
    lines.push(`- **Progress:** ${tracker.progress_pct.toFixed(1)}%`);
    lines.push(`- **Status:** ${tracker.status}`);
    lines.push(``);
  }

  // Positions
  if (portfolio.positions.length > 0) {
    lines.push(`## Open Positions`);
    lines.push(``);
    lines.push(
      `| Symbol | Shares | Avg Cost | Price | Market Value | P&L | P&L % | Weight |`,
    );
    lines.push(`|--------|--------|----------|-------|--------------|-----|-------|--------|`);

    for (const pos of portfolio.positions) {
      const pnlSign = pos.unrealized_pnl >= 0 ? "+" : "";
      lines.push(
        `| ${pos.symbol} | ${pos.shares} | $${pos.avg_cost.toFixed(2)} | $${pos.current_price.toFixed(2)} | $${pos.market_value.toFixed(2)} | ${pnlSign}$${pos.unrealized_pnl.toFixed(2)} | ${pnlSign}${pos.unrealized_pnl_pct.toFixed(1)}% | ${pos.weight_pct.toFixed(1)}% |`,
      );
    }
    lines.push(``);
  }

  // Trades
  if (trades.length > 0) {
    lines.push(`## Trades (${periodLabel})`);
    lines.push(``);
    lines.push(
      `| Date | Side | Symbol | Qty | Price | Total | Type |`,
    );
    lines.push(`|------|------|--------|-----|-------|-------|------|`);

    for (const trade of trades) {
      const tradeDate = trade.timestamp.split("T")[0];
      lines.push(
        `| ${tradeDate} | ${trade.side.toUpperCase()} | ${trade.symbol} | ${trade.quantity} | $${trade.price.toFixed(2)} | $${trade.total_value.toFixed(2)} | ${trade.order_type} |`,
      );
    }
    lines.push(``);

    // Trade summary
    const buys = trades.filter((t) => t.side === "buy");
    const sells = trades.filter((t) => t.side === "sell");
    const closedPnl = sells
      .filter((t) => t.pnl !== undefined && t.pnl !== null)
      .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

    lines.push(`**Trade Summary:**`);
    lines.push(`- Buys: ${buys.length}`);
    lines.push(`- Sells: ${sells.length}`);
    if (closedPnl !== 0) {
      lines.push(
        `- Realized P&L: $${closedPnl.toFixed(2)}`,
      );
    }
    lines.push(``);
  } else {
    lines.push(`## Trades`);
    lines.push(``);
    lines.push(`No trades during this period.`);
    lines.push(``);
  }

  // Risk metrics
  lines.push(`## Risk Profile`);
  lines.push(``);
  lines.push(`- **Profile:** ${fund.risk.profile}`);
  lines.push(`- **Max Drawdown Limit:** ${fund.risk.max_drawdown_pct}%`);
  lines.push(`- **Max Position Size:** ${fund.risk.max_position_pct}%`);
  lines.push(`- **Stop Loss:** ${fund.risk.stop_loss_pct}%`);

  // Overweight warnings
  const overweight = portfolio.positions.filter(
    (p) => p.weight_pct > fund.risk.max_position_pct,
  );
  if (overweight.length > 0) {
    lines.push(``);
    lines.push(`**Overweight Positions:**`);
    for (const p of overweight) {
      lines.push(
        `- ${p.symbol}: ${p.weight_pct.toFixed(1)}% (limit: ${fund.risk.max_position_pct}%)`,
      );
    }
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(`*Generated by FundX on ${new Date().toISOString()}*`);

  return lines.join("\n");
}

async function saveReport(
  fundName: string,
  period: "daily" | "weekly" | "monthly",
  content: string,
): Promise<string> {
  const paths = fundPaths(fundName);
  const date = new Date().toISOString().split("T")[0];
  const dir = join(paths.reports, period);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${date}.md`);
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

// ── CLI Commands ───────────────────────────────────────────────

export const reportCommand = new Command("report").description(
  "View and generate fund reports",
);

reportCommand
  .command("generate")
  .description("Generate a report for a fund")
  .argument("<fund>", "Fund name")
  .option("-d, --daily", "Generate daily report")
  .option("-w, --weekly", "Generate weekly report")
  .option("-m, --monthly", "Generate monthly report")
  .action(
    async (
      fundName: string,
      opts: { daily?: boolean; weekly?: boolean; monthly?: boolean },
    ) => {
      try {
        if (opts.weekly) {
          const file = await generateWeeklyReport(fundName);
          console.log(chalk.green(`  ✓ Weekly report: ${file}\n`));
        } else if (opts.monthly) {
          const file = await generateMonthlyReport(fundName);
          console.log(chalk.green(`  ✓ Monthly report: ${file}\n`));
        } else {
          const file = await generateDailyReport(fundName);
          console.log(chalk.green(`  ✓ Daily report: ${file}\n`));
        }
      } catch (err) {
        console.error(chalk.red(`  Error: ${err}`));
      }
    },
  );

reportCommand
  .command("view")
  .description("View a report")
  .argument("<fund>", "Fund name")
  .option("-d, --date <date>", "Report date (YYYY-MM-DD)")
  .option("-w, --weekly", "View weekly report")
  .option("-m, --monthly", "View monthly report")
  .action(
    async (
      fundName: string,
      opts: { date?: string; weekly?: boolean; monthly?: boolean },
    ) => {
      try {
        const paths = fundPaths(fundName);
        const period = opts.monthly
          ? "monthly"
          : opts.weekly
            ? "weekly"
            : "daily";
        const date = opts.date ?? new Date().toISOString().split("T")[0];
        const filePath = join(paths.reports, period, `${date}.md`);

        if (!existsSync(filePath)) {
          console.log(
            chalk.dim(`  No ${period} report found for ${date}.\n`),
          );

          // List available reports
          const dir = join(paths.reports, period);
          if (existsSync(dir)) {
            const files = await readdir(dir);
            if (files.length > 0) {
              console.log(chalk.dim(`  Available reports:`));
              for (const f of files.sort().reverse().slice(0, 10)) {
                console.log(chalk.dim(`    ${f}`));
              }
              console.log();
            }
          }
          return;
        }

        const content = await readFile(filePath, "utf-8");
        console.log();
        console.log(content);
        console.log();
      } catch (err) {
        console.error(chalk.red(`  Error: ${err}`));
      }
    },
  );

reportCommand
  .command("list")
  .description("List available reports for a fund")
  .argument("<fund>", "Fund name")
  .action(async (fundName: string) => {
    try {
      const paths = fundPaths(fundName);
      console.log(
        chalk.bold(`\n  Reports: ${fundName}\n`),
      );

      for (const period of ["daily", "weekly", "monthly"] as const) {
        const dir = join(paths.reports, period);
        if (!existsSync(dir)) continue;

        const files = await readdir(dir);
        const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse();

        if (mdFiles.length > 0) {
          console.log(
            chalk.bold(
              `  ${period.charAt(0).toUpperCase() + period.slice(1)} (${mdFiles.length}):`,
            ),
          );
          for (const f of mdFiles.slice(0, 5)) {
            console.log(`    ${chalk.dim(f)}`);
          }
          if (mdFiles.length > 5) {
            console.log(
              chalk.dim(`    ... and ${mdFiles.length - 5} more`),
            );
          }
          console.log();
        }
      }
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
    }
  });
