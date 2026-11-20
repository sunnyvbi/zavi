import { beforeEach, describe, expect, it, vi } from "vitest";
import { cachedSection, clearClientContextCache, invalidateClientContext } from "../cache";

beforeEach(() => {
  clearClientContextCache();
  vi.useRealTimers();
});

describe("cachedSection", () => {
  it("shares one in-flight promise across concurrent callers", async () => {
    const work = vi.fn(async () => ({ ok: true }));
    const [a, b] = await Promise.all([
      cachedSection("t:channels:30", 1000, false, work),
      cachedSection("t:channels:30", 1000, false, work),
    ]);
    expect(a).toBe(b);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("expires after the ttl and bypasses on fresh", async () => {
    vi.useFakeTimers();
    const work = vi.fn(async () => Date.now());
    await cachedSection("t:company:30", 1000, false, work);
    await cachedSection("t:company:30", 1000, false, work);
    expect(work).toHaveBeenCalledTimes(1);
    await cachedSection("t:company:30", 1000, true, work);
    expect(work).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1001);
    await cachedSection("t:company:30", 1000, false, work);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it("drops rejected work so the next caller retries", async () => {
    const work = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    await expect(cachedSection("t:goals:30", 1000, false, work)).rejects.toThrow("boom");
    await expect(cachedSection("t:goals:30", 1000, false, work)).resolves.toBe("ok");
  });

  it("invalidates every section for one tenant only", async () => {
    const work = vi.fn(async () => "v");
    await cachedSection("a:company:30", 1000, false, work);
    await cachedSection("b:company:30", 1000, false, work);
    invalidateClientContext("a");
    await cachedSection("a:company:30", 1000, false, work);
    await cachedSection("b:company:30", 1000, false, work);
    expect(work).toHaveBeenCalledTimes(3);
  });
});
