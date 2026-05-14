import { describe, it, expect } from "vitest";
import { BUILTIN_SKILLS, WORKSPACE_SKILL, FUND_RULES } from "../src/skills.js";

describe("no telegram residue", () => {
  it("BUILTIN_SKILLS contain no 'telegram' references", () => {
    for (const s of BUILTIN_SKILLS) {
      expect(s.content.toLowerCase()).not.toContain("telegram");
    }
  });

  it("WORKSPACE_SKILL contains no 'telegram' references", () => {
    expect(WORKSPACE_SKILL.content.toLowerCase()).not.toContain("telegram");
  });

  it("FUND_RULES contain no 'telegram' references", () => {
    for (const r of FUND_RULES) {
      expect(r.content.toLowerCase()).not.toContain("telegram");
    }
  });
});
