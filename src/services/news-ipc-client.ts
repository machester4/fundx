/**
 * News IPC client.
 *
 * Sends one-shot JSON requests over a Unix socket that the daemon binds at
 * NEWS_IPC_SOCKET. Used by any non-daemon process (CLI, chat, dashboard) so
 * they can consult the zvec-backed news cache without fighting the
 * single-writer lock.
 *
 * Protocol:
 *   client → connect → write `{op, opts?}` → half-close (end)
 *   server → read until EOF → write `{ok, result|error}` → close
 * One request per connection. No framing needed.
 */
import { connect } from "node:net";
import { existsSync } from "node:fs";
import { NEWS_IPC_SOCKET } from "../paths.js";
import type { NewsQueryResult, NewsCacheStats, QueryArticlesOpts } from "./news.service.js";

const IPC_TIMEOUT_MS = 2000;

type IpcRequest =
  | { op: "query"; opts: QueryArticlesOpts }
  | { op: "stats" };

type IpcResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error: string };

/** Cheap check (existsSync) — suitable as a gating test before attempting IPC. */
export function isNewsIpcAvailable(): boolean {
  return existsSync(NEWS_IPC_SOCKET);
}

async function sendIpcRequest<T>(req: IpcRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = connect(NEWS_IPC_SOCKET);
    let chunks = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error("IPC timeout"));
    }, IPC_TIMEOUT_MS);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    socket.on("connect", () => {
      socket.write(JSON.stringify(req));
      socket.end(); // half-close signals end of request
    });

    socket.on("data", (chunk) => {
      chunks += chunk.toString("utf-8");
    });

    socket.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const resp = JSON.parse(chunks) as IpcResponse<T>;
        if (resp.ok) resolve(resp.result);
        else reject(new Error(resp.error));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.on("error", (err) => fail(err));
  });
}

export async function queryArticlesViaIpc(opts: QueryArticlesOpts): Promise<NewsQueryResult> {
  return sendIpcRequest<NewsQueryResult>({ op: "query", opts });
}

export async function getNewsStatsViaIpc(): Promise<NewsCacheStats> {
  return sendIpcRequest<NewsCacheStats>({ op: "stats" });
}
