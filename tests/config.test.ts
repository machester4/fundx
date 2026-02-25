import { describe, it, expect, vi, beforeEach } from "vitest";

const mockedReadFile = vi.fn();
const mockedWriteFile = vi.fn();
const mockedMkdir = vi.fn();

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockedReadFile(...args),
  writeFile: (...args: unknown[]) => mockedWriteFile(...args),
  mkdir: (...args: unknown[]) => mockedMkdir(...args),
}));

vi.mock("../src/paths.js", () => ({
  GLOBAL_CONFIG: "/home/test/.fundx/config.yaml",
}));

import { loadGlobalConfig, saveGlobalConfig } from "../src/config.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockResolvedValue(undefined);
});

describe("loadGlobalConfig", () => {
  it("parses a valid YAML config", async () => {
    mockedReadFile.mockResolvedValue(`
default_model: opus
broker:
  provider: alpaca
  api_key: test-key
  secret_key: test-secret
  mode: paper
telegram:
  bot_token: "123:ABC"
  chat_id: "999"
  enabled: true
`);

    const config = await loadGlobalConfig();
    expect(config.default_model).toBe("opus");
    expect(config.broker.provider).toBe("alpaca");
    expect(config.broker.api_key).toBe("test-key");
    expect(config.telegram.bot_token).toBe("123:ABC");
    expect(config.telegram.enabled).toBe(true);
  });

  it("returns defaults when config file is missing", async () => {
    mockedReadFile.mockRejectedValue(new Error("ENOENT"));

    const config = await loadGlobalConfig();
    expect(config.default_model).toBe("sonnet");
    expect(config.broker.provider).toBe("manual");
    expect(config.broker.mode).toBe("paper");
    expect(config.telegram.enabled).toBe(false);
  });

  it("returns defaults when config is invalid YAML", async () => {
    mockedReadFile.mockResolvedValue(":::invalid yaml:::");

    const config = await loadGlobalConfig();
    expect(config.default_model).toBe("sonnet");
  });

  it("applies schema defaults for missing fields", async () => {
    mockedReadFile.mockResolvedValue("default_model: haiku\n");

    const config = await loadGlobalConfig();
    expect(config.default_model).toBe("haiku");
    expect(config.timezone).toBe("UTC");
    expect(config.broker.mode).toBe("paper");
  });
});

describe("saveGlobalConfig", () => {
  it("creates parent directories and writes YAML", async () => {
    const config = {
      default_model: "opus",
      timezone: "US/Eastern",
      broker: { provider: "alpaca", mode: "paper" as const },
      telegram: { enabled: false },
    };

    await saveGlobalConfig(config as ReturnType<typeof loadGlobalConfig> extends Promise<infer T> ? T : never);

    expect(mockedMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".fundx"),
      { recursive: true },
    );
    expect(mockedWriteFile).toHaveBeenCalledWith(
      "/home/test/.fundx/config.yaml",
      expect.stringContaining("default_model: opus"),
      "utf-8",
    );
  });
});
