import { loadGlobalConfig } from "../config.js";

/** Re-read CLAUDE_CODE_OAUTH_TOKEN from the global config and propagate to process.env.
 *  Returns true if a token was found and propagated; false if no token in config.
 *  Used by runAgentQuery's auth-error retry path to recover without daemon restart. */
export async function reloadAuthToken(): Promise<boolean> {
  const cfg = await loadGlobalConfig();
  const token = (cfg as { claude_code_oauth_token?: string }).claude_code_oauth_token;
  if (!token) return false;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  return true;
}
