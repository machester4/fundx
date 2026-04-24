import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { evalFundStateSchema } from "../src/types.js";

const FIXTURES_DIR = join(process.cwd(), "tests", "eval", "fixtures");

describe("fixtures parse against evalFundStateSchema", () => {
  it("all *.yaml in fixtures dir are valid eval fund states", async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = await readFile(join(FIXTURES_DIR, f), "utf8");
      const doc = yaml.load(raw) as Record<string, unknown>;
      const { id: _id, ...rest } = doc;
      const parsed = evalFundStateSchema.safeParse(rest);
      if (!parsed.success) {
        throw new Error(`Fixture ${f} fails schema: ${parsed.error.message}`);
      }
    }
  });
});
