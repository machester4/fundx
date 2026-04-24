import { readFile, readdir, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  evalCaseSchema,
  evalFundStateSchema,
  type EvalCase,
  type EvalFundState,
} from "../../types.js";

export interface LoadOptions {
  casesDir: string;
  fixturesDir: string;
}

export interface FilterOptions {
  case?: string;
  filter?: string;
}

export async function loadEvalCases(opts: LoadOptions): Promise<EvalCase[]> {
  const fixtures = await loadFixtures(opts.fixturesDir);
  const files = (await readdir(opts.casesDir)).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );
  const cases: EvalCase[] = [];
  const seenIds = new Set<string>();

  for (const f of files.sort()) {
    const path = join(opts.casesDir, f);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      throw new Error(`Failed to read case file ${path}: ${(err as Error).message}`);
    }

    let doc: unknown;
    try {
      doc = yaml.load(raw);
    } catch (err) {
      throw new Error(`Failed to parse YAML in ${path}: ${(err as Error).message}`);
    }

    const resolved = resolveFundStateWithFixture(doc, fixtures, path);

    const parsed = evalCaseSchema.safeParse(resolved);
    if (!parsed.success) {
      throw new Error(`Schema error in ${path}: ${parsed.error.message}`);
    }

    if (seenIds.has(parsed.data.id)) {
      throw new Error(`Duplicate case id "${parsed.data.id}" in ${path}`);
    }
    seenIds.add(parsed.data.id);
    cases.push(parsed.data);
  }

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

export function filterCases(cases: EvalCase[], opts: FilterOptions): EvalCase[] {
  let out = cases;
  if (opts.case) {
    const match = out.filter((c) => c.id === opts.case);
    if (match.length === 0) {
      throw new Error(
        `No case matching --case "${opts.case}". Available: ${out.map((c) => c.id).join(", ")}`,
      );
    }
    out = match;
  }
  if (opts.filter) {
    out = out.filter((c) => c.id.includes(opts.filter!));
  }
  return out;
}

// ── internals ───────────────────────────────────────────────────────

type FixtureMap = Map<string, EvalFundState>;

async function loadFixtures(dir: string): Promise<FixtureMap> {
  const map: FixtureMap = new Map();
  try {
    await access(dir, constants.F_OK);
  } catch {
    return map;
  }
  const files = (await readdir(dir)).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf8");
    const doc = yaml.load(raw) as Record<string, unknown>;
    if (!doc || typeof doc !== "object" || typeof doc.id !== "string") {
      throw new Error(`Fixture ${f} missing top-level "id" string`);
    }
    const { id, ...rest } = doc;
    const parsed = evalFundStateSchema.safeParse(rest);
    if (!parsed.success) {
      throw new Error(`Fixture ${f} schema error: ${parsed.error.message}`);
    }
    map.set(id, parsed.data);
  }
  return map;
}

function resolveFundStateWithFixture(
  doc: unknown,
  fixtures: FixtureMap,
  sourcePath: string,
): unknown {
  if (!doc || typeof doc !== "object") return doc;
  const record = doc as Record<string, unknown>;
  const fs = record.fund_state as Record<string, unknown> | undefined;
  if (!fs || typeof fs.base !== "string") return doc;

  const base = fixtures.get(fs.base);
  if (!base) {
    throw new Error(`Unknown fixture "${fs.base}" referenced by ${sourcePath}`);
  }

  // Shallow merge: case-level fields override fixture-level ones per top-level key.
  const merged: Record<string, unknown> = { ...(base as object), ...stripUndefined(fs) };
  delete merged.base;
  return { ...record, fund_state: merged };
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
