import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

import { writeFile } from "node:fs/promises";
import { generateFundClaudeMd } from "../src/template.js";
import type { FundConfig } from "../src/types.js";
import { fundConfigSchema } from "../src/types.js";

const mockedWriteFile = vi.mocked(writeFile);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeConfig(overrides: Partial<FundConfig> = {}): FundConfig {
  return fundConfigSchema.parse({
    fund: {
      name: "test-fund",
      display_name: "Test Fund",
      description: "A test",
      created: "2026-01-01",
      status: "active",
    },
    capital: { initial: 10000, currency: "USD" },
    objective: { type: "growth", target_multiple: 3 },
    risk: { profile: "moderate" },
    universe: { allowed: [{ type: "etf", tickers: ["SPY", "QQQ"] }] },
    schedule: { sessions: {} },
    broker: { provider: "alpaca", mode: "paper" },
    claude: { model: "sonnet", personality: "Cautious and analytical." },
    ...overrides,
  });
}

describe("generateFundClaudeMd", () => {
  it("writes a CLAUDE.md file for the fund", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    expect(mockedWriteFile).toHaveBeenCalledOnce();
    const content = mockedWriteFile.mock.calls[0][1] as string;

    expect(content).toContain("# Fund: test-fund");
    expect(content).toContain("Test Fund");
    expect(content).toContain("Cautious and analytical.");
  });

  it("includes correct objective for runway type", async () => {
    const config = makeConfig({
      objective: { type: "runway", target_months: 18, monthly_burn: 2000, min_reserve_months: 3 },
    });
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("$2000/month");
    expect(content).toContain("18 months");
  });

  it("includes correct objective for growth type", async () => {
    const config = makeConfig({
      objective: { type: "growth", target_multiple: 5 },
    });
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("5x");
  });

  it("includes correct objective for accumulation type", async () => {
    const config = makeConfig({
      objective: { type: "accumulation", target_asset: "BTC", target_amount: 1 },
    });
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("1 BTC");
  });

  it("includes correct objective for income type", async () => {
    const config = makeConfig({
      objective: { type: "income", target_monthly_income: 3000 },
    });
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("$3000/month");
  });

  it("includes risk constraints", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Max drawdown: 15%");
    expect(content).toContain("Max position size: 25%");
    expect(content).toContain("Stop loss: 8%");
  });

  it("includes allowed tickers", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("SPY, QQQ");
  });

  it("does not embed skills inline — they are loaded from .claude/skills/ by the Agent SDK", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    // Skills live in .claude/skills/<name>/SKILL.md, not embedded in CLAUDE.md
    expect(content).not.toContain("## Advanced Analysis Skills");
    expect(content).not.toContain("Investment Debate");
    expect(content).not.toContain("Risk Assessment Matrix");
  });

  it("Decision Framework section comes before Session Protocol with no skills section between them", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    const frameworkIdx = content.indexOf("## Decision Framework");
    const protocolIdx = content.indexOf("## Session Protocol");

    expect(frameworkIdx).toBeGreaterThan(-1);
    expect(protocolIdx).toBeGreaterThan(-1);
    expect(frameworkIdx).toBeLessThan(protocolIdx);
    // No skills section between them
    expect(content.indexOf("## Advanced Analysis Skills")).toBe(-1);
  });
});
