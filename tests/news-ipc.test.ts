/**
 * Roundtrip test for the news IPC server + client.
 *
 * Uses a tmp socket path via FUNDX_NEWS_SOCKET env override, mocks the
 * direct zvec-touching functions so we don't need a real collection, and
 * exercises the full connect → write → half-close → respond → close cycle.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let socketPath: string;

vi.mock("../src/services/news.service.js", () => ({
  queryArticlesDirect: vi.fn(),
  getNewsStatsDirect: vi.fn(),
}));

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "fundx-news-ipc-"));
  socketPath = join(tmpDir, "news.sock");
  process.env.FUNDX_NEWS_SOCKET = socketPath;
});

afterAll(async () => {
  delete process.env.FUNDX_NEWS_SOCKET;
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("news IPC roundtrip", () => {
  it("query op: preserves the ok tagged result across the socket", async () => {
    const { queryArticlesDirect } = await import("../src/services/news.service.js");
    vi.mocked(queryArticlesDirect).mockResolvedValueOnce({
      status: "ok",
      articles: [
        {
          id: "abc",
          title: "Gold breakout",
          source: "Bloomberg",
          category: "commodity",
          url: "https://example.com/1",
          published_at: "2026-04-13T10:00:00Z",
          fetched_at: "2026-04-13T10:00:00Z",
          symbols: ["GLD"],
          snippet: "Gold rallies",
          alerted: false,
          score: 0.91,
        },
      ],
    });

    const { startNewsIpcServer, stopNewsIpcServer } = await import("../src/services/news-ipc.service.js");
    const { queryArticlesViaIpc, isNewsIpcAvailable } = await import("../src/services/news-ipc-client.js");

    await startNewsIpcServer();
    try {
      expect(isNewsIpcAvailable()).toBe(true);

      const result = await queryArticlesViaIpc({ query: "gold", hours: 24, limit: 5 });
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.articles).toHaveLength(1);
        expect(result.articles[0].title).toBe("Gold breakout");
        expect(result.articles[0].score).toBe(0.91);
      }

      // The server dispatched to the direct fn with the same opts we sent
      expect(queryArticlesDirect).toHaveBeenCalledWith({ query: "gold", hours: 24, limit: 5 });
    } finally {
      await stopNewsIpcServer();
    }
  });

  it("stats op: preserves unavailable with reason", async () => {
    const { getNewsStatsDirect } = await import("../src/services/news.service.js");
    vi.mocked(getNewsStatsDirect).mockResolvedValueOnce({
      status: "unavailable",
      reason: "test: zvec gone",
      total: 0,
    });

    const { startNewsIpcServer, stopNewsIpcServer } = await import("../src/services/news-ipc.service.js");
    const { getNewsStatsViaIpc } = await import("../src/services/news-ipc-client.js");

    await startNewsIpcServer();
    try {
      const result = await getNewsStatsViaIpc();
      expect(result.status).toBe("unavailable");
      expect(result.reason).toBe("test: zvec gone");
      expect(result.total).toBe(0);
    } finally {
      await stopNewsIpcServer();
    }
  });

  it("unlinks the socket on stop", async () => {
    const { startNewsIpcServer, stopNewsIpcServer } = await import("../src/services/news-ipc.service.js");

    await startNewsIpcServer();
    expect(existsSync(socketPath)).toBe(true);
    await stopNewsIpcServer();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("cleans up a stale socket file on start", async () => {
    // Simulate a crashed daemon that left a socket behind
    const { writeFile } = await import("node:fs/promises");
    await writeFile(socketPath, "garbage"); // not a real socket
    expect(existsSync(socketPath)).toBe(true);

    const { startNewsIpcServer, stopNewsIpcServer } = await import("../src/services/news-ipc.service.js");
    await startNewsIpcServer();
    try {
      // Server should have unlinked the stale file and bound fresh
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await stopNewsIpcServer();
    }
  });

  it("isNewsIpcAvailable returns false when the server is not running", async () => {
    const { isNewsIpcAvailable } = await import("../src/services/news-ipc-client.js");
    expect(isNewsIpcAvailable()).toBe(false);
  });
});
