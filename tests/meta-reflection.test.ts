import { describe, it, expect } from "vitest";
import { lastConsolidationStateSchema } from "../src/types.js";
import { fundPaths } from "../src/paths.js";

describe("lastConsolidationStateSchema", () => {
  it("parses a valid state object", () => {
    const valid = {
      cursor_iso: "2026-05-04T18:00:00.000Z",
      last_run_iso: "2026-05-04T18:00:00.000Z",
      status: "success",
      n_handoffs_processed: 12,
      n_journal_entries: 3,
      n_lessons_written: 4,
      cost_usd: 0.45,
    };
    expect(() => lastConsolidationStateSchema.parse(valid)).not.toThrow();
  });

  it("rejects bad ISO date", () => {
    const bad = {
      cursor_iso: "not-a-date",
      last_run_iso: "2026-05-04T18:00:00.000Z",
      status: "success",
      n_handoffs_processed: 0,
      n_journal_entries: 0,
      n_lessons_written: 0,
      cost_usd: 0,
    };
    expect(() => lastConsolidationStateSchema.parse(bad)).toThrow();
  });

  it("rejects unknown status", () => {
    const bad = {
      cursor_iso: "2026-05-04T18:00:00.000Z",
      last_run_iso: "2026-05-04T18:00:00.000Z",
      status: "weird",
      n_handoffs_processed: 0,
      n_journal_entries: 0,
      n_lessons_written: 0,
      cost_usd: 0,
    };
    expect(() => lastConsolidationStateSchema.parse(bad)).toThrow();
  });
});

describe("fundPaths.state.lastConsolidation", () => {
  it("points to state/last_consolidation.json under the fund root", () => {
    const paths = fundPaths("test-fund");
    expect(paths.state.lastConsolidation).toMatch(
      /funds\/test-fund\/state\/last_consolidation\.json$/,
    );
  });
});
