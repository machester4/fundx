import { writeFile, readFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fundPaths } from "../paths.js";
import { loadFundConfig } from "./fund.service.js";
import { readPortfolio, readTracker } from "../state.js";
import { openJournal, getTradesInDays } from "../journal.js";
import type { FundConfig, Portfolio, ObjectiveTracker, TradeRecord } from "../types.js";

// ── Report Data ─────────────────────────────────────────────

interface ReportData {
  fund: FundConfig;
  portfolio: Portfolio;
  tracker: ObjectiveTracker | null;
  trades: TradeRecord[];
  period: "daily" | "weekly" | "monthly";
  date: string;
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

// ── Report Generation ───────────────────────────────────────

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

// ── Report Queries ──────────────────────────────────────────

export interface ReportListItem {
  period: "daily" | "weekly" | "monthly";
  files: string[];
  totalCount: number;
}

/** List available reports for a fund */
export async function listReports(fundName: string): Promise<ReportListItem[]> {
  const paths = fundPaths(fundName);
  const results: ReportListItem[] = [];

  for (const period of ["daily", "weekly", "monthly"] as const) {
    const dir = join(paths.reports, period);
    if (!existsSync(dir)) continue;

    const files = await readdir(dir);
    const mdFiles = files.filter((f) => f.endsWith(".md")).sort().reverse();

    if (mdFiles.length > 0) {
      results.push({
        period,
        files: mdFiles.slice(0, 5),
        totalCount: mdFiles.length,
      });
    }
  }

  return results;
}

/** Get a specific report content */
export async function getReport(
  fundName: string,
  period: "daily" | "weekly" | "monthly",
  date?: string,
): Promise<{ content: string } | { notFound: true; availableFiles: string[] }> {
  const paths = fundPaths(fundName);
  const reportDate = date ?? new Date().toISOString().split("T")[0];
  const filePath = join(paths.reports, period, `${reportDate}.md`);

  if (!existsSync(filePath)) {
    const dir = join(paths.reports, period);
    let availableFiles: string[] = [];
    if (existsSync(dir)) {
      const files = await readdir(dir);
      availableFiles = files.sort().reverse().slice(0, 10);
    }
    return { notFound: true, availableFiles };
  }

  const content = await readFile(filePath, "utf-8");
  return { content };
}
