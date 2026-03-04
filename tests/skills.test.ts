import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

import {
  BUILTIN_SKILLS,
  WORKSPACE_SKILL,
  getAllSkillNames,
  getSkillContent,
  ensureSkillFiles,
  ensureFundSkillFiles,
  ensureWorkspaceSkillFiles,
} from "../src/skills.js";
import { writeFile, mkdir } from "node:fs/promises";

const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdir = vi.mocked(mkdir);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BUILTIN_SKILLS", () => {
  it("has 7 fund trading skills", () => {
    expect(BUILTIN_SKILLS).toHaveLength(7);
  });

  it("each skill has required fields", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.name).toBeTruthy();
      expect(skill.dirName).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(skill.description).toBeTruthy();
      expect(skill.content).toBeTruthy();
    }
  });

  it("each trading skill has When to Use section", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content).toContain("## When to Use");
    }
  });

  it("each trading skill has Technique section", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content).toContain("## Technique");
    }
  });

  it("each trading skill has Output section", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content).toContain("## Output");
    }
  });

  it("includes Investment Thesis skill with bull/bear dialectical analysis", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Investment Thesis");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("investment-thesis");
    expect(skill!.content).toContain("Bull Case");
    expect(skill!.content).toContain("Bear Case");
    expect(skill!.content).toContain("Devil's Advocate");
    expect(skill!.content).toContain("Historical Parallel");
    expect(skill!.content).toContain("Conviction Assessment");
  });

  it("includes Risk Assessment skill with expected value and hard constraints", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Risk Assessment");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("risk-assessment");
    expect(skill!.content).toContain("Expected Value");
    expect(skill!.content).toContain("Portfolio Impact");
    expect(skill!.content).toContain("Hard Constraints");
    expect(skill!.content).toContain("Order Specification");
  });

  it("includes Trade Memory skill with SQL queries", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Trade Memory");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("trade-memory");
    expect(skill!.content).toContain("trade_journal.sqlite");
    expect(skill!.content).toContain("trades_fts");
    expect(skill!.content).toContain("Decision Rules");
  });

  it("includes Market Regime skill with classification table", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Market Regime");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("market-regime");
    expect(skill!.content).toContain("Risk-On");
    expect(skill!.content).toContain("Risk-Off");
    expect(skill!.content).toContain("Crisis");
    expect(skill!.content).toContain("Regime Classifications");
  });

  it("includes Position Sizing skill with Kelly criterion", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Position Sizing");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("position-sizing");
    expect(skill!.content).toContain("Kelly Criterion");
    expect(skill!.content).toContain("Fund Type Adjustment");
    expect(skill!.content).toContain("Regime Multiplier");
  });

  it("includes Session Reflection skill with decision audit and bias check", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Session Reflection");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("session-reflection");
    expect(skill!.content).toContain("Decision Audit");
    expect(skill!.content).toContain("Bias Check");
    expect(skill!.content).toContain("Journal Updates");
    expect(skill!.content).toContain("Objective Progress");
  });

  it("includes Portfolio Review skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Portfolio Review");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("portfolio-review");
    expect(skill!.content).toContain("Position-by-Position Review");
    expect(skill!.content).toContain("Portfolio-Level Analysis");
    expect(skill!.content).toContain("Rebalancing Recommendations");
  });
});

describe("WORKSPACE_SKILL", () => {
  it("has required fields", () => {
    expect(WORKSPACE_SKILL.name).toBe("Create Fund");
    expect(WORKSPACE_SKILL.dirName).toBe("create-fund");
    expect(WORKSPACE_SKILL.description).toBeTruthy();
    expect(WORKSPACE_SKILL.content).toBeTruthy();
  });

  it("includes fund_config.yaml schema", () => {
    expect(WORKSPACE_SKILL.content).toContain("fund_config.yaml");
    expect(WORKSPACE_SKILL.content).toContain("personality");
    expect(WORKSPACE_SKILL.content).toContain("decision_framework");
  });

  it("includes creation steps", () => {
    expect(WORKSPACE_SKILL.content).toContain("## Process");
    expect(WORKSPACE_SKILL.content).toContain("## When to Use");
  });
});

describe("getAllSkillNames", () => {
  it("returns names of all 7 fund skills", () => {
    const names = getAllSkillNames();
    expect(names).toHaveLength(7);
    expect(names).toContain("Investment Thesis");
    expect(names).toContain("Risk Assessment");
    expect(names).toContain("Trade Memory");
    expect(names).toContain("Market Regime");
    expect(names).toContain("Position Sizing");
    expect(names).toContain("Session Reflection");
    expect(names).toContain("Portfolio Review");
  });
});

describe("getSkillContent", () => {
  it("returns content for an existing skill", () => {
    const content = getSkillContent("Investment Thesis");
    expect(content).toBeDefined();
    expect(content).toContain("Bull Case");
  });

  it("returns undefined for non-existent skill", () => {
    const content = getSkillContent("Non-Existent Skill");
    expect(content).toBeUndefined();
  });
});

describe("ensureSkillFiles", () => {
  it("creates a subdirectory per skill", async () => {
    await ensureSkillFiles("/test/.claude", BUILTIN_SKILLS);
    // Each skill should create its own subdirectory
    expect(mockedMkdir).toHaveBeenCalledTimes(7);
    for (const skill of BUILTIN_SKILLS) {
      expect(mockedMkdir).toHaveBeenCalledWith(
        expect.stringContaining(skill.dirName),
        expect.any(Object),
      );
    }
  });

  it("writes SKILL.md inside each skill directory", async () => {
    await ensureSkillFiles("/test/.claude", BUILTIN_SKILLS);
    expect(mockedWriteFile).toHaveBeenCalledTimes(7);
    const writtenPaths = mockedWriteFile.mock.calls.map((c) => c[0] as string);
    for (const skill of BUILTIN_SKILLS) {
      expect(writtenPaths.some((p) => p.endsWith(`${skill.dirName}/SKILL.md`))).toBe(true);
    }
  });

  it("writes SKILL.md with YAML frontmatter", async () => {
    await ensureSkillFiles("/test/.claude", [BUILTIN_SKILLS[0]]);
    const content = mockedWriteFile.mock.calls[0][1] as string;
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("name:");
    expect(content).toContain("description:");
    expect(content).toContain("---");
  });
});

describe("ensureFundSkillFiles", () => {
  it("writes all 7 fund skills", async () => {
    await ensureFundSkillFiles("/test/fund/.claude");
    expect(mockedWriteFile).toHaveBeenCalledTimes(7);
  });
});

describe("ensureWorkspaceSkillFiles", () => {
  it("writes only the create-fund skill", async () => {
    await ensureWorkspaceSkillFiles();
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    const writtenPath = mockedWriteFile.mock.calls[0][0] as string;
    expect(writtenPath).toContain("create-fund/SKILL.md");
  });
});
