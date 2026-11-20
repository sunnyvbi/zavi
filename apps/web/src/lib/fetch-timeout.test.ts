import { describe, it, expect, vi } from "vitest";
import { fetchWithTimeout, WEB_SERVER_DB_TIMEOUT_MS, WEB_BROWSER_DB_TIMEOUT_MS } from "./fetch-timeout";

const hanging = vi.fn((_i: unknown, init?: RequestInit) =>
  new Promise<Response>((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
);

describe("web fetchWithTimeout", () => {
  it("aborts a hanging request", async () => {
    await expect(fetchWithTimeout(10, hanging as unknown as typeof fetch)("https://x/rest/v1/t")).rejects.toThrow();
  });

  it("server requests are bounded tighter than browser ones", () => {
    expect(WEB_SERVER_DB_TIMEOUT_MS).toBe(8_000);
    expect(WEB_BROWSER_DB_TIMEOUT_MS).toBe(20_000);
  });

  it("a storage upload is not cut at the query bound", async () => {
    vi.useFakeTimers();
    const p = fetchWithTimeout(10, hanging as unknown as typeof fetch)("https://x/storage/v1/object/b/k");
    let settled = false;
    p.catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(true);
    vi.useRealTimers();
  });
});
