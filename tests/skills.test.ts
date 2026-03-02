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
    const tradingSkills = BUILTIN_SKILLS.filter((s) => s.dirName !== "investment-brainstorming");
    for (const skill of tradingSkills) {
      expect(skill.content).toContain("## When to Use");
    }
  });

  it("each trading skill has Technique section", () => {
    const tradingSkills = BUILTIN_SKILLS.filter((s) => s.dirName !== "investment-brainstorming");
    for (const skill of tradingSkills) {
      expect(skill.content).toContain("## Technique");
    }
  });

  it("each trading skill has Output Format section", () => {
    const tradingSkills = BUILTIN_SKILLS.filter((s) => s.dirName !== "investment-brainstorming");
    for (const skill of tradingSkills) {
      expect(skill.content).toContain("## Output Format");
    }
  });

  it("includes Investment Debate skill with multi-round structure", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Investment Debate");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("investment-debate");
    expect(skill!.content).toContain("Bull Case");
    expect(skill!.content).toContain("Bear Case");
    expect(skill!.content).toContain("Round 1");
    expect(skill!.content).toContain("Round 2 — Rebuttals");
    expect(skill!.content).toContain("Round 3 — Devil's Advocate");
    expect(skill!.content).toContain("Round 4 — Quantitative Judgment");
    expect(skill!.content).toContain("Round 5 — Risk Integration");
    expect(skill!.content).toContain("HARD-GATE");
    expect(skill!.content).toContain("Confidence Calibration");
  });

  it("includes Risk Assessment Matrix skill with quantitative approach", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Risk Assessment Matrix");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("risk-matrix");
    expect(skill!.content).toContain("Expected Value Calculation");
    expect(skill!.content).toContain("Portfolio Impact Analysis");
    expect(skill!.content).toContain("Correlation Check");
    expect(skill!.content).toContain("Hard Constraint Validation");
    expect(skill!.content).toContain("BLOCK the trade");
  });

  it("includes Trade Journal Review skill with SQL queries", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Trade Journal Review");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("trade-memory");
    expect(skill!.content).toContain("trade_journal.sqlite");
    expect(skill!.content).toContain("Database Schema");
    expect(skill!.content).toContain("trades_fts");
    expect(skill!.content).toContain("FTS5 Semantic Search");
    expect(skill!.content).toContain("Win Rate by Trade Type");
  });

  it("includes Market Regime Detection skill with scoring", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Market Regime Detection");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("market-regime");
    expect(skill!.content).toContain("Risk-On");
    expect(skill!.content).toContain("Risk-Off");
    expect(skill!.content).toContain("HARD-GATE");
    expect(skill!.content).toContain("Score Each Indicator");
    expect(skill!.content).toContain("Regime Score");
    expect(skill!.content).toContain("Persist Regime");
  });

  it("includes Position Sizing skill with Kelly criterion", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Position Sizing");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("position-sizing");
    expect(skill!.content).toContain("Debate confidence");
    expect(skill!.content).toContain("Kelly Criterion");
    expect(skill!.content).toContain("Fund Type Adjustment");
    expect(skill!.content).toContain("Regime Adjustment");
  });

  it("includes Session Reflection skill with grading system", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Session Reflection");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("session-reflection");
    expect(skill!.content).toContain("Decision Audit");
    expect(skill!.content).toContain("Bias Audit");
    expect(skill!.content).toContain("Benchmark Comparison");
    expect(skill!.content).toContain("Thesis Validation");
    expect(skill!.content).toContain("lessons_learned must be specific");
  });

  it("includes Investment Brainstorming skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Investment Brainstorming");
    expect(skill).toBeDefined();
    expect(skill!.dirName).toBe("investment-brainstorming");
    expect(skill!.content).toContain("HARD-GATE");
    expect(skill!.content).toContain("## Process");
    expect(skill!.content).toContain("## Key Principles");
    expect(skill!.content).toContain("## Autonomous Mode Behavior");
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
    expect(names).toContain("Investment Debate");
    expect(names).toContain("Risk Assessment Matrix");
    expect(names).toContain("Trade Journal Review");
    expect(names).toContain("Market Regime Detection");
    expect(names).toContain("Position Sizing");
    expect(names).toContain("Session Reflection");
    expect(names).toContain("Investment Brainstorming");
  });
});

describe("getSkillContent", () => {
  it("returns content for an existing skill", () => {
    const content = getSkillContent("Investment Debate");
    expect(content).toBeDefined();
    expect(content).toContain("Bull vs Bear");
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
