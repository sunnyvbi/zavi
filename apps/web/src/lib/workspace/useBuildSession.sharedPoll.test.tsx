// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: vi.fn() }));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({
  clearOptimisticBuildStart: vi.fn(),
  markOptimisticBuildStart: vi.fn(),
}));

import { useBuildSession } from "./useBuildSession";
import { FAST_POLL_MS, NOT_CURRENT_BEFORE_STOPPING, resetSharedBuildReads, useBuildPreview } from "./useBuildPreview";

const reply = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const ACTIVE = {
  run: { id: "b1", status: "active", stages: [] },
  preview: { kind: "none" },
  is_current: true,
};

const statusCalls = () => apiFetch.mock.calls.filter((c) => String(c[0]).includes("build-status")).length;
const statusPaths = () =>
  new Set(apiFetch.mock.calls.map((c) => String(c[0])).filter((p) => p.includes("build-status")));

let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  resetSharedBuildReads();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) =>
    path.includes("refines") ? reply({ refines: [] }) : reply(ACTIVE),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("one build-status poller per build session", () => {
  it("three watchers of the same build make one status read per interval, not three", async () => {
    renderHook(() => useBuildSession("b1", null));
    renderHook(() => useBuildSession("b1", null));
    renderHook(() => useBuildPreview(true, 0, "b1"));
    await flush();
    const atMount = statusCalls();
    expect(atMount).toBe(3);
    expect(statusPaths()).toEqual(new Set(["/api/workspace/autopilot/build-status?run_id=b1"]));

    await advance(FAST_POLL_MS * 10);

    const polled = statusCalls() - atMount;
    expect(polled).toBeGreaterThanOrEqual(9);
    expect(polled).toBeLessThanOrEqual(11);
  });

  it("every watcher still gets the fresh answer from the shared read", async () => {
    const a = renderHook(() => useBuildSession("b1", null));
    const p = renderHook(() => useBuildPreview(true, 0, "b1"));
    await flush();
    apiFetch.mockImplementation(async (path: string) =>
      path.includes("refines")
        ? reply({ refines: [] })
        : reply({ ...ACTIVE, run: { ...ACTIVE.run, status: "done" }, preview: { kind: "final", url: "https://b1.example.com" } }),
    );
    await advance(FAST_POLL_MS);
    expect(a.result.current.run?.status).toBe("done");
    expect(p.result.current.previewUrl).toBe("https://b1.example.com");
  });

  it("stops polling while the tab is hidden and refreshes at once when it comes back", async () => {
    const { result } = renderHook(() => useBuildSession("b1", null));
    const preview = renderHook(() => useBuildPreview(true, 0, "b1"));
    await flush();
    const before = statusCalls();

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(FAST_POLL_MS * 20);
    const whileHidden = statusCalls() - before;
    expect(whileHidden).toBe(0);

    apiFetch.mockImplementation(async (path: string) =>
      path.includes("refines")
        ? reply({ refines: [] })
        : reply({ ...ACTIVE, run: { ...ACTIVE.run, status: "building_now" } }),
    );
    const hiddenTotal = statusCalls();
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(statusCalls() - hiddenTotal).toBe(1);
    expect(result.current.run?.status).toBe("building_now");
    expect(preview.result.current.runStatus).toBe("building_now");

    await advance(FAST_POLL_MS * 4);
    expect(statusCalls() - hiddenTotal).toBeGreaterThanOrEqual(4);
  });

  it("does not wake a finished build's watch on visibility change", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.includes("refines")
        ? reply({ refines: [] })
        : reply({ ...ACTIVE, run: { ...ACTIVE.run, status: "failed" }, preview: { kind: "none" } }),
    );
    renderHook(() => useBuildSession("b1", null));
    await flush();
    const settled = statusCalls();
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 4);
    });
    expect(statusCalls()).toBe(settled);
  });

  it("a superseded or missing session stops the preview watch once it persists, instead of polling on", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.includes("refines") ? reply({ refines: [] }) : reply({ error: { code: "build_not_found" } }, 404),
    );
    const p = renderHook(() => useBuildPreview(true, 0, "b1"));
    await flush();
    await advance(FAST_POLL_MS * 10);
    expect(statusCalls()).toBe(NOT_CURRENT_BEFORE_STOPPING);
    expect(p.result.current.loaded).toBe(true);
    expect(p.result.current.building).toBe(false);

    apiFetch.mockClear();
    apiFetch.mockImplementation(async (path: string) =>
      path.includes("refines") ? reply({ refines: [] }) : reply({ ...ACTIVE, is_current: false }),
    );
    renderHook(() => useBuildPreview(true, 0, "b2"));
    await flush();
    await advance(FAST_POLL_MS * 10);
    expect(statusCalls()).toBe(NOT_CURRENT_BEFORE_STOPPING);
  });
});
