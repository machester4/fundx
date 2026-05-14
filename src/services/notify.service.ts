import notifier from "node-notifier";
import { loadGlobalConfig } from "../config.js";

export type NotifyPriority = "normal" | "high";

interface QuietHoursOverride {
  now: string;
  start: string;
  end: string;
}

let testOverride: QuietHoursOverride | null = null;

export function __setQuietHoursForTest(override: QuietHoursOverride | null): void {
  testOverride = override;
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function inQuietHours(now: string, start: string, end: string): boolean {
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

async function shouldSuppress(priority: NotifyPriority): Promise<boolean> {
  if (priority === "high") return false;
  if (testOverride) {
    return inQuietHours(testOverride.now, testOverride.start, testOverride.end);
  }
  try {
    const cfg = (await loadGlobalConfig()) as unknown as {
      notifications?: { quiet_hours?: { enabled?: boolean; start?: string; end?: string } };
    };
    const qh = cfg.notifications?.quiet_hours;
    if (!qh || !qh.enabled || !qh.start || !qh.end) return false;
    return inQuietHours(nowHHMM(), qh.start, qh.end);
  } catch {
    return false;
  }
}

function emit(title: string, message: string, priority: NotifyPriority): void {
  void (async () => {
    if (await shouldSuppress(priority)) return;
    notifier.notify({
      title,
      message,
      sound: priority === "high",
      timeout: priority === "high" ? 15 : 8,
    });
  })();
}

export function notifyTrade(
  fund: string,
  side: "buy" | "sell",
  ticker: string,
  qty: number,
  price: number,
): void {
  emit(
    `FundX · ${fund}`,
    `${side.toUpperCase()} ${qty} ${ticker} @ $${price.toFixed(2)}`,
    "normal",
  );
}

export function notifyStopLoss(
  fund: string,
  ticker: string,
  trigger: number,
  action: string,
): void {
  emit(
    `FundX · ${fund} · STOP-LOSS`,
    `${ticker} @ $${trigger.toFixed(2)} — ${action}`,
    "high",
  );
}

export function notifyDailyCap(fund: string, capUsd: number, spentUsd: number): void {
  emit(
    `FundX · ${fund} · daily cap`,
    `Spent $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} cap — sessions paused until 00:00 UTC.`,
    "normal",
  );
}

export function notifySupervisorStale(fund: string, lastHeartbeatAt: Date): void {
  const minutes = Math.round((Date.now() - lastHeartbeatAt.getTime()) / 60000);
  emit(
    `FundX · ${fund} · supervisor stale`,
    `No heartbeat for ${minutes} min. Daemon may be stuck.`,
    "high",
  );
}

export function notifyHandoffMissing(fund: string, sessionType: string): void {
  emit(
    `FundX · ${fund} · handoff missing`,
    `Session ${sessionType} reported success but did not write a fresh handoff.`,
    "normal",
  );
}

export function notifyGeneric(title: string, message: string): void {
  emit(`FundX · ${title}`, message, "normal");
}
