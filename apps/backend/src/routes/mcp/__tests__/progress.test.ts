import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMcpProgress } from "@/services/mcp/server/request-progress";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("request-scoped progress cleanup", () => {
  it.each([undefined, null, {}, true])("does nothing without a valid token (%s)", async token => {
    const sendNotification = vi.fn();
    const stop = startMcpProgress(token, { signal: new AbortController().signal, sendNotification });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendNotification).not.toHaveBeenCalled();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, "", "request-token"])("preserves token %s, stops on abort, and adds no completion percentage", async token => {
    const abort = new AbortController();
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    startMcpProgress(token, { signal: abort.signal, sendNotification });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendNotification.mock.calls).toEqual([10, 20].map(progress => [{
      method: "notifications/progress", params: { progressToken: token, progress },
    }]));
    abort.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start after cancellation", () => {
    const abort = new AbortController(); abort.abort();
    startMcpProgress("t", { signal: abort.signal, sendNotification: vi.fn() });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops on a failed send without an unhandled rejection", async () => {
    const sendNotification = vi.fn().mockRejectedValue(new Error("transport closed"));
    startMcpProgress("t", { signal: new AbortController().signal, sendNotification });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not pile up sends when the transport is slow", async () => {
    let finish!: () => void;
    const sendNotification = vi.fn().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = startMcpProgress("t", { signal: new AbortController().signal, sendNotification });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendNotification).toHaveBeenCalledOnce();
    stop(); finish();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
