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
  mode: paper
notifications:
  enabled: true
  quiet_hours:
    enabled: true
    start: "22:00"
    end: "06:00"
`);

    const config = await loadGlobalConfig();
    expect(config.default_model).toBe("opus");
    expect(config.broker.mode).toBe("paper");
    expect(config.notifications.enabled).toBe(true);
    expect(config.notifications.quiet_hours.start).toBe("22:00");
  });

  it("returns defaults when config file is missing", async () => {
    mockedReadFile.mockRejectedValue(new Error("ENOENT"));

    const config = await loadGlobalConfig();
    expect(config.default_model).toBe("claude-opus-4-8");
    expect(config.notifications.enabled).toBe(true);
  });

  it("returns defaults when config is invalid YAML", async () => {
    mockedReadFile.mockResolvedValue(":::invalid yaml:::");

    const config = await loadGlobalConfig();
    expect(config.default_model).toBe("claude-opus-4-8");
  });

  it("applies schema defaults for missing fields", async () => {
    mockedReadFile.mockResolvedValue("default_model: haiku\n");

    const config = await loadGlobalConfig();
    expect(config.default_model).toBe("haiku");
    expect(config.timezone).toBe("UTC");
  });
});

describe("saveGlobalConfig", () => {
  it("creates parent directories and writes YAML", async () => {
    const config = {
      default_model: "opus",
      timezone: "US/Eastern",
      broker: { mode: "paper" as const },
      notifications: { enabled: true },
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
