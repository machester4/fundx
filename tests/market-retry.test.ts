import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchFmpWithRetry } from "../src/services/market.service.js";

describe("fetchFmpWithRetry", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
    vi.useFakeTimers();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("returns response on first 200", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const r = await fetchFmpWithRetry("https://fmp.example/x");
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on 503 and succeeds on third attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const promise = fetchFmpWithRetry("https://fmp.example/x");
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 (rate limit)", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const promise = fetchFmpWithRetry("https://fmp.example/x");
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx (other than 429)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 401 }));
    const r = await fetchFmpWithRetry("https://fmp.example/x");
    expect(r.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns the final Response after 3 failed attempts (caller decides fallback)", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const promise = fetchFmpWithRetry("https://fmp.example/x");
    await vi.runAllTimersAsync();
    const r = await promise;
    expect(r.status).toBe(503);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
