import { describe, it, expect, beforeEach, vi } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = join(tmpdir(), `fundx-pending-race-test-${Date.now()}`);

vi.mock("../src/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../src/paths.js")>("../src/paths.js");
  return {
    ...actual,
    fundPaths: (name: string) => ({
      root: join(tmpRoot, "funds", name),
      state: {
        dir: join(tmpRoot, "funds", name, "state"),
        pendingSessions: join(tmpRoot, "funds", name, "state", "pending_sessions.json"),
      },
    }),
  };
});

import {
  readPendingSessions,
  writePendingSessions,
  updatePendingSessions,
} from "../src/state.js";

const entry = (id: string) => ({
  id,
  type: "agent_followup" as const,
  focus: "x",
  scheduled_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  source: "agent" as const,
  max_turns: 10,
  max_duration_minutes: 5,
  priority: "high" as const,
});

beforeEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("updatePendingSessions", () => {
  it("applies fn over the CURRENT file contents, not a stale snapshot", async () => {
    await writePendingSessions("f1", [entry("a")]);
    // Simulate a concurrent enqueue happening after a stale read elsewhere:
    await writePendingSessions("f1", [entry("a"), entry("b")]);
    // Removing "a" must preserve the concurrently-added "b".
    await updatePendingSessions("f1", (list) => list.filter((s) => s.id !== "a"));
    expect((await readPendingSessions("f1")).map((s) => s.id)).toEqual(["b"]);
  });

  it("returns the updated list and works on a missing file", async () => {
    const next = await updatePendingSessions("fresh", (list) => [...list, entry("z")]);
    expect(next.map((s) => s.id)).toEqual(["z"]);
    expect((await readPendingSessions("fresh")).map((s) => s.id)).toEqual(["z"]);
  });
});
