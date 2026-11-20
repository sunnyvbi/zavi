// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import {
  chimeForSettledBuild,
  nextChime,
  useBuildDoneChime,
  type ChimeRefine,
} from "./buildChime";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("nextChime", () => {
  it("never chimes on the first look, so reopening Build over old finished changes is silent", () => {
    const r = nextChime(null, [{ id: "a", status: "done" }, { id: "b", status: "failed" }]);
    expect(r.chime).toBeNull();
  });

  it("chimes done when a change it saw running finishes", () => {
    const first = nextChime(null, [{ id: "a", status: "active" }]);
    expect(nextChime(first.seen, [{ id: "a", status: "done" }]).chime).toBe("done");
  });

  it("chimes failed when a running change fails, and failure wins over a simultaneous success", () => {
    const first = nextChime(null, [{ id: "a", status: "active" }, { id: "b", status: "provisioning" }]);
    expect(nextChime(first.seen, [{ id: "a", status: "done" }, { id: "b", status: "failed" }]).chime).toBe("failed");
  });

  it("stays silent for a change that appears already finished or was never running", () => {
    const first = nextChime(null, [{ id: "a", status: "done" }]);
    expect(nextChime(first.seen, [{ id: "a", status: "done" }, { id: "b", status: "done" }]).chime).toBeNull();
  });

  it("stays silent for a paused or cancelled change", () => {
    const first = nextChime(null, [{ id: "a", status: "active" }, { id: "b", status: "active" }]);
    expect(nextChime(first.seen, [{ id: "a", status: "paused" }, { id: "b", status: "cancelled" }]).chime).toBeNull();
  });
});

describe("chimeForSettledBuild", () => {
  it("maps the settled run status", () => {
    expect(chimeForSettledBuild("done")).toBe("done");
    expect(chimeForSettledBuild("failed")).toBe("failed");
    expect(chimeForSettledBuild("halted")).toBe("failed");
    expect(chimeForSettledBuild("cancelled")).toBeNull();
    expect(chimeForSettledBuild(null)).toBeNull();
  });
});

describe("useBuildDoneChime", () => {
  type Props = { settledNonce: number; runStatus: string | null; refines: ChimeRefine[] };
  function mount(initial: Props, active = true) {
    const play = vi.fn();
    const hook = renderHook((p: Props) => useBuildDoneChime({ active, ...p, play }), { initialProps: initial });
    return { play, ...hook };
  }

  it("mounting over an already finished build plays nothing", () => {
    const { play } = mount({ settledNonce: 3, runStatus: "done", refines: [{ id: "a", status: "done" }] });
    expect(play).not.toHaveBeenCalled();
  });

  it("plays done exactly once when the watched build finishes", () => {
    const { play, rerender } = mount({ settledNonce: 0, runStatus: "active", refines: [] });
    rerender({ settledNonce: 1, runStatus: "done", refines: [] });
    rerender({ settledNonce: 1, runStatus: "done", refines: [] });
    expect(play.mock.calls).toEqual([["done"]]);
  });

  it("plays when a change finishes", () => {
    const { play, rerender } = mount({ settledNonce: 0, runStatus: null, refines: [{ id: "r1", status: "active" }] });
    rerender({ settledNonce: 0, runStatus: null, refines: [{ id: "r1", status: "done" }] });
    expect(play.mock.calls).toEqual([["done"]]);
  });

  it("does not double-chime when a change and the build counter settle together", () => {
    const { play, rerender } = mount({ settledNonce: 0, runStatus: "active", refines: [{ id: "r1", status: "active" }] });
    rerender({ settledNonce: 1, runStatus: "done", refines: [{ id: "r1", status: "done" }] });
    expect(play).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(3100);
    });
    rerender({ settledNonce: 1, runStatus: "done", refines: [{ id: "r1", status: "done" }, { id: "r2", status: "active" }] });
    rerender({ settledNonce: 1, runStatus: "done", refines: [{ id: "r1", status: "done" }, { id: "r2", status: "done" }] });
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("is silent outside the Build surface", () => {
    const { play, rerender } = mount({ settledNonce: 0, runStatus: "active", refines: [{ id: "r1", status: "active" }] }, false);
    rerender({ settledNonce: 1, runStatus: "done", refines: [{ id: "r1", status: "done" }] });
    expect(play).not.toHaveBeenCalled();
  });
});
