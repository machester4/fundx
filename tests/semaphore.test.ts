import { describe, it, expect } from "vitest";
import { createSemaphore } from "../src/lock.js";

describe("createSemaphore", () => {
  it("never runs more than `capacity` tasks concurrently", async () => {
    const sem = createSemaphore(3);
    let active = 0;
    let peak = 0;

    const tasks = Array.from({ length: 10 }, () =>
      sem(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 15));
        active--;
        return "done";
      }),
    );

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r === "done")).toBe(true);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(0);
  });

  it("preserves return values from the wrapped function", async () => {
    const sem = createSemaphore(2);
    const result = await sem(async () => 42);
    expect(result).toBe(42);
  });

  it("propagates rejections without leaking a slot", async () => {
    const sem = createSemaphore(1);

    await expect(
      sem(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // If the slot leaked, this second call would deadlock.
    const ok = await sem(async () => "recovered");
    expect(ok).toBe("recovered");
  });

  it("processes queued tasks in FIFO order", async () => {
    const sem = createSemaphore(1);
    const order: number[] = [];

    const tasks = [1, 2, 3, 4, 5].map((n) =>
      sem(async () => {
        order.push(n);
      }),
    );

    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("capacity of 1 acts as a mutex", async () => {
    const sem = createSemaphore(1);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        sem(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );

    expect(peak).toBe(1);
  });
});
