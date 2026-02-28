import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DAEMON_LOG } from "../paths.js";
import { listFundNames, loadFundConfig } from "./fund.service.js";
import { readSessionLog } from "../state.js";

export interface DaemonLogsData {
  lines: string[];
  empty: boolean;
  notFound: boolean;
}

/** Get daemon log lines */
export async function getDaemonLogs(lineCount: number): Promise<DaemonLogsData> {
  if (!existsSync(DAEMON_LOG)) {
    return { lines: [], empty: false, notFound: true };
  }

  try {
    const content = await readFile(DAEMON_LOG, "utf-8");
    const allLines = content.trim().split("\n");
    const tail = allLines.slice(-lineCount);

    if (tail.length === 0) {
      return { lines: [], empty: true, notFound: false };
    }

    return { lines: tail, empty: false, notFound: false };
  } catch {
    return { lines: [], empty: false, notFound: true };
  }
}

export interface FundSessionLogData {
  fundDisplayName: string;
  sessionType: string;
  startedAt: string;
  endedAt?: string;
  tradesExecuted: number;
  summary?: string;
}

/** Get session log for a specific fund */
export async function getFundSessionLogs(fundName: string): Promise<FundSessionLogData | null> {
  try {
    const config = await loadFundConfig(fundName);
    const log = await readSessionLog(fundName);

    if (!log) return null;

    return {
      fundDisplayName: config.fund.display_name,
      sessionType: log.session_type,
      startedAt: log.started_at,
      endedAt: log.ended_at,
      tradesExecuted: log.trades_executed,
      summary: log.summary,
    };
  } catch {
    return null;
  }
}

export interface AllSessionLogsData {
  fundName: string;
  fundDisplayName: string;
  sessionType: string;
  startedAt: string;
  endedAt?: string;
  duration: string;
  tradesExecuted: number;
  summary?: string;
}

/** Get all session logs across funds */
export async function getAllSessionLogs(): Promise<AllSessionLogsData[]> {
  const names = await listFundNames();
  const results: AllSessionLogsData[] = [];

  for (const name of names) {
    try {
      const log = await readSessionLog(name);
      if (!log) continue;

      const config = await loadFundConfig(name);
      const elapsed = log.ended_at
        ? formatDuration(new Date(log.started_at), new Date(log.ended_at))
        : "in progress";

      results.push({
        fundName: name,
        fundDisplayName: config.fund.display_name,
        sessionType: log.session_type,
        startedAt: log.started_at,
        endedAt: log.ended_at,
        duration: elapsed,
        tradesExecuted: log.trades_executed,
        summary: log.summary,
      });
    } catch {
      // Skip funds with read errors
    }
  }

  return results;
}

function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}
