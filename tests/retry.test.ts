import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/services/retry.service.js";

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: false, shouldRetry: () => true });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success when shouldRetry returns true", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10, jitter: false, shouldRetry: () => true });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when shouldRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));
    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 10, jitter: false, shouldRetry: () => false }),
    ).rejects.toThrow("permanent");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows after exhausting maxAttempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("never gives up"));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: false, shouldRetry: () => true }),
    ).rejects.toThrow("never gives up");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("uses exponential backoff capped at maxDelayMs", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockRejectedValueOnce(new Error("b"))
      .mockRejectedValueOnce(new Error("c"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    await withRetry(fn, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250, jitter: false, shouldRetry: () => true, onRetry });
    // attempt 1 → 100ms, attempt 2 → 200ms, attempt 3 → 250ms (capped)
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error), 100);
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error), 200);
    expect(onRetry).toHaveBeenNthCalledWith(3, 3, expect.any(Error), 250);
  });

  it("applies jitter within ±25% when enabled", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("a"))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();
    await withRetry(fn, { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 5000, jitter: true, shouldRetry: () => true, onRetry });
    const delay = onRetry.mock.calls[0][2];
    expect(delay).toBeGreaterThanOrEqual(750);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it("calls onRetry before each retry, not on success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const onRetry = vi.fn();
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: false, shouldRetry: () => true, onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });
});
