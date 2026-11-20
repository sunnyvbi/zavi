// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (path: string) => `https://api.test${path}`,
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "tok-1" } } }) },
  }),
}));
const rawFetch = vi.fn(async () => new Response(null, { status: 204 }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: vi.fn(),
}));

import { BUILD_WATCH_PING_MS, resetBuildWatchPingForTests, useBuildWatchPing } from "./useBuildWatchPing";
import { useBuildSession } from "./useBuildSession";

const WATCH = "/api/workspace/autopilot/build-watch";
let visibility: DocumentVisibilityState = "visible";

const S1 = "0f8e2a7c-1b3d-4e5f-9a6b-7c8d9e0f1a2b";
const S2 = "9a9a9a9a-1111-4222-8333-444455556666";

const watchCalls = () =>
  apiFetch.mock.calls.filter(([path, init]) => path === WATCH && (init as RequestInit | undefined)?.method === "POST");
const pings = () => watchCalls().length;
const pingedSessions = () =>
  watchCalls().map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { session_id?: unknown }).session_id);

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

const leftCalls = () =>
  rawFetch.mock.calls
    .map((c) => c as unknown as [string, RequestInit])
    .filter(([url]) => url === `https://api.test${WATCH}`)
    .map(([, init]) => ({ init, body: JSON.parse(String(init.body)) as { session_id?: unknown; left?: unknown } }));

beforeEach(() => {
  rawFetch.mockClear();
  vi.stubGlobal("fetch", rawFetch);
  resetBuildWatchPingForTests();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) =>
    path === WATCH
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ run: { id: "b1", status: "active", stages: [] } }), { status: 200 }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useBuildWatchPing", () => {
  it("pings while the build page is visible, stops while hidden, and pings again on return", () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useBuildWatchPing(S1));
    expect(pings()).toBe(1);
    expect(pingedSessions()).toEqual([S1]);

    act(() => void vi.advanceTimersByTime(BUILD_WATCH_PING_MS));
    expect(pings()).toBe(2);

    act(() => setVisibility("hidden"));
    act(() => void vi.advanceTimersByTime(BUILD_WATCH_PING_MS * 4));
    expect(pings()).toBe(2);

    act(() => setVisibility("visible"));
    expect(pings()).toBe(3);

    unmount();
    act(() => void vi.advanceTimersByTime(BUILD_WATCH_PING_MS * 4));
    expect(pings()).toBe(3);
  });

  it("an inactive pane never pings, and a page opened in a background tab waits until it is seen", () => {
    vi.useFakeTimers();
    renderHook(() => useBuildWatchPing(null));
    act(() => void vi.advanceTimersByTime(BUILD_WATCH_PING_MS * 2));
    expect(pings()).toBe(0);

    visibility = "hidden";
    renderHook(() => useBuildWatchPing(S1));
    act(() => void vi.advanceTimersByTime(BUILD_WATCH_PING_MS * 2));
    expect(pings()).toBe(0);
    act(() => setVisibility("visible"));
    expect(pings()).toBe(1);
  });

  it("several panes on the same build session send one ping, not one each", () => {
    vi.useFakeTimers();
    renderHook(() => useBuildWatchPing(S1));
    renderHook(() => useBuildWatchPing(S1));
    renderHook(() => useBuildWatchPing(S1));
    expect(pings()).toBe(1);
  });

  it("two different build sessions each ping within the 10s gap, each with its own session id", () => {
    vi.useFakeTimers();
    renderHook(() => useBuildWatchPing(S1));
    act(() => void vi.advanceTimersByTime(1_000));
    renderHook(() => useBuildWatchPing(S2));
    expect(pingedSessions()).toEqual([S1, S2]);
  });

  it("switching the pane to another session pings for the new one at once", () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ id }: { id: string | null }) => useBuildWatchPing(id), { initialProps: { id: S1 as string | null } });
    rerender({ id: S2 });
    expect(pingedSessions()).toEqual([S1, S2]);
    rerender({ id: null });
    act(() => void vi.advanceTimersByTime(BUILD_WATCH_PING_MS * 3));
    expect(pingedSessions()).toEqual([S1, S2]);
  });

  it("an open build session pings with its own session id once its status says it is building; no session does not", async () => {
    renderHook(() => useBuildSession(null, null));
    expect(pings()).toBe(0);
    renderHook(() => useBuildSession("b1", null));
    await waitFor(() => expect(pingedSessions()).toEqual(["b1"]));
  });

  it("a finished build left open never pings", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === WATCH
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ run: { id: "b9", status: "done", stages: [] }, publish: { status: "live" } }), { status: 200 }),
    );
    const { result } = renderHook(() => useBuildSession("b9", null));
    await waitFor(() => expect(result.current.run?.status).toBe("done"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(pings()).toBe(0);
  });

  it("an inactive session never pings, even while visible", () => {
    vi.useFakeTimers();
    renderHook(() => useBuildWatchPing(S1, false));
    act(() => void vi.advanceTimersByTime(BUILD_WATCH_PING_MS * 3));
    expect(pings()).toBe(0);
  });

  it("hiding the page sends the session's left signal with keepalive and the founder's token, and coming back pings again at once", async () => {
    vi.useFakeTimers();
    renderHook(() => useBuildWatchPing(S1));
    expect(pings()).toBe(1);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => setVisibility("hidden"));
    expect(leftCalls()).toHaveLength(1);
    const [left] = leftCalls();
    expect(left.body).toEqual({ session_id: S1, left: true });
    expect(left.init.keepalive).toBe(true);
    expect(left.init.method).toBe("POST");
    expect(new Headers(left.init.headers).get("Authorization")).toBe("Bearer tok-1");
    act(() => void vi.advanceTimersByTime(1_000));
    act(() => setVisibility("visible"));
    expect(pings()).toBe(2);
  });

  it("closing one of several panes on a build (History) sends no left signal; the last pane to close sends it once", async () => {
    vi.useFakeTimers();
    const page = renderHook(() => useBuildWatchPing(S1));
    const history = renderHook(() => useBuildWatchPing(S1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    history.unmount();
    expect(leftCalls()).toHaveLength(0);
    const before = pings();
    act(() => void vi.advanceTimersByTime(BUILD_WATCH_PING_MS));
    expect(pings()).toBe(before + 1);
    page.unmount();
    expect(leftCalls().map((c) => c.body)).toEqual([{ session_id: S1, left: true }]);
  });

  it("closing the tab (pagehide) sends the left signal", async () => {
    renderHook(() => useBuildWatchPing(S2));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(leftCalls().map((c) => c.body)).toEqual([{ session_id: S2, left: true }]);
  });

  it("switching the pane to another build sends the old build's left signal, so its live email is not suppressed", async () => {
    const { rerender, unmount } = renderHook(({ id }: { id: string | null }) => useBuildWatchPing(id), { initialProps: { id: S1 as string | null } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    rerender({ id: S2 });
    expect(leftCalls().map((c) => c.body)).toEqual([{ session_id: S1, left: true }]);
    unmount();
    expect(leftCalls().map((c) => c.body)).toEqual([
      { session_id: S1, left: true },
      { session_id: S2, left: true },
    ]);
  });

  it("an inactive session sends no left signal", () => {
    renderHook(() => useBuildWatchPing(S1, false));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    act(() => setVisibility("hidden"));
    expect(leftCalls()).toEqual([]);
  });
});
