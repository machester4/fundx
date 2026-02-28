import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE, FUNDS_DIR, SHARED_DIR } from "../paths.js";
import { saveGlobalConfig } from "../config.js";
import { ensureSkillFiles } from "../skills.js";
import type { GlobalConfig } from "../types.js";

export interface InitWorkspaceParams {
  timezone: string;
  defaultModel: string;
  brokerProvider: string;
  apiKey?: string;
  secretKey?: string;
  botToken?: string;
  chatId?: string;
}

/** Check if workspace already exists */
export function workspaceExists(): boolean {
  return existsSync(WORKSPACE);
}

/** Get the workspace path */
export function getWorkspacePath(): string {
  return WORKSPACE;
}

/** Initialize the FundX workspace */
export async function initWorkspace(params: InitWorkspaceParams): Promise<void> {
  const config: GlobalConfig = {
    default_model: params.defaultModel,
    timezone: params.timezone,
    broker: {
      provider: params.brokerProvider,
      api_key: params.apiKey,
      secret_key: params.secretKey,
      mode: "paper",
    },
    telegram: {
      bot_token: params.botToken || undefined,
      chat_id: params.chatId,
      enabled: !!params.botToken,
    },
    market_data: {
      provider: "fmp",
    },
  };

  await mkdir(WORKSPACE, { recursive: true });
  await mkdir(FUNDS_DIR, { recursive: true });
  await mkdir(join(SHARED_DIR, "templates"), { recursive: true });
  await mkdir(join(SHARED_DIR, "skills"), { recursive: true });
  await saveGlobalConfig(config);
  await ensureSkillFiles();
}
