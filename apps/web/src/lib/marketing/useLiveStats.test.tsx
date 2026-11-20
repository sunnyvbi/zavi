// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLiveStats } from "./useLiveStats";
import { LIVE_STATS_REFRESH_MS, LIVE_STATS_TIMEOUT_MS, liveStatsClamp, resetLiveStatsForTests } from "./liveStats";

const payload = (as_of: string, tokens: number, rate: number) => ({
  as_of,
  metrics: {
    tokens_processed: { value: tokens, rate_per_sec: rate },
    agent_steps: { value: 10, rate_per_sec: 0 },
  },
});
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const down = () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("useLiveStats shared store", () => {
  let fetchSpy: MockInstance<Parameters<typeof fetch>, ReturnType<typeof fetch>>;
  beforeEach(() => {
    vi.useFakeTimers();
    resetLiveStatsForTests();
    window.localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    resetLiveStatsForTests();
    vi.useRealTimers();
  });

  it("two counters share one fetch and the same reading", async () => {
    fetchSpy.mockResolvedValue(ok(payload("2026-09-22T10:00:00.000Z", 500, 1)));
    const a = renderHook(() => useLiveStats());
    const b = renderHook(() => useLiveStats());
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(a.result.current).toBe(b.result.current);
    expect(a.result.current?.frozen).toBe(false);
  });

  it("a newer lower reading replaces the projection for every counter", async () => {
    fetchSpy.mockResolvedValueOnce(ok(payload("2026-09-22T10:00:00.000Z", 1_003_600_000, 1000)));
    const a = renderHook(() => useLiveStats());
    const b = renderHook(() => useLiveStats());
    await flush();
    liveStatsClamp.apply("tokens_processed", 1_003_600_000);
    fetchSpy.mockResolvedValueOnce(ok(payload("2026-09-22T11:00:00.000Z", 1_000_000_000, 0)));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_STATS_REFRESH_MS);
    });
    await flush();
    expect(a.result.current?.payload.metrics.tokens_processed.value).toBe(1_000_000_000);
    expect(b.result.current).toBe(a.result.current);
    expect(liveStatsClamp.apply("tokens_processed", 1_000_000_000)).toBe(1_000_000_000);
  });

  it("a failed refresh turns every counter frozen, from the stored reading", async () => {
    fetchSpy.mockResolvedValueOnce(ok(payload("2026-09-22T10:00:00.000Z", 500, 1)));
    const a = renderHook(() => useLiveStats());
    const b = renderHook(() => useLiveStats());
    await flush();
    fetchSpy.mockResolvedValueOnce(down());
    await act(async () => {
      vi.advanceTimersByTime(LIVE_STATS_REFRESH_MS);
    });
    await flush();
    expect(a.result.current?.frozen).toBe(true);
    expect(b.result.current).toBe(a.result.current);
  });

  it("with nothing stored, a failed first fetch shows nothing", async () => {
    fetchSpy.mockResolvedValue(down());
    const a = renderHook(() => useLiveStats());
    await flush();
    expect(a.result.current).toBeNull();
  });

  it("an older reading arriving later is ignored", async () => {
    fetchSpy.mockResolvedValueOnce(ok(payload("2026-09-22T11:00:00.000Z", 2000, 1)));
    const a = renderHook(() => useLiveStats());
    await flush();
    fetchSpy.mockResolvedValueOnce(ok(payload("2026-09-22T10:00:00.000Z", 1000, 1)));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_STATS_REFRESH_MS);
    });
    await flush();
    expect(a.result.current?.payload.metrics.tokens_processed.value).toBe(2000);
    expect(a.result.current?.frozen).toBe(false);
  });

  it("a failed refresh with storage blocked freezes the current reading", async () => {
    fetchSpy.mockResolvedValueOnce(ok(payload("2026-09-22T10:00:00.000Z", 500, 1)));
    const a = renderHook(() => useLiveStats());
    await flush();
    window.localStorage.clear();
    fetchSpy.mockResolvedValueOnce(down());
    await act(async () => {
      vi.advanceTimersByTime(LIVE_STATS_REFRESH_MS);
    });
    await flush();
    expect(a.result.current?.frozen).toBe(true);
    expect(a.result.current?.payload.metrics.tokens_processed.value).toBe(500);
  });

  it("a hung request times out, so later refreshes still run", async () => {
    fetchSpy.mockImplementationOnce(
      (_u, init) =>
        new Promise((_res, rej) => {
          (init as RequestInit).signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    renderHook(() => useLiveStats());
    await act(async () => {
      vi.advanceTimersByTime(LIVE_STATS_TIMEOUT_MS);
    });
    await flush();
    fetchSpy.mockResolvedValueOnce(ok(payload("2026-09-22T10:00:00.000Z", 500, 1)));
    await act(async () => {
      vi.advanceTimersByTime(LIVE_STATS_REFRESH_MS);
    });
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
