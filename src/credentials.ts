import { readFile, writeFile, unlink, chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { fundCredentialsSchema } from "./types.js";
import { fundPaths } from "./paths.js";

/** Load per-fund broker credentials. Returns null if no credentials.yaml exists. */
export async function loadFundCredentials(
  fundName: string,
): Promise<{ apiKey: string; secretKey: string } | null> {
  const credPath = fundPaths(fundName).credentials;
  if (!existsSync(credPath)) return null;

  try {
    const raw = await readFile(credPath, "utf-8");
    const parsed = yaml.load(raw);
    const creds = fundCredentialsSchema.parse(parsed);
    return { apiKey: creds.api_key, secretKey: creds.secret_key };
  } catch {
    return null;
  }
}

/** Save per-fund broker credentials with restricted permissions (0600). */
export async function saveFundCredentials(
  fundName: string,
  apiKey: string,
  secretKey: string,
): Promise<void> {
  const credPath = fundPaths(fundName).credentials;
  await mkdir(dirname(credPath), { recursive: true });
  const content = yaml.dump({ api_key: apiKey, secret_key: secretKey });
  await writeFile(credPath, content, "utf-8");
  await chmod(credPath, 0o600);
}

/** Check if a fund has dedicated credentials. */
export async function hasFundCredentials(fundName: string): Promise<boolean> {
  return existsSync(fundPaths(fundName).credentials);
}

/** Remove per-fund credentials (revert to global fallback). */
export async function clearFundCredentials(fundName: string): Promise<void> {
  const credPath = fundPaths(fundName).credentials;
  await unlink(credPath).catch(() => {});
}
