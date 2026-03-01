import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE, FUNDS_DIR, SHARED_DIR, WORKSPACE_CLAUDE_MD, WORKSPACE_CLAUDE_DIR, WORKSPACE_RULES_DIR } from "../paths.js";
import { saveGlobalConfig } from "../config.js";
import { ensureWorkspaceSkillFiles } from "../skills.js";
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
  await mkdir(WORKSPACE_RULES_DIR, { recursive: true });
  await saveGlobalConfig(config);
  await ensureWorkspaceClaudeMd();
  await ensureWorkspaceRules();
  await ensureWorkspaceSkillFiles();
}

/** Generate ~/.fundx/CLAUDE.md — the workspace-level instructions loaded by the Agent SDK */
async function ensureWorkspaceClaudeMd(): Promise<void> {
  if (existsSync(WORKSPACE_CLAUDE_MD)) return;
  const content = `# FundX Workspace

You are FundX's interactive setup assistant. FundX is an autonomous CLI-first investment
fund platform that uses Claude Code to manage investment funds.

## Your Role
Help users create and configure investment funds through natural conversation.
When a user describes their investment goal, use your \`create-fund\` skill to generate
a complete fund configuration.

## After Creating a Fund
Tell the user: "Type \`/fund <name>\` to start chatting with your new fund's AI manager."

## Available Tools
- **market-data** MCP: Research assets, check prices, read news and macro data
- **create-fund** skill: Build and write a complete \`fund_config.yaml\`
- File system: Write files to \`${WORKSPACE}/funds/<name>/\`
`;
  await writeFile(WORKSPACE_CLAUDE_MD, content, "utf-8");
}

/** Generate ~/.fundx/.claude/rules/ — behavioral rules for the workspace assistant */
async function ensureWorkspaceRules(): Promise<void> {
  await mkdir(WORKSPACE_RULES_DIR, { recursive: true });

  const assistantRulesPath = join(WORKSPACE_RULES_DIR, "assistant-behavior.md");
  if (!existsSync(assistantRulesPath)) {
    await writeFile(
      assistantRulesPath,
      `# Fund Creation Assistant Rules

- Before creating a fund, gather: initial capital, time horizon, risk tolerance, and target assets
- Always set \`broker.mode: paper\` — users enable live trading explicitly via \`fundx live enable\`
- The \`claude.personality\` and \`claude.decision_framework\` fields are the most important parts
  of a fund config — make them rich, specific, and actionable; they govern every trading session
- Suggest risk parameters appropriate to the user's stated tolerance:
  conservative (max_drawdown 10%, max_position 15%) |
  moderate (15%, 25%) |
  aggressive (25%, 40%)
- After creating a fund, always tell the user the exact switch command: \`/fund <name>\`
- Never invent broker credentials or API keys — they come from the global config
`,
      "utf-8",
    );
  }
}
