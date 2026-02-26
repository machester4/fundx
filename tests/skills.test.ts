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
  getAllSkillNames,
  getSkillContent,
  getSkillsSummaryForTemplate,
  ensureSkillFiles,
} from "../src/skills.js";
import { writeFile, mkdir } from "node:fs/promises";

const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdir = vi.mocked(mkdir);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BUILTIN_SKILLS", () => {
  it("has 6 skills", () => {
    expect(BUILTIN_SKILLS).toHaveLength(6);
  });

  it("each skill has required fields", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.name).toBeTruthy();
      expect(skill.filename).toMatch(/\.md$/);
      expect(skill.content).toBeTruthy();
    }
  });

  it("each skill has When to Use section", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content).toContain("## When to Use");
    }
  });

  it("each skill has Technique section", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content).toContain("## Technique");
    }
  });

  it("each skill has Output Format section", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content).toContain("## Output Format");
    }
  });

  it("includes Investment Debate skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Investment Debate");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("Bull Case");
    expect(skill!.content).toContain("Bear Case");
    expect(skill!.content).toContain("Judge");
  });

  it("includes Risk Assessment Matrix skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Risk Assessment Matrix");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("Aggressive Perspective");
    expect(skill!.content).toContain("Conservative Perspective");
    expect(skill!.content).toContain("Balanced Perspective");
  });

  it("includes Trade Journal Review skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Trade Journal Review");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("trade_journal.sqlite");
  });

  it("includes Market Regime Detection skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Market Regime Detection");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("Risk-On");
    expect(skill!.content).toContain("Risk-Off");
  });

  it("includes Position Sizing skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Position Sizing");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("Conviction Level");
  });

  it("includes Session Reflection skill", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === "Session Reflection");
    expect(skill).toBeDefined();
    expect(skill!.content).toContain("Bias Audit");
  });
});

describe("getAllSkillNames", () => {
  it("returns names of all 6 skills", () => {
    const names = getAllSkillNames();
    expect(names).toHaveLength(6);
    expect(names).toContain("Investment Debate");
    expect(names).toContain("Risk Assessment Matrix");
    expect(names).toContain("Trade Journal Review");
    expect(names).toContain("Market Regime Detection");
    expect(names).toContain("Position Sizing");
    expect(names).toContain("Session Reflection");
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

describe("getSkillsSummaryForTemplate", () => {
  it("returns markdown with skills header", () => {
    const summary = getSkillsSummaryForTemplate();
    expect(summary).toContain("## Advanced Analysis Skills");
  });

  it("includes all skill names in summary list", () => {
    const summary = getSkillsSummaryForTemplate();
    for (const skill of BUILTIN_SKILLS) {
      expect(summary).toContain(`**${skill.name}**`);
    }
  });

  it("includes full skill content", () => {
    const summary = getSkillsSummaryForTemplate();
    expect(summary).toContain("## When to Use");
    expect(summary).toContain("## Technique");
  });

  it("includes usage guidance", () => {
    const summary = getSkillsSummaryForTemplate();
    expect(summary).toContain("at your discretion");
    expect(summary).toContain("do NOT need to");
  });
});

describe("ensureSkillFiles", () => {
  it("creates skills directory", async () => {
    await ensureSkillFiles();
    expect(mockedMkdir).toHaveBeenCalled();
  });

  it("writes all 6 skill files", async () => {
    await ensureSkillFiles();
    expect(mockedWriteFile).toHaveBeenCalledTimes(6);
  });

  it("writes files with correct filenames", async () => {
    await ensureSkillFiles();
    const writtenPaths = mockedWriteFile.mock.calls.map((c) => c[0] as string);
    for (const skill of BUILTIN_SKILLS) {
      expect(writtenPaths.some((p) => p.endsWith(skill.filename))).toBe(true);
    }
  });
});
