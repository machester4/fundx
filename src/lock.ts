import { readFile, unlink, mkdir, open } from "node:fs/promises";
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

  // If lock file exists, check staleness
  if (existsSync(lockFile)) {
    if (await isLockStale(fundName)) {
      await unlink(lockFile).catch(() => {});
      // Fall through to atomic create below
    } else {
      return false;
    }
  }

  await mkdir(dirname(lockFile), { recursive: true });
  const info: LockInfo = { pid: process.pid, session: sessionType, since: new Date().toISOString() };

  // Atomic create: O_WRONLY | O_CREAT | O_EXCL — fails with EEXIST if another process won the race
  try {
    const handle = await open(lockFile, "wx");
    await handle.writeFile(JSON.stringify(info));
    await handle.close();
    return true;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
      return false; // Another process created the lock between our check and write
    }
    throw err; // Unexpected error — propagate
  }
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
