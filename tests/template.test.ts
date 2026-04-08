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
    broker: { mode: "paper" },
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

    expect(content).toContain("# Test Fund");
    expect(content).toContain("senior portfolio manager running Test Fund");
    expect(content).toContain("Cautious and analytical.");
  });

  // --- Objective types ---

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

  it("includes correct objective for custom type", async () => {
    const config = makeConfig({
      objective: { type: "custom", description: "Outperform the S&P 500 by 5% annually." },
    });
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Outperform the S&P 500 by 5% annually.");
  });

  // --- XML tags ---

  it("wraps objective in <fund_objective> XML tags", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("<fund_objective>");
    expect(content).toContain("</fund_objective>");
  });

  it("wraps risk constraints in <hard_constraints> XML tags", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("<hard_constraints>");
    expect(content).toContain("</hard_constraints>");
  });

  it("wraps frameworks in <frameworks> XML tags", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("<frameworks>");
    expect(content).toContain("</frameworks>");
  });

  // --- New sections ---

  it("contains Investment Frameworks section", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("## Investment Frameworks");
  });

  it("contains Drawdown Recovery table", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Drawdown Recovery");
    expect(content).toContain("-50%");
    expect(content).toContain("+100%");
    expect(content).toContain("mathematically unreachable");
  });

  it("contains Pre-Trade Checklist with 10 items", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Pre-Trade Checklist");
    expect(content).toContain("Written thesis");
    expect(content).toContain("EV positive");
    expect(content).toContain("Journal consulted");
    expect(content).toContain("Risk-guardian passed");
    expect(content).toContain("Stop-loss defined");
    expect(content).toContain("Pre-mortem done");
  });

  it("contains Behavioral Bias Watchlist", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Behavioral Bias Watchlist");
    expect(content).toContain("Anchoring");
    expect(content).toContain("Confirmation");
    expect(content).toContain("Loss aversion");
    expect(content).toContain("FOMO");
    expect(content).toContain("Disposition effect");
    expect(content).toContain("Herding");
  });

  it("contains Survival Question", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Survival Question");
    expect(content).toContain("completely wrong about everything");
    expect(content).toContain("does the fund survive");
  });

  it("contains Decision Hierarchy", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Decision Hierarchy");
    expect(content).toContain("Hard risk limits");
  });

  it("contains Regime Classification", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Regime Classification");
    expect(content).toContain("Risk-On");
    expect(content).toContain("Risk-Off");
    expect(content).toContain("Crisis");
  });

  it("contains Position Sizing Flow", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Position Sizing");
    expect(content).toContain("half_kelly");
    expect(content).toContain("TWO sizing methods");
  });

  // --- Mental Models (9 total) ---

  it("contains 9 mental models including new ones", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    // Original 6
    expect(content).toContain("Second-order thinking");
    expect(content).toContain("Base rates");
    expect(content).toContain("Asymmetric risk/reward");
    expect(content).toContain("Margin of safety");
    expect(content).toContain("Regime awareness");
    expect(content).toContain("Probabilistic thinking");
    // New 3
    expect(content).toContain("Second-level thinking");
    expect(content).toContain("Howard Marks");
    expect(content).toContain("Antifragility");
    expect(content).toContain("Taleb");
    expect(content).toContain("Via negativa");
  });

  // --- 8-step Session Protocol with risk-guardian ---

  it("contains 8-step session protocol with risk-guardian", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("## Session Protocol");
    expect(content).toContain("Orient");
    expect(content).toContain("Analyze");
    expect(content).toContain("Decide");
    expect(content).toContain("Validate");
    expect(content).toContain("Execute");
    expect(content).toContain("Reflect");
    expect(content).toContain("Communicate");
    expect(content).toContain("Follow-up");
    expect(content).toContain("risk-guardian");
    // 8 numbered steps
    expect(content).toContain("8. **Follow-up**");
  });

  // --- Anti-hallucination directive ---

  it("contains anti-hallucination directive", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Never cite a price");
  });

  // --- Spanish communication rule ---

  it("contains Spanish communication rule", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Communicate with the user in Spanish via Telegram and chat");
  });

  // --- default_to_action block ---

  it("contains <default_to_action> block", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("<default_to_action>");
    expect(content).toContain("</default_to_action>");
    expect(content).toContain("Act decisively within your constraints");
  });

  // --- Risk constraints ---

  it("includes risk constraints with correct values", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("Max drawdown: 15%");
    expect(content).toContain("Max position size: 25%");
    expect(content).toContain("Stop loss: 8%");
  });

  it("includes drawdown budget tiers inside hard_constraints", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    const constraintsStart = content.indexOf("<hard_constraints>");
    const constraintsEnd = content.indexOf("</hard_constraints>");
    const constraintsBlock = content.slice(constraintsStart, constraintsEnd);
    expect(constraintsBlock).toContain("50-75%");
    expect(constraintsBlock).toContain("half sizing");
    expect(constraintsBlock).toContain("no new positions");
  });

  it("includes correlation rule inside hard_constraints", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    const constraintsStart = content.indexOf("<hard_constraints>");
    const constraintsEnd = content.indexOf("</hard_constraints>");
    const constraintsBlock = content.slice(constraintsStart, constraintsEnd);
    expect(constraintsBlock).toContain("0.7 correlation");
  });

  it("includes verify-all-constraints enforcement inside hard_constraints", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    const constraintsStart = content.indexOf("<hard_constraints>");
    const constraintsEnd = content.indexOf("</hard_constraints>");
    const constraintsBlock = content.slice(constraintsStart, constraintsEnd);
    expect(constraintsBlock).toContain("verify ALL constraints");
    expect(constraintsBlock).toContain("abort and log reason");
  });

  it("includes allowed tickers", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("SPY, QQQ");
  });

  it("includes custom rules inside hard_constraints", async () => {
    const config = makeConfig({
      risk: {
        profile: "moderate",
        custom_rules: ["No biotech stocks", "Max 3 open positions"],
      },
    });
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    const constraintsStart = content.indexOf("<hard_constraints>");
    const constraintsEnd = content.indexOf("</hard_constraints>");
    const constraintsBlock = content.slice(constraintsStart, constraintsEnd);
    expect(constraintsBlock).toContain("No biotech stocks");
    expect(constraintsBlock).toContain("Max 3 open positions");
  });

  // --- Personality in identity ---

  it("includes personality in identity section", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    // Personality should appear near the top, in Identity section
    const identityIdx = content.indexOf("# Test Fund");
    const objectiveIdx = content.indexOf("## Objective");
    const identityBlock = content.slice(identityIdx, objectiveIdx);
    expect(identityBlock).toContain("Cautious and analytical.");
  });

  // --- No inline skills ---

  it("does not embed skills inline — they are loaded from .claude/skills/ by the Agent SDK", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).not.toContain("## Advanced Analysis Skills");
    expect(content).not.toContain("Investment Debate");
    expect(content).not.toContain("Risk Assessment Matrix");
  });

  // --- Section ordering ---

  it("sections appear in correct order: Identity → Objective → Philosophy → Frameworks → Constraints → Protocol → State Files → Mental Models", async () => {
    const config = makeConfig({
      claude: { model: "sonnet", personality: "Sharp.", decision_framework: "Value-driven analysis." },
    });
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;

    const identityIdx = content.indexOf("# ");
    const objectiveIdx = content.indexOf("## Objective");
    const philosophyIdx = content.indexOf("## Investment Philosophy");
    const frameworksIdx = content.indexOf("## Investment Frameworks");
    const constraintsIdx = content.indexOf("## Risk Constraints");
    const protocolIdx = content.indexOf("## Session Protocol");
    const stateIdx = content.indexOf("## State Files");
    const mentalIdx = content.indexOf("## Mental Models");

    expect(identityIdx).toBeGreaterThan(-1);
    expect(objectiveIdx).toBeGreaterThan(-1);
    expect(philosophyIdx).toBeGreaterThan(-1);
    expect(frameworksIdx).toBeGreaterThan(-1);
    expect(constraintsIdx).toBeGreaterThan(-1);
    expect(protocolIdx).toBeGreaterThan(-1);
    expect(stateIdx).toBeGreaterThan(-1);
    expect(mentalIdx).toBeGreaterThan(-1);

    expect(identityIdx).toBeLessThan(objectiveIdx);
    expect(objectiveIdx).toBeLessThan(philosophyIdx);
    expect(philosophyIdx).toBeLessThan(frameworksIdx);
    expect(frameworksIdx).toBeLessThan(constraintsIdx);
    expect(constraintsIdx).toBeLessThan(protocolIdx);
    expect(protocolIdx).toBeLessThan(stateIdx);
    expect(stateIdx).toBeLessThan(mentalIdx);
  });

  it("section ordering works without decision_framework (no Philosophy section)", async () => {
    const config = makeConfig();
    await generateFundClaudeMd(config);

    const content = mockedWriteFile.mock.calls[0][1] as string;

    const objectiveIdx = content.indexOf("## Objective");
    const frameworksIdx = content.indexOf("## Investment Frameworks");
    const constraintsIdx = content.indexOf("## Risk Constraints");
    const protocolIdx = content.indexOf("## Session Protocol");
    const stateIdx = content.indexOf("## State Files");
    const mentalIdx = content.indexOf("## Mental Models");

    // Philosophy is optional, so skip it when not present
    expect(content).not.toContain("## Investment Philosophy");

    expect(objectiveIdx).toBeLessThan(frameworksIdx);
    expect(frameworksIdx).toBeLessThan(constraintsIdx);
    expect(constraintsIdx).toBeLessThan(protocolIdx);
    expect(protocolIdx).toBeLessThan(stateIdx);
    expect(stateIdx).toBeLessThan(mentalIdx);
  });
});
