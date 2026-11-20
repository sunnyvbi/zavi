// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

import { prefetchChannelLocks, resetChannelLocksCache, useChannelLocks } from "./useChannelLocks";

afterEach(() => {
  cleanup();
  resetChannelLocksCache();
  apiFetch.mockReset();
  vi.useRealTimers();
});

const answer = (channel_locks: Record<string, string | null>) => ({
  ok: true,
  json: async () => ({ channels: [], channel_locks }),
});

it("an older backend with no channel_locks: reads each row's locked_tier, null until it answers", async () => {
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      channels: [
        { channel_slug: "meta_ads", locked_tier: "pro" },
        { channel_slug: "seo", locked_tier: null },
      ],
    }),
  });
  const { result } = renderHook(() => useChannelLocks());
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current).toEqual({ meta_ads: "pro", seo: null }));
  expect(apiFetch).toHaveBeenCalledWith("/api/channels");
});

it("a failed read resolves to no channels, never stuck loading", async () => {
  apiFetch.mockRejectedValue(new Error("offline"));
  const { result } = renderHook(() => useChannelLocks());
  await waitFor(() => expect(result.current).toEqual({}));
});

it("a server that could not read the plan (channel_locks_known false) is unknown, not every channel included", async () => {
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ channels: [], channel_locks: { meta_ads: null, seo: null }, channel_locks_known: false }),
  });
  const { result } = renderHook(() => useChannelLocks());
  await waitFor(() => expect(result.current).toEqual({}));
});

it("reads channel_locks, which names every channel even with no channel rows", async () => {
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ channels: [], channel_locks: { meta_ads: "pro", seo: null } }),
  });
  const { result } = renderHook(() => useChannelLocks());
  await waitFor(() => expect(result.current).toEqual({ meta_ads: "pro", seo: null }));
});

it("re-reads on becoming visible, and a stale earlier answer cannot overwrite a newer one", async () => {
  let resolveFirst: (v: unknown) => void = () => {};
  apiFetch
    .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
    .mockResolvedValueOnce(answer({ meta_ads: "pro" }));
  const { result } = renderHook(() => useChannelLocks());
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => expect(result.current).toEqual({ meta_ads: "pro" }));
  await act(async () => {
    resolveFirst(answer({ meta_ads: null }));
  });
  expect(result.current).toEqual({ meta_ads: "pro" });
});

it("asks again after a failed read, so one 5xx does not leave Analytics blank", async () => {
  vi.useFakeTimers();
  apiFetch
    .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    .mockResolvedValueOnce(answer({ seo: "starter" }));
  const { result } = renderHook(() => useChannelLocks());
  await act(async () => {});
  expect(result.current).toEqual({});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(result.current).toEqual({ seo: "starter" });
});

it("a second mount paints the last good map at once, then re-reads", async () => {
  apiFetch.mockResolvedValue(answer({ meta_ads: "pro" }));
  const first = renderHook(() => useChannelLocks());
  await waitFor(() => expect(first.result.current).toEqual({ meta_ads: "pro" }));
  first.unmount();
  apiFetch.mockResolvedValue(answer({ meta_ads: null }));
  const second = renderHook(() => useChannelLocks());
  expect(second.result.current).toEqual({ meta_ads: "pro" });
  await waitFor(() => expect(second.result.current).toEqual({ meta_ads: null }));
});

it("the workspace prefetch warms the map, and the mount shares its read", async () => {
  apiFetch.mockResolvedValue(answer({ seo: "starter" }));
  prefetchChannelLocks();
  const { result } = renderHook(() => useChannelLocks());
  await waitFor(() => expect(result.current).toEqual({ seo: "starter" }));
  expect(apiFetch).toHaveBeenCalledTimes(1);
  prefetchChannelLocks();
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
