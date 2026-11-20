// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch }));

import { resetCreatorCardCache, useCreatorCards } from "./useCards";

const card = { human_member_id: "m1", display_name: "Maya" };
const ok = () => new Response(JSON.stringify({ creator: card }), { status: 200 });
const down = () => new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 });

beforeEach(() => {
  resetCreatorCardCache();
  apiFetch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useCreatorCards cache", () => {
  it("does not remember a failed read: the next open asks again and shows the creator", async () => {
    apiFetch.mockResolvedValueOnce(down()).mockResolvedValueOnce(ok());
    const first = renderHook(() => useCreatorCards(["m1"]));
    await waitFor(() => expect(first.result.current.m1).toBeNull());
    first.unmount();

    const second = renderHook(() => useCreatorCards(["m1"]));
    await waitFor(() => expect(second.result.current.m1).toEqual(card));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("reuses a card that loaded, with no second read", async () => {
    apiFetch.mockResolvedValue(ok());
    const first = renderHook(() => useCreatorCards(["m1"]));
    await waitFor(() => expect(first.result.current.m1).toEqual(card));
    first.unmount();

    const second = renderHook(() => useCreatorCards(["m1"]));
    expect(second.result.current.m1).toEqual(card);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 503", () => Promise.resolve(down())],
    ["a dropped connection", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("keeps a loaded creator when the stale refetch on Load more fails with %s", async (_label, fail) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
    const other = { human_member_id: "m2", display_name: "Noor" };
    const never = { human_member_id: "m3" };
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/m1/card")) return ok();
      throw new Error(`unexpected ${path}`);
    });
    const hook = renderHook(({ ids }) => useCreatorCards(ids), { initialProps: { ids: ["m1"] } });
    await waitFor(() => expect(hook.result.current.m1).toEqual(card));
    const fresh = renderHook(() => useCreatorCards(["m1"]));
    expect(fresh.result.current.m1).toEqual(card);

    vi.setSystemTime(new Date("2026-10-16T10:01:01Z"));
    apiFetch.mockReset().mockImplementation(async (path: string) => {
      if (path.endsWith("/m2/card")) return new Response(JSON.stringify({ creator: other }), { status: 200 });
      if (path.endsWith("/m1/card")) return fail();
      if (path.endsWith(`/${never.human_member_id}/card`)) return down();
      throw new Error(`unexpected ${path}`);
    });
    hook.rerender({ ids: ["m1", "m2", "m3"] });
    await waitFor(() => expect(hook.result.current.m2).toEqual(other));
    await waitFor(() => expect(hook.result.current.m3).toBeNull());
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiFetch.mock.calls.map(([p]) => p).sort()).toEqual([
      "/api/humans/creators/m1/card",
      "/api/humans/creators/m2/card",
      "/api/humans/creators/m3/card",
    ]);
    expect(hook.result.current.m1).toEqual(card);
    expect(fresh.result.current.m1).toEqual(card);

    const later = renderHook(() => useCreatorCards(["m1"]));
    expect(later.result.current.m1).toEqual(card);
  });
});
