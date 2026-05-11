import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reloadAuthToken } from "../src/services/auth.service.js";
import * as configMod from "../src/config.js";

describe("reloadAuthToken", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalEnv;
    vi.restoreAllMocks();
  });

  it("propagates the token from config to process.env", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.spyOn(configMod, "loadGlobalConfig").mockResolvedValue({
      claude_code_oauth_token: "fresh-token-123",
    } as never);
    await reloadAuthToken();
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fresh-token-123");
  });

  it("returns false when config has no token", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.spyOn(configMod, "loadGlobalConfig").mockResolvedValue({} as never);
    const ok = await reloadAuthToken();
    expect(ok).toBe(false);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("returns true when token is propagated", async () => {
    vi.spyOn(configMod, "loadGlobalConfig").mockResolvedValue({
      claude_code_oauth_token: "abc",
    } as never);
    const ok = await reloadAuthToken();
    expect(ok).toBe(true);
  });
});
