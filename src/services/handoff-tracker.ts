import { statSync } from "node:fs";

/** Tracks whether the agent wrote a fresh handoff during the session.
 *  Used by the SDK Stop hook to flag missing handoffs in the session log. */
export class HandoffTracker {
  /** True iff the most recent checkOnStop() found mtime > sessionStartedAtMs.
   *  Read by runFundSession after the session ends to populate session_log. */
  handoffWritten: boolean = false;

  constructor(
    private readonly handoffPath: string,
    private readonly sessionStartedAtMs: number,
  ) {}

  /** Check if the handoff file's mtime is later than the session start time.
   *  Pure logic + single sync stat. Idempotent. Side effect: updates handoffWritten. */
  checkOnStop(): { written: boolean } {
    try {
      const stat = statSync(this.handoffPath);
      this.handoffWritten = stat.mtimeMs > this.sessionStartedAtMs;
    } catch {
      // ENOENT or any read error → not written
      this.handoffWritten = false;
    }
    return { written: this.handoffWritten };
  }
}
