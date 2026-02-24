import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { globalConfigSchema, type GlobalConfig } from "./types.js";
import { GLOBAL_CONFIG } from "./paths.js";

export async function loadGlobalConfig(): Promise<GlobalConfig> {
  try {
    const raw = await readFile(GLOBAL_CONFIG, "utf-8");
    const parsed = yaml.load(raw);
    return globalConfigSchema.parse(parsed);
  } catch {
    return globalConfigSchema.parse({});
  }
}

export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  await mkdir(dirname(GLOBAL_CONFIG), { recursive: true });
  const content = yaml.dump(config, { lineWidth: 120 });
  await writeFile(GLOBAL_CONFIG, content, "utf-8");
}

