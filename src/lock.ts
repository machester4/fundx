import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fundPaths } from "./paths.js";

interface LockInfo {
  pid: number;
  session: string;
  since: string;
}

const STALE_THRESHOLD_MS = 25 * 60 * 1000; // 25 minutes

export async function acquireFundLock(fundName: string, sessionType: string): Promise<boolean> {
  const lockFile = fundPaths(fundName).state.lock;

  if (existsSync(lockFile)) {
    if (await isLockStale(fundName)) {
      await unlink(lockFile).catch(() => {});
    } else {
      return false;
    }
  }

  await mkdir(dirname(lockFile), { recursive: true });
  const info: LockInfo = { pid: process.pid, session: sessionType, since: new Date().toISOString() };
  await writeFile(lockFile, JSON.stringify(info), "utf-8");
  return true;
}

export async function releaseFundLock(fundName: string): Promise<void> {
  const lockFile = fundPaths(fundName).state.lock;
  await unlink(lockFile).catch(() => {});
}

export async function isLockStale(fundName: string): Promise<boolean> {
  const lockFile = fundPaths(fundName).state.lock;
  if (!existsSync(lockFile)) return false;

  try {
    const raw = await readFile(lockFile, "utf-8");
    const info: LockInfo = JSON.parse(raw);

    // Check if owning process is dead
    try {
      process.kill(info.pid, 0);
    } catch {
      return true; // process dead -> stale
    }

    // Check age threshold
    const age = Date.now() - new Date(info.since).getTime();
    return age > STALE_THRESHOLD_MS;
  } catch {
    return true; // unreadable -> treat as stale
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Operation timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
