import { beforeEach, describe, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => ({
  realtime: { setAuth: vi.fn() },
  auth: { onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) },
}));
vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => sb }));
import { AUTH_RETRY_DELAYS_MS, realtimeAuthReady, resetRealtimeAuthReadyForTests, syncRealtimeAuth } from "./realtimeAuth";

beforeEach(() => {
  resetRealtimeAuthReadyForTests();
  sb.realtime.setAuth.mockReset().mockResolvedValue(undefined);
  sb.auth.onAuthStateChange.mockClear();
});

describe("realtimeAuthReady", () => {
  it("binds the token once and shares the wait between callers", async () => {
    await Promise.all([realtimeAuthReady(), realtimeAuthReady()]);
    await realtimeAuthReady();
    expect(sb.realtime.setAuth).toHaveBeenCalledTimes(1);
    expect(sb.realtime.setAuth).toHaveBeenCalledWith();
  });

  it("retries a failed bind before anyone joins", async () => {
    vi.useFakeTimers();
    sb.realtime.setAuth.mockRejectedValueOnce(new Error("offline")).mockRejectedValueOnce(new Error("offline"));
    let settled = false;
    const p = realtimeAuthReady().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAYS_MS[0]);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAYS_MS[1]);
    await p;
    expect(sb.realtime.setAuth).toHaveBeenCalledTimes(3);
    await realtimeAuthReady();
    expect(sb.realtime.setAuth).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("never rejects or hangs; after every retry fails the next caller starts over", async () => {
    vi.useFakeTimers();
    sb.realtime.setAuth.mockRejectedValue(new Error("offline"));
    const p = realtimeAuthReady();
    await vi.advanceTimersByTimeAsync(AUTH_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    await expect(p).resolves.toBeUndefined();
    expect(sb.realtime.setAuth).toHaveBeenCalledTimes(AUTH_RETRY_DELAYS_MS.length + 1);
    sb.realtime.setAuth.mockReset().mockResolvedValue(undefined);
    await realtimeAuthReady();
    expect(sb.realtime.setAuth).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("syncRealtimeAuth re-binds on every auth change without pinning a manual token", async () => {
    syncRealtimeAuth();
    await realtimeAuthReady();
    const onChange = (sb.auth.onAuthStateChange.mock.calls[0] as unknown[])[0] as () => void;
    onChange();
    expect(sb.realtime.setAuth).toHaveBeenCalledTimes(2);
    expect(sb.realtime.setAuth).toHaveBeenLastCalledWith();
  });
});
