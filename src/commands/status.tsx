import React from "react";
import { Box, Text } from "ink";
import { Spinner } from "@inkjs/ui";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { useAsyncAction } from "../hooks/useAsyncAction.js";
import { getAllFundStatuses, getServiceStatuses } from "../services/status.service.js";
import { isDaemonRunning, getDaemonPid } from "../services/daemon.service.js";
import { SUPERVISOR_PID, DAEMON_HEARTBEAT, NEWS_DIR } from "../paths.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { PnlText } from "../components/PnlText.js";
import type { NextCronInfo } from "../types.js";
import { listFundNames, loadFundConfig } from "../services/fund.service.js";

export const description = "Dashboard of all funds and background services";

interface SystemInfo {
  daemon: { running: boolean; pid?: number };
  supervisor: { running: boolean; pid?: number };
  heartbeat: { timestamp: string; fundsChecked: number; ageSeconds: number } | null;
  telegram: boolean;
  marketData: boolean;
  marketDataProvider: string;
  newsDir: boolean;
  nextCron: NextCronInfo | null;
}

async function getSystemInfo(): Promise<SystemInfo> {
  const daemonRunning = await isDaemonRunning();
  const daemonPid = daemonRunning ? (await getDaemonPid()) ?? undefined : undefined;

  let supervisorPid: number | undefined;
  let supervisorRunning = false;
  if (existsSync(SUPERVISOR_PID)) {
    try {
      const raw = JSON.parse(await readFile(SUPERVISOR_PID, "utf-8"));
      supervisorPid = raw.pid;
      process.kill(raw.pid, 0);
      supervisorRunning = true;
    } catch { /* not running */ }
  }

  let heartbeat: SystemInfo["heartbeat"] = null;
  if (existsSync(DAEMON_HEARTBEAT)) {
    try {
      const hb = JSON.parse(await readFile(DAEMON_HEARTBEAT, "utf-8"));
      const age = Math.round((Date.now() - new Date(hb.timestamp).getTime()) / 1000);
      heartbeat = { timestamp: hb.timestamp, fundsChecked: hb.fundsChecked, ageSeconds: age };
    } catch { /* corrupt */ }
  }

  const services = await getServiceStatuses();
  const newsDir = existsSync(NEWS_DIR);

  // Next scheduled session
  let nextCron: NextCronInfo | null = null;
  try {
    const names = await listFundNames();
    const now = new Date();
    for (const name of names) {
      try {
        const config = await loadFundConfig(name);
        if (config.fund.status !== "active") continue;
        for (const [sessionType, session] of Object.entries(config.schedule.sessions)) {
          if (!session.enabled) continue;
          const [hours, minutes] = session.time.split(":").map(Number);
          if (isNaN(hours) || isNaN(minutes)) continue;
          const sessionTime = new Date(now);
          sessionTime.setHours(hours, minutes, 0, 0);
          if (sessionTime <= now) sessionTime.setDate(sessionTime.getDate() + 1);
          const minutesUntil = Math.round((sessionTime.getTime() - now.getTime()) / 60_000);
          if (!nextCron || minutesUntil < nextCron.minutesUntil) {
            nextCron = { fundName: name, sessionType, time: session.time, minutesUntil };
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return {
    daemon: { running: daemonRunning, pid: daemonPid },
    supervisor: { running: supervisorRunning, pid: supervisorPid },
    heartbeat,
    telegram: services.telegram,
    marketData: services.marketData,
    marketDataProvider: services.marketDataProvider,
    newsDir,
    nextCron,
  };
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function Dot({ color }: { color: string }) {
  return <Text color={color}>{"\u25CF"} </Text>;
}

export default function Status() {
  const funds = useAsyncAction(getAllFundStatuses);
  const system = useAsyncAction(getSystemInfo);

  if (funds.isLoading || system.isLoading) return <Spinner label="Loading..." />;
  if (funds.error) return <Text color="red">Error: {funds.error.message}</Text>;

  const sys = system.data;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>FundX Status</Text>

      {/* Background Services */}
      {sys && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Background Services</Text>
          <Box paddingLeft={2} flexDirection="column">
            <Box gap={1}>
              <Dot color={sys.supervisor.running ? "green" : "red"} />
              <Text>Supervisor</Text>
              <Text dimColor>{sys.supervisor.running ? `PID ${sys.supervisor.pid}` : "stopped"}</Text>
            </Box>
            <Box gap={1}>
              <Dot color={sys.daemon.running ? "green" : "red"} />
              <Text>Daemon</Text>
              <Text dimColor>
                {sys.daemon.running ? `PID ${sys.daemon.pid}` : "stopped"}
                {sys.heartbeat ? ` | heartbeat ${formatAge(sys.heartbeat.ageSeconds)} (${sys.heartbeat.fundsChecked} funds)` : ""}
              </Text>
            </Box>
            <Box gap={1}>
              <Dot color={sys.telegram ? "green" : "yellow"} />
              <Text>Telegram</Text>
              <Text dimColor>{sys.telegram ? "connected" : "not configured"}</Text>
            </Box>
            <Box gap={1}>
              <Dot color={sys.marketData ? "green" : "yellow"} />
              <Text>Market Data</Text>
              <Text dimColor>{sys.marketData ? sys.marketDataProvider : "not configured"}</Text>
            </Box>
            <Box gap={1}>
              <Dot color={sys.newsDir ? "green" : "yellow"} />
              <Text>News Feeds</Text>
              <Text dimColor>{sys.newsDir ? "active (RSS cache)" : "not initialized"}</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Next Scheduled Session */}
      {sys?.nextCron && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>Next Scheduled Session</Text>
          <Box paddingLeft={2} gap={1}>
            <Text>{sys.nextCron.fundName}</Text>
            <Text dimColor>{sys.nextCron.sessionType} at {sys.nextCron.time}</Text>
            <Text color="cyan">({sys.nextCron.minutesUntil}m)</Text>
          </Box>
        </Box>
      )}

      {/* Funds */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold dimColor>Funds</Text>
        {!funds.data?.length ? (
          <Box paddingLeft={2}>
            <Text dimColor>No funds yet. Run fundx fund create.</Text>
          </Box>
        ) : (
          funds.data.map((fund) => (
            <Box key={fund.name} flexDirection="column" marginBottom={1} paddingLeft={2}>
              <Box gap={1}>
                <StatusBadge status={fund.status} />
                <Text bold>{fund.displayName}</Text>
                <Text dimColor>({fund.name})</Text>
              </Box>
              <Box paddingLeft={2} gap={1}>
                <Text>${fund.initialCapital.toLocaleString()} → ${fund.currentValue.toLocaleString()}</Text>
                <PnlText value={fund.pnl} percentage={fund.pnlPct} />
              </Box>
              {fund.progressPct !== null && (
                <Box paddingLeft={2}>
                  <Text dimColor>Progress: {fund.progressPct.toFixed(1)}% — {fund.progressStatus}</Text>
                </Box>
              )}
              {fund.positions > 0 && (
                <Box paddingLeft={2}>
                  <Text dimColor>Positions: {fund.positions} | Cash: {fund.cashPct.toFixed(0)}%</Text>
                </Box>
              )}
              {fund.lastSession && (
                <Box paddingLeft={2}>
                  <Text dimColor>Last: {fund.lastSession.type} ({fund.lastSession.startedAt})</Text>
                </Box>
              )}
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
