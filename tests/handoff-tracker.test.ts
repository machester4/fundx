import { describe, it, expect, beforeEach } from "vitest";
import { writeFile, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffTracker } from "../src/services/handoff-tracker.js";

const tmpDir = join(tmpdir(), `handoff-tracker-test-${Date.now()}`);

beforeEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });
});

describe("HandoffTracker", () => {
  it("checkOnStop returns written:true when file mtime > sessionStartedAt", async () => {
    const handoffPath = join(tmpDir, "handoff.md");
    const startedAtMs = Date.now() - 10_000; // 10 seconds ago
    await writeFile(handoffPath, "fresh content", "utf-8");
    // mtime is now (more recent than startedAtMs)
    const tracker = new HandoffTracker(handoffPath, startedAtMs);
    const out = tracker.checkOnStop();
    expect(out.written).toBe(true);
    expect(tracker.handoffWritten).toBe(true);
  });

  it("checkOnStop returns written:false when file is missing (ENOENT)", () => {
    const handoffPath = join(tmpDir, "nonexistent.md");
    const tracker = new HandoffTracker(handoffPath, Date.now());
    const out = tracker.checkOnStop();
    expect(out.written).toBe(false);
    expect(tracker.handoffWritten).toBe(false);
  });

  it("checkOnStop returns written:false when mtime < sessionStartedAt (stale handoff)", async () => {
    const handoffPath = join(tmpDir, "stale.md");
    await writeFile(handoffPath, "old content", "utf-8");
    // Force mtime to be in the past
    const pastSec = Math.floor((Date.now() - 60_000) / 1000); // 60s ago
    await utimes(handoffPath, pastSec, pastSec);
    const startedAtMs = Date.now(); // started AFTER the file's mtime
    const tracker = new HandoffTracker(handoffPath, startedAtMs);
    const out = tracker.checkOnStop();
    expect(out.written).toBe(false);
  });

  it("handoffWritten field is updated as side effect of checkOnStop", async () => {
    const handoffPath = join(tmpDir, "h.md");
    await writeFile(handoffPath, "x", "utf-8");
    const tracker = new HandoffTracker(handoffPath, Date.now() - 5000);
    expect(tracker.handoffWritten).toBe(false); // initial
    tracker.checkOnStop();
    expect(tracker.handoffWritten).toBe(true); // post-call
  });

  it("constructor stores path and start time", () => {
    const tracker = new HandoffTracker("/some/path", 12345);
    // Internal fields are private; verify by behavior
    const out = tracker.checkOnStop();
    expect(out.written).toBe(false); // path doesn't exist → false (proves stat was attempted)
  });
});
