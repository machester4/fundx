/**
 * News IPC server.
 *
 * Runs inside the daemon. Binds a Unix socket at NEWS_IPC_SOCKET and answers
 * one-shot JSON requests from non-daemon processes (CLI, chat, dashboard).
 * The request format mirrors what `news-ipc-client.ts` sends:
 *
 *   {op: "query", opts: QueryArticlesOpts}  ->  {ok: true, result: NewsQueryResult}
 *   {op: "stats"}                          ->  {ok: true, result: NewsCacheStats}
 *
 * This lets zvec's single-writer lock coexist with multi-process readers:
 * the daemon owns the handle, everyone else asks the daemon.
 */
import { createServer, connect, type Server } from "node:net";
import { unlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { NEWS_IPC_SOCKET } from "../paths.js";
import { queryArticlesDirect, getNewsStatsDirect } from "./news.service.js";

let server: Server | null = null;

const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * Probe the socket with a fast connect to check whether another daemon is
 * actively serving it. Returns true only if the connect succeeds within a
 * short window — we don't want to block startup on a hung peer.
 */
async function isSocketAlive(path: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const timer = setTimeout(() => {
      s.destroy();
      resolve(false);
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      s.destroy();
      resolve(true);
    });
    s.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function startNewsIpcServer(): Promise<void> {
  if (server) return; // idempotent

  // Clean up stale socket from a previous (possibly crashed) run.
  // Liveness-check first so we never unlink a socket owned by a live daemon
  // (e.g. a supervisor-race double-start); if alive, fail loudly instead.
  if (existsSync(NEWS_IPC_SOCKET)) {
    if (await isSocketAlive(NEWS_IPC_SOCKET)) {
      throw new Error(
        `Another process is already serving ${NEWS_IPC_SOCKET}. Refusing to unlink a live socket.`,
      );
    }
    try {
      await unlink(NEWS_IPC_SOCKET);
    } catch (err) {
      // If we can't unlink, bind will fail with a clear error; let it propagate.
      console.warn(`[news-ipc] Failed to unlink stale socket: ${err instanceof Error ? err.message : err}`);
    }
  }

  const s = createServer({ allowHalfOpen: true }, (socket) => {
    let chunks = "";
    let oversized = false;
    socket.setEncoding("utf-8");

    socket.on("data", (chunk) => {
      if (oversized) return;
      chunks += chunk;
      // Requests are tiny JSON objects; anything larger is a bug or a misuse.
      // The socket is chmod 0600 so only local processes as this user can reach it,
      // but defensive bounding prevents an in-process bug from OOMing the daemon.
      if (chunks.length > MAX_REQUEST_BYTES) {
        oversized = true;
        socket.end(JSON.stringify({ ok: false, error: "Request exceeds maximum size" }));
      }
    });

    socket.on("end", () => {
      if (oversized) return;
      void handleRequest(chunks).then((resp) => {
        socket.end(JSON.stringify(resp));
      });
    });

    socket.on("error", () => {
      // Client dropped mid-request; socket will close on its own.
    });
  });

  server = s;

  return new Promise((resolve, reject) => {
    s.once("error", reject);
    s.listen(NEWS_IPC_SOCKET, () => {
      // Lock down permissions — only the daemon's user should read/write.
      chmod(NEWS_IPC_SOCKET, 0o600)
        .then(() => resolve())
        .catch(reject);
    });
  });
}

export async function stopNewsIpcServer(): Promise<void> {
  const s = server;
  if (!s) return;
  server = null;
  await new Promise<void>((resolve) => {
    s.close(() => resolve());
  });
  if (existsSync(NEWS_IPC_SOCKET)) {
    try {
      await unlink(NEWS_IPC_SOCKET);
    } catch {
      // best effort
    }
  }
}

interface QueryRequest {
  op: "query";
  opts: Parameters<typeof queryArticlesDirect>[0];
}
interface StatsRequest {
  op: "stats";
}
type IpcRequest = QueryRequest | StatsRequest;

type IpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

async function handleRequest(raw: string): Promise<IpcResponse> {
  try {
    const req = JSON.parse(raw) as IpcRequest;
    if (req.op === "query") {
      const result = await queryArticlesDirect(req.opts ?? {});
      return { ok: true, result };
    }
    if (req.op === "stats") {
      const result = await getNewsStatsDirect();
      return { ok: true, result };
    }
    return { ok: false, error: `Unknown op: ${(req as { op?: string }).op}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
