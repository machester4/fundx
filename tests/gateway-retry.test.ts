import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { telegramSendWithRetry } from "../src/services/gateway.service.js";

describe("telegramSendWithRetry", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
    vi.useFakeTimers();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("returns ok on first success", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await telegramSendWithRetry("https://api.telegram.org/bot/sendMessage", { chat_id: "x", text: "hi" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on 429", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "rate limit" }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const promise = telegramSendWithRetry("https://api.telegram.org/bot/sendMessage", { chat_id: "x", text: "hi" });
    await vi.runAllTimersAsync();
    await promise;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on 4xx (chat invalid)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }));
    await expect(
      telegramSendWithRetry("https://api.telegram.org/bot/sendMessage", { chat_id: "x", text: "hi" }),
    ).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries on 5xx and rethrows after exhaustion", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 503 }));
    const assertion = expect(
      telegramSendWithRetry("https://api.telegram.org/bot/sendMessage", { chat_id: "x", text: "hi" }),
    ).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
