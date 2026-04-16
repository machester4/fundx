import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { loadFundConfigForMcp, _resetFundConfigCacheForTests } from "../src/mcp/broker-local.js";

let tmp: string;

const fullConfig = {
  fund: { name: "t", display_name: "T", description: "", created: "2026-01-01", status: "active" },
  capital: { initial: 100_000, currency: "USD" },
  objective: { type: "growth", target_multiple: 2 },
  risk: { profile: "moderate", max_drawdown_pct: 15, max_position_pct: 25, max_leverage: 1, stop_loss_pct: 8, max_daily_loss_pct: 5, correlation_limit: 0.8, custom_rules: [] },
  universe: { preset: "sp500", include_tickers: [], exclude_tickers: [], exclude_sectors: [] },
  schedule: { timezone: "UTC", trading_days: ["MON","TUE","WED","THU","FRI"], sessions: {}, special_sessions: [] },
  broker: { mode: "paper" },
  claude: { personality: "", decision_framework: "" },
  telegram: {},
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fundx-cfg-cache-"));
  process.env.FUND_DIR = tmp;
  _resetFundConfigCacheForTests();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.FUND_DIR;
});

describe("loadFundConfigForMcp — mtime invalidation", () => {
  it("caches reads within a single mtime window", async () => {
    writeFileSync(join(tmp, "fund_config.yaml"), yaml.dump(fullConfig));
    const a = await loadFundConfigForMcp();
    const b = await loadFundConfigForMcp();
    // Object identity — same cached instance
    expect(a).toBe(b);
  });

  it("re-reads after file mtime advances", async () => {
    const p = join(tmp, "fund_config.yaml");
    writeFileSync(p, yaml.dump(fullConfig));
    const a = await loadFundConfigForMcp();
    // Bump mtime forward by 5 seconds
    const newTime = new Date(Date.now() + 5000);
    utimesSync(p, newTime, newTime);
    // Rewrite with a different fund display_name to confirm the re-read happens
    writeFileSync(p, yaml.dump({ ...fullConfig, fund: { ...fullConfig.fund, display_name: "T2" } }));
    utimesSync(p, newTime, newTime);
    const b = await loadFundConfigForMcp();
    expect(b.fund.display_name).toBe("T2");
    expect(a).not.toBe(b);
  });
});
