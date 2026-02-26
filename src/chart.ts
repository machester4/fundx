import { Command } from "commander";
import chalk from "chalk";
import { loadFundConfig } from "./fund.js";
import { readPortfolio, readTracker } from "./state.js";
import { openJournal, getTradesInDays } from "./journal.js";
import type { TradeRecord } from "./types.js";

// ── Terminal Chart Rendering ─────────────────────────────────

const CHART_CHARS = {
  full: "█",
  empty: " ",
  horizontal: "─",
  vertical: "│",
  corner_bl: "└",
  tee_right: "├",
};

interface ChartOptions {
  width: number;
  height: number;
  title?: string;
  showLabels?: boolean;
}

/**
 * Render a simple bar chart in the terminal.
 */
function renderBarChart(
  data: Array<{ label: string; value: number; color?: (s: string) => string }>,
  options: Partial<ChartOptions> = {},
): string {
  const width = options.width ?? 40;
  const maxValue = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const lines: string[] = [];

  if (options.title) {
    lines.push(chalk.bold(`  ${options.title}`));
    lines.push("");
  }

  for (const item of data) {
    const barLength = Math.round((Math.abs(item.value) / maxValue) * width);
    const bar = CHART_CHARS.full.repeat(barLength);
    const colorFn = item.color ?? (item.value >= 0 ? chalk.green : chalk.red);
    const valueStr =
      item.value >= 0
        ? `+${item.value.toFixed(1)}%`
        : `${item.value.toFixed(1)}%`;

    lines.push(
      `  ${item.label.padEnd(8)} ${colorFn(bar)} ${valueStr}`,
    );
  }

  return lines.join("\n");
}

/**
 * Render a sparkline (inline mini chart) for a series of values.
 */
function renderSparkline(values: number[]): string {
  if (values.length === 0) return "";

  const sparkChars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return values
    .map((v) => {
      const normalized = (v - min) / range;
      const index = Math.min(
        Math.floor(normalized * (sparkChars.length - 1)),
        sparkChars.length - 1,
      );
      return sparkChars[index];
    })
    .join("");
}

/**
 * Render an allocation pie chart (text-based).
 */
function renderAllocation(
  items: Array<{ label: string; pct: number; color: (s: string) => string }>,
): string {
  const lines: string[] = [];
  const barWidth = 30;

  for (const item of items) {
    const filled = Math.round((item.pct / 100) * barWidth);
    const empty = barWidth - filled;
    const bar = item.color(CHART_CHARS.full.repeat(filled)) + chalk.dim("░".repeat(empty));
    lines.push(
      `  ${item.label.padEnd(10)} ${bar} ${item.pct.toFixed(1)}%`,
    );
  }

  return lines.join("\n");
}

// ── CLI Commands ───────────────────────────────────────────────

export const chartCommand = new Command("chart").description(
  "Performance charts (terminal-based)",
);

chartCommand
  .command("portfolio")
  .description("Portfolio allocation chart")
  .argument("<fund>", "Fund name")
  .action(async (fundName: string) => {
    try {
      const config = await loadFundConfig(fundName);
      const portfolio = await readPortfolio(fundName);

      console.log(
        chalk.bold(
          `\n  Portfolio Allocation: ${config.fund.display_name}\n`,
        ),
      );

      const colors = [
        chalk.cyan,
        chalk.green,
        chalk.yellow,
        chalk.magenta,
        chalk.blue,
        chalk.red,
        chalk.white,
      ];

      const items: Array<{
        label: string;
        pct: number;
        color: (s: string) => string;
      }> = [];

      // Add positions
      for (let i = 0; i < portfolio.positions.length; i++) {
        const pos = portfolio.positions[i];
        items.push({
          label: pos.symbol,
          pct: pos.weight_pct,
          color: colors[i % colors.length],
        });
      }

      // Add cash
      const cashPct =
        portfolio.total_value > 0
          ? (portfolio.cash / portfolio.total_value) * 100
          : 100;
      items.push({
        label: "Cash",
        pct: cashPct,
        color: chalk.dim,
      });

      console.log(renderAllocation(items));
      console.log(
        chalk.dim(
          `\n  Total: $${portfolio.total_value.toLocaleString(undefined, { minimumFractionDigits: 2 })}\n`,
        ),
      );
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
    }
  });

chartCommand
  .command("pnl")
  .description("P&L chart by position")
  .argument("<fund>", "Fund name")
  .action(async (fundName: string) => {
    try {
      const config = await loadFundConfig(fundName);
      const portfolio = await readPortfolio(fundName);

      console.log(
        chalk.bold(`\n  P&L by Position: ${config.fund.display_name}\n`),
      );

      if (portfolio.positions.length === 0) {
        console.log(chalk.dim("  No open positions.\n"));
        return;
      }

      const data = portfolio.positions.map((p) => ({
        label: p.symbol,
        value: p.unrealized_pnl_pct,
      }));

      console.log(renderBarChart(data));
      console.log();
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
    }
  });

chartCommand
  .command("history")
  .description("Portfolio value history sparkline")
  .argument("<fund>", "Fund name")
  .option("-d, --days <days>", "Number of days to look back", "30")
  .action(async (fundName: string, opts: { days: string }) => {
    try {
      const config = await loadFundConfig(fundName);
      const days = parseInt(opts.days, 10);

      // Build a value history from trade journal entries
      const db = openJournal(fundName);
      try {
        const trades = getTradesInDays(db, fundName, days);

        if (trades.length === 0) {
          console.log(chalk.dim("  No trade history for chart.\n"));
          return;
        }

        // Group trades by date and compute a rough cumulative value
        const tradesByDate = new Map<string, TradeRecord[]>();
        for (const t of trades) {
          const date = t.timestamp.split("T")[0];
          const group = tradesByDate.get(date) ?? [];
          if (!tradesByDate.has(date)) tradesByDate.set(date, group);
          group.push(t);
        }

        console.log(
          chalk.bold(
            `\n  Trade Activity: ${config.fund.display_name} (${days}d)\n`,
          ),
        );

        // Show trade volume sparkline
        const sortedDates = [...tradesByDate.keys()].sort();
        const volumes = sortedDates.map(
          (d) => (tradesByDate.get(d) ?? []).length,
        );

        console.log(`  Activity: ${renderSparkline(volumes)}`);
        console.log(
          chalk.dim(
            `  ${sortedDates[0] ?? ""} ${"─".repeat(Math.max(0, volumes.length - 20))} ${sortedDates[sortedDates.length - 1] ?? ""}`,
          ),
        );
        console.log(
          chalk.dim(
            `  ${trades.length} trades over ${sortedDates.length} days\n`,
          ),
        );

        // Show P&L distribution for closed trades
        const closedTrades = trades.filter(
          (t) => t.pnl !== undefined && t.pnl !== null,
        );
        if (closedTrades.length > 0) {
          const pnlData = closedTrades.map((t) => ({
            label: `${t.symbol} ${t.side[0].toUpperCase()}`,
            value: t.pnl_pct ?? 0,
          }));

          console.log(
            renderBarChart(pnlData.slice(0, 15), {
              title: "Closed Trade P&L (%)",
              width: 30,
            }),
          );
          console.log();
        }
      } finally {
        db.close();
      }
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
    }
  });

chartCommand
  .command("overview")
  .description("Full visual overview of a fund")
  .argument("<fund>", "Fund name")
  .action(async (fundName: string) => {
    try {
      const config = await loadFundConfig(fundName);
      const portfolio = await readPortfolio(fundName);
      const tracker = await readTracker(fundName).catch(() => null);

      console.log(
        chalk.bold(
          `\n  ${config.fund.display_name} — Visual Overview\n`,
        ),
      );

      // Total return
      const totalReturn = portfolio.total_value - config.capital.initial;
      const totalReturnPct = (totalReturn / config.capital.initial) * 100;
      const returnColor = totalReturn >= 0 ? chalk.green : chalk.red;

      console.log(
        `  Capital: $${config.capital.initial.toLocaleString()} ${chalk.dim("→")} $${portfolio.total_value.toLocaleString()} ${returnColor(`(${totalReturnPct >= 0 ? "+" : ""}${totalReturnPct.toFixed(1)}%)`)}`,
      );

      // Objective progress bar
      if (tracker) {
        const progressWidth = 30;
        const progressFilled = Math.min(
          Math.round((tracker.progress_pct / 100) * progressWidth),
          progressWidth,
        );
        const progressEmpty = progressWidth - progressFilled;
        const progressBar =
          chalk.cyan(CHART_CHARS.full.repeat(progressFilled)) +
          chalk.dim("░".repeat(progressEmpty));

        console.log(
          `  Objective: ${progressBar} ${tracker.progress_pct.toFixed(1)}% — ${tracker.status}`,
        );
      }

      console.log();

      // Position allocation
      if (portfolio.positions.length > 0) {
        const colors = [
          chalk.cyan,
          chalk.green,
          chalk.yellow,
          chalk.magenta,
          chalk.blue,
          chalk.red,
        ];

        const items = portfolio.positions.map((p, i) => ({
          label: p.symbol,
          pct: p.weight_pct,
          color: colors[i % colors.length],
        }));

        const cashPct =
          portfolio.total_value > 0
            ? (portfolio.cash / portfolio.total_value) * 100
            : 100;
        items.push({ label: "Cash", pct: cashPct, color: chalk.dim });

        console.log(chalk.bold("  Allocation:"));
        console.log(renderAllocation(items));
        console.log();

        // Position P&L
        console.log(chalk.bold("  Position P&L:"));
        const pnlData = portfolio.positions.map((p) => ({
          label: p.symbol,
          value: p.unrealized_pnl_pct,
        }));
        console.log(renderBarChart(pnlData, { width: 25 }));
      } else {
        console.log(chalk.dim("  No open positions."));
      }

      console.log();
    } catch (err) {
      console.error(chalk.red(`  Error: ${err}`));
    }
  });
