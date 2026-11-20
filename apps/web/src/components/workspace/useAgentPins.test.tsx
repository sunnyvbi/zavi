// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import {
  useAgentPins,
  MAIN_AGENT_SLUGS,
  isMainAgent,
  __resetAgentPinsCache,
} from "./useAgentPins";

function getResponse(pinned: unknown): Response {
  return {
    ok: true,
    json: async () => ({ pinned_slugs: pinned }),
  } as unknown as Response;
}

beforeEach(() => {
  __resetAgentPinsCache();
  apiFetch.mockReset();
});

describe("useAgentPins", () => {
  it("no server row (null) → no extra pins (main agents are fixed elsewhere)", async () => {
    apiFetch.mockResolvedValueOnce(getResponse(null));
    const { result } = renderHook(() => useAgentPins());
    await waitFor(() => expect(result.current.pins).not.toBeNull());
    expect(result.current.pins).toEqual([]);
  });

  it("filters legacy MAIN agent slugs out of a stored row", async () => {
    apiFetch.mockResolvedValueOnce(
      getResponse([...MAIN_AGENT_SLUGS, "qa", "research"]),
    );
    const { result } = renderHook(() => useAgentPins());
    await waitFor(() => expect(result.current.pins).not.toBeNull());
    expect(result.current.pins).toEqual(["qa", "research"]);
  });

  it("togglePin is a no-op for MAIN agents (no PUT fired)", async () => {
    apiFetch.mockResolvedValueOnce(getResponse([]));
    const { result } = renderHook(() => useAgentPins());
    await waitFor(() => expect(result.current.pins).toEqual([]));

    act(() => result.current.togglePin("engineer"));
    expect(isMainAgent("engineer")).toBe(true);
    expect(result.current.pins).toEqual([]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("togglePin adds an extra pin optimistically and PUTs the FULL list", async () => {
    apiFetch.mockResolvedValueOnce(getResponse(["qa"]));
    const { result } = renderHook(() => useAgentPins());
    await waitFor(() => expect(result.current.pins).toEqual(["qa"]));

    apiFetch.mockResolvedValueOnce({ ok: true } as unknown as Response);
    act(() => result.current.togglePin("research"));
    expect(result.current.pins).toEqual(["qa", "research"]);

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const [url, init] = apiFetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/workspace/agent-pins");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      pinned_slugs: ["qa", "research"],
    });
  });

  it("togglePin removes an existing extra pin", async () => {
    apiFetch.mockResolvedValueOnce(getResponse(["qa", "research"]));
    const { result } = renderHook(() => useAgentPins());
    await waitFor(() =>
      expect(result.current.pins).toEqual(["qa", "research"]),
    );

    apiFetch.mockResolvedValueOnce({ ok: true } as unknown as Response);
    act(() => result.current.togglePin("qa"));
    expect(result.current.pins).toEqual(["research"]);
    expect(result.current.isPinned("qa")).toBe(false);
  });

  it("rolls back the optimistic toggle when the PUT fails", async () => {
    apiFetch.mockResolvedValueOnce(getResponse(["qa"]));
    const { result } = renderHook(() => useAgentPins());
    await waitFor(() => expect(result.current.pins).toEqual(["qa"]));

    apiFetch.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);
    act(() => result.current.togglePin("research"));
    expect(result.current.pins).toEqual(["qa", "research"]);
    await waitFor(() => expect(result.current.pins).toEqual(["qa"]));
  });

  it("a failed PUT does NOT roll back over a newer toggle", async () => {
    apiFetch.mockResolvedValueOnce(getResponse(["qa"]));
    const { result } = renderHook(() => useAgentPins());
    await waitFor(() => expect(result.current.pins).toEqual(["qa"]));

    let failFirst: (r: Response) => void = () => {};
    apiFetch.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        failFirst = resolve;
      }),
    );
    apiFetch.mockResolvedValueOnce({ ok: true } as unknown as Response);

    act(() => result.current.togglePin("research"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);

    act(() => result.current.togglePin("growth-lead"));
    expect(result.current.pins).toEqual(["qa", "research", "growth-lead"]);

    await act(async () => {
      failFirst({ ok: false, status: 500 } as unknown as Response);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(result.current.pins).toEqual(["qa", "research", "growth-lead"]),
    );
  });

  it("serializes concurrent toggles and PUTs the newest full list last", async () => {
    apiFetch.mockResolvedValueOnce(getResponse([]));
    const { result } = renderHook(() => useAgentPins());
    await waitFor(() => expect(result.current.pins).toEqual([]));

    apiFetch.mockResolvedValue({ ok: true } as unknown as Response);
    act(() => result.current.togglePin("qa"));
    act(() => result.current.togglePin("research"));

    await waitFor(() => expect(result.current.pins).toEqual(["qa", "research"]));
    const puts = apiFetch.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(puts.length).toBeGreaterThanOrEqual(1);
    const last = puts[puts.length - 1] as [string, RequestInit];
    expect(JSON.parse(String(last[1].body))).toEqual({
      pinned_slugs: ["qa", "research"],
    });
  });

  it("falls back to no extras on a network failure (main 4 keep the tab full)", async () => {
    apiFetch.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useAgentPins());
    await waitFor(() => expect(result.current.pins).not.toBeNull());
    expect(result.current.pins).toEqual([]);
  });
});
