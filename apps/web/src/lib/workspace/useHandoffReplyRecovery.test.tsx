// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRunPanel } from "@zavi/shared";
import { useHandoffReplyRecovery } from "./useHandoffReplyRecovery";
import type { HandoffRun } from "./useHandoffProgress";

const child = (id = "child"): HandoffRun => ({
  run_id: id, agent_slug: "cgo", status: "success",
  panel: buildRunPanel([], { state: "finished" }),
});
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const visible = (value: "hidden" | "visible") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
};

beforeEach(() => { vi.useFakeTimers(); visible("visible"); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("bounded handoff reply recovery", () => {
  it("reports exhaustion, permits a fresh bounded reload, and clears on thread change", async () => {
    const refresh = vi.fn(async () => {});
    const { result, rerender } = renderHook(({ thread }) => useHandoffReplyRecovery(thread, [child()], new Set(), refresh), {
      initialProps: { thread: "one" },
    });
    expect(result.current.exhausted).toBe(false);
    await advance(65000);
    expect(result.current.exhausted).toBe(true);
    act(() => result.current.reload());
    expect(result.current.exhausted).toBe(false);
    await advance(65000);
    expect(refresh).toHaveBeenCalledTimes(14);
    expect(result.current.exhausted).toBe(true);
    rerender({ thread: "two" });
    expect(result.current.exhausted).toBe(false);
  });

  it("does not read for running, already-replied, or unbound children", async () => {
    const refresh = vi.fn();
    renderHook(() => useHandoffReplyRecovery("thread", [{ ...child(), status: "running" }], new Set(), refresh));
    renderHook(() => useHandoffReplyRecovery("thread", [child()], new Set(["child"]), refresh));
    renderHook(() => useHandoffReplyRecovery(null, [child()], new Set(), refresh));
    await advance(120000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("bounds reads even when polling and callback identities change", async () => {
    const refresh = vi.fn();
    const { rerender } = renderHook(() => useHandoffReplyRecovery("thread", [child()], new Set(), () => refresh()));
    for (let i = 0; i < 70; i++) { await advance(2000); rerender(); }
    expect(refresh).toHaveBeenCalledTimes(7);
  });

  it("stops immediately when a combined reply acknowledges all children", async () => {
    const refresh = vi.fn();
    const { rerender } = renderHook(({ ids }) => useHandoffReplyRecovery("thread", [child("a"), child("b")], ids, refresh), {
      initialProps: { ids: new Set<string>() },
    });
    await advance(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    rerender({ ids: new Set(["a", "b"]) });
    await advance(120000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not overlap reads, and discards scheduling from an old thread", async () => {
    let release!: () => void;
    const oldRefresh = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const newRefresh = vi.fn(async () => {});
    const { rerender, unmount } = renderHook(({ id, refresh }) => useHandoffReplyRecovery(id, [child()], new Set(), refresh), {
      initialProps: { id: "old", refresh: oldRefresh },
    });
    await advance(120000);
    expect(oldRefresh).toHaveBeenCalledTimes(1);
    rerender({ id: "new", refresh: newRefresh });
    await act(async () => release());
    await advance(1000);
    expect(oldRefresh).toHaveBeenCalledTimes(1);
    expect(newRefresh).toHaveBeenCalledTimes(2);
    unmount(); await advance(120000);
    expect(newRefresh).toHaveBeenCalledTimes(2);
  });

  it("pauses hidden reads and resumes once without resetting the budget", async () => {
    visible("hidden");
    const refresh = vi.fn(async () => {});
    renderHook(() => useHandoffReplyRecovery("thread", [child()], new Set(), refresh));
    await advance(120000);
    expect(refresh).not.toHaveBeenCalled();
    visible("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await advance(120000);
    expect(refresh).toHaveBeenCalledTimes(7);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(refresh).toHaveBeenCalledTimes(7);
  });

  it("retries a rejected read", async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    renderHook(() => useHandoffReplyRecovery("thread", [child()], new Set(), refresh));
    await advance(1000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
