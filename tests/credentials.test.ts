import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("../src/paths.js", () => ({
  fundPaths: (name: string) => ({
    root: `/mock/.fundx/funds/${name}`,
    credentials: `/mock/.fundx/funds/${name}/credentials.yaml`,
  }),
}));

import { readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  loadFundCredentials,
  saveFundCredentials,
  hasFundCredentials,
  clearFundCredentials,
} from "../src/credentials.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadFundCredentials", () => {
  it("returns null when credentials.yaml does not exist", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const result = await loadFundCredentials("test-fund");
    expect(result).toBeNull();
  });

  it("returns parsed credentials when file exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("api_key: PK123\nsecret_key: SK456" as unknown as Buffer);
    const result = await loadFundCredentials("test-fund");
    expect(result).toEqual({ apiKey: "PK123", secretKey: "SK456" });
  });

  it("returns null when file content is invalid YAML", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("not: valid: yaml: content: :" as unknown as Buffer);
    const result = await loadFundCredentials("test-fund");
    expect(result).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue("api_key: PK123" as unknown as Buffer);
    const result = await loadFundCredentials("test-fund");
    expect(result).toBeNull();
  });
});

describe("saveFundCredentials", () => {
  it("writes credentials.yaml with 0600 permissions", async () => {
    await saveFundCredentials("test-fund", "PK123", "SK456");
    expect(writeFile).toHaveBeenCalledWith(
      "/mock/.fundx/funds/test-fund/credentials.yaml",
      expect.stringContaining("api_key"),
      "utf-8",
    );
    expect(chmod).toHaveBeenCalledWith(
      "/mock/.fundx/funds/test-fund/credentials.yaml",
      0o600,
    );
  });

  it("includes both api_key and secret_key in written content", async () => {
    await saveFundCredentials("test-fund", "PK123", "SK456");
    const writtenContent = vi.mocked(writeFile).mock.calls[0]?.[1] as string;
    expect(writtenContent).toContain("api_key");
    expect(writtenContent).toContain("secret_key");
  });
});

describe("hasFundCredentials", () => {
  it("returns false when no file", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(await hasFundCredentials("test-fund")).toBe(false);
  });

  it("returns true when file exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(await hasFundCredentials("test-fund")).toBe(true);
  });
});

describe("clearFundCredentials", () => {
  it("calls unlink on the credentials path", async () => {
    const { unlink } = await import("node:fs/promises");
    await clearFundCredentials("test-fund");
    expect(unlink).toHaveBeenCalledWith(
      "/mock/.fundx/funds/test-fund/credentials.yaml",
    );
  });

  it("does not throw if file does not exist", async () => {
    const { unlink } = await import("node:fs/promises");
    vi.mocked(unlink).mockRejectedValue(new Error("ENOENT"));
    await expect(clearFundCredentials("test-fund")).resolves.toBeUndefined();
  });
});
