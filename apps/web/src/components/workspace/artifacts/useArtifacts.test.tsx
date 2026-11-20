// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { ARTIFACTS_CACHE_FRESH_MS, resetArtifactsCacheForTests, useArtifacts } from "./useArtifacts";

const one = (id: string) => ({
  id,
  run_id: "r1",
  title: id,
  filename: `${id}.png`,
  mime: "image/png",
  type: "image",
  bytes: 1,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  preview_url: null,
  source: { kind: "chat", id: "c1", title: "Chat", href: "/x" },
});

afterEach(() => {
  cleanup();
  resetArtifactsCacheForTests();
  apiFetch.mockReset();
  vi.useRealTimers();
});

describe("useArtifacts (#13)", () => {
  it("loads the full list once, with no search or type params", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ artifacts: [] }) });
    const { result, rerender } = renderHook(() => useArtifacts());
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender();
    rerender();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe("/api/run-artifacts");
  });
});

describe("useArtifacts warm cache", () => {
  it("a remount inside the fresh window paints the last list at once, then revalidates silently", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ artifacts: [one("a")] }) });
    const first = renderHook(() => useArtifacts());
    await waitFor(() => expect(first.result.current.artifacts).toHaveLength(1));
    first.unmount();

    let release: () => void = () => {};
    apiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, json: async () => ({ artifacts: [one("a"), one("b")] }) });
        }),
    );
    const second = renderHook(() => useArtifacts());
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.artifacts.map((a) => a.id)).toEqual(["a"]);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    release();
    await waitFor(() =>
      expect(second.result.current.artifacts.map((a) => a.id)).toEqual(["a", "b"]),
    );
  });

  it("a failed silent revalidate keeps the warm list on screen with the error beside it", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ artifacts: [one("a")] }) });
    const first = renderHook(() => useArtifacts());
    await waitFor(() => expect(first.result.current.artifacts).toHaveLength(1));
    first.unmount();

    apiFetch.mockResolvedValue({ ok: false, json: async () => ({}) });
    const second = renderHook(() => useArtifacts());
    await waitFor(() => expect(second.result.current.error).not.toBeNull());
    expect(second.result.current.artifacts).toHaveLength(1);
    expect(second.result.current.loading).toBe(false);
  });

  it("a stale cache shows the skeleton again rather than an eight-minute-old list", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ artifacts: [one("a")] }) });
    const first = renderHook(() => useArtifacts());
    await vi.waitFor(() => expect(first.result.current.artifacts).toHaveLength(1));
    first.unmount();

    vi.setSystemTime(Date.now() + ARTIFACTS_CACHE_FRESH_MS + 1);
    const second = renderHook(() => useArtifacts());
    expect(second.result.current.loading).toBe(true);
    expect(second.result.current.artifacts).toHaveLength(0);
  });

  it("a delete on one mount is what the next mount paints", async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ artifacts: [one("a"), one("b")] }) });
    const first = renderHook(() => useArtifacts());
    await waitFor(() => expect(first.result.current.artifacts).toHaveLength(2));
    apiFetch.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });
    await first.result.current.remove("a");
    first.unmount();

    apiFetch.mockImplementation(() => new Promise(() => {}));
    const second = renderHook(() => useArtifacts());
    expect(second.result.current.artifacts.map((a) => a.id)).toEqual(["b"]);
  });
});
