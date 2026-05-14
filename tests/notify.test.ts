import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node-notifier", () => ({
  default: { notify: vi.fn() },
}));

import notifier from "node-notifier";
import {
  notifyTrade,
  notifyStopLoss,
  notifyDailyCap,
  notifySupervisorStale,
  notifyHandoffMissing,
  __setQuietHoursForTest,
} from "../src/services/notify.service.js";

const notifySpy = notifier.notify as unknown as ReturnType<typeof vi.fn>;

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("notify.service", () => {
  beforeEach(() => {
    notifySpy.mockReset();
    __setQuietHoursForTest(null);
  });

  it("notifyTrade emits an OS notification with fund/side/qty/price", async () => {
    notifyTrade("alpha", "buy", "AAPL", 10, 180.5);
    await flush();
    expect(notifySpy).toHaveBeenCalledTimes(1);
    const call = notifySpy.mock.calls[0][0];
    expect(call.title).toMatch(/alpha/i);
    expect(call.message).toMatch(/AAPL/);
    expect(call.message).toMatch(/10/);
    expect(call.message).toMatch(/180\.5/);
  });

  it("notifyStopLoss bypasses quiet hours (priority=high)", async () => {
    __setQuietHoursForTest({ now: "23:30", start: "22:00", end: "07:00" });
    notifyStopLoss("alpha", "AAPL", 175.0, "sold 10 @ 174.50");
    await flush();
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("notifyDailyCap is suppressed inside quiet hours", async () => {
    __setQuietHoursForTest({ now: "23:30", start: "22:00", end: "07:00" });
    notifyDailyCap("alpha", 20, 21.5);
    await flush();
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it("notifySupervisorStale bypasses quiet hours", async () => {
    __setQuietHoursForTest({ now: "01:00", start: "22:00", end: "07:00" });
    notifySupervisorStale("alpha", new Date("2026-05-11T00:00:00Z"));
    await flush();
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("notifyHandoffMissing emits with session-type detail", async () => {
    notifyHandoffMissing("alpha", "pre_market");
    await flush();
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0].message).toMatch(/pre_market/);
  });
});
