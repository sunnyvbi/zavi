// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSignedVideo } from "./useSignedVideo";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

const signed = (signed_url: string) => ({ ok: true, json: async () => ({ signed_url }) });

afterEach(() => {
  cleanup();
  apiFetch.mockReset();
});

describe("useSignedVideo", () => {
  it("a retried ad with a new video plays it even though the old video failed to sign", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.includes("/old/") ? { ok: false, json: async () => ({}) } : signed("https://cdn/new.mp4"),
    );
    const { result, rerender } = renderHook(({ id }) => useSignedVideo(id), { initialProps: { id: "old" } });
    await waitFor(() => expect(result.current.failed).toBe(true));

    rerender({ id: "new" });

    await waitFor(() => expect(result.current.url).toBe("https://cdn/new.mp4"));
    expect(result.current.failed).toBe(false);
  });

  it("a new video gets its own re-sign after the old one used up its retry on playback errors", async () => {
    let n = 0;
    apiFetch.mockImplementation(async (path: string) => signed(`https://cdn/${path.split("/")[3]}-${++n}.mp4`));
    const { result, rerender } = renderHook(({ id }) => useSignedVideo(id), { initialProps: { id: "old" } });
    await waitFor(() => expect(result.current.url).toBe("https://cdn/old-1.mp4"));
    act(() => result.current.onError());
    await waitFor(() => expect(result.current.url).toBe("https://cdn/old-2.mp4"));

    rerender({ id: "new" });
    await waitFor(() => expect(result.current.url).toBe("https://cdn/new-3.mp4"));
    act(() => result.current.onError());

    await waitFor(() => expect(result.current.url).toBe("https://cdn/new-4.mp4"));
    expect(result.current.failed).toBe(false);
  });

  it("an expired link is signed again once, and a second playback error gives up without a third sign", async () => {
    let n = 0;
    apiFetch.mockImplementation(async () => signed(`https://cdn/v-${++n}.mp4`));
    const { result } = renderHook(() => useSignedVideo("a1"));
    await waitFor(() => expect(result.current.url).toBe("https://cdn/v-1.mp4"));
    act(() => result.current.onError());
    await waitFor(() => expect(result.current.url).toBe("https://cdn/v-2.mp4"));
    expect(result.current.failed).toBe(false);

    act(() => result.current.onError());

    await waitFor(() => expect(result.current.failed).toBe(true));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("a slow answer for the old video never replaces the new video's link", async () => {
    let releaseOld: (v: unknown) => void = () => {};
    apiFetch.mockImplementation((path: string) =>
      path.includes("/old/") ? new Promise((r) => (releaseOld = r)) : Promise.resolve(signed("https://cdn/new.mp4")),
    );
    const { result, rerender } = renderHook(({ id }) => useSignedVideo(id), { initialProps: { id: "old" } });
    rerender({ id: "new" });
    await waitFor(() => expect(result.current.url).toBe("https://cdn/new.mp4"));

    await act(async () => releaseOld(signed("https://cdn/old.mp4")));

    expect(result.current.url).toBe("https://cdn/new.mp4");
  });

  it("download says whether a link opened, so a refused sign is never reported as downloaded", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
    apiFetch.mockImplementation(async (path: string) => (path.includes("download=1") ? { ok: false, json: async () => ({}) } : signed("https://cdn/v.mp4")));
    const { result } = renderHook(() => useSignedVideo("v"));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.download();
    });
    expect(ok).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    apiFetch.mockImplementation(async () => signed("https://cdn/dl.mp4"));
    await act(async () => {
      ok = await result.current.download();
    });
    expect(ok).toBe(true);
    expect(assign).toHaveBeenCalledWith("https://cdn/dl.mp4");
  });
});
