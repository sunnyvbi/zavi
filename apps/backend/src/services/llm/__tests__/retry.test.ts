import { describe, it, expect, vi } from "vitest";
import { withProviderRetry } from "../retry";

const noSleep = async (_ms: number) => {};

describe("withProviderRetry", () => {
  it("retries a transient 429 then returns the eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce("ok");
    const out = await withProviderRetry(fn, { attempts: 3, sleep: noSleep });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rethrows after exhausting attempts on a sustained 429 (caller fails open)", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 429 });
    await expect(withProviderRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toMatchObject({
      status: 429,
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-retryable error (e.g. 400) — rethrows immediately", async () => {
    const fn = vi.fn().mockRejectedValue({ status: 400 });
    await expect(withProviderRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toMatchObject({
      status: 400,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors a Retry-After hint for the backoff wait", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
    };
    const err = { status: 429, headers: { "retry-after": "1" } };
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");
    await withProviderRetry(fn, { attempts: 3, sleep, baseMs: 500 });
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThan(1300);
  });

  it("succeeds on the first try without sleeping when there is no error", async () => {
    const sleep = vi.fn();
    const fn = vi.fn().mockResolvedValue("first");
    const out = await withProviderRetry(fn, { attempts: 3, sleep });
    expect(out).toBe("first");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
