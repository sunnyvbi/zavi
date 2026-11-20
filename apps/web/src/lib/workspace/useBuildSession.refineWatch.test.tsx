// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: vi.fn(),
}));

import { latestBusyRefine, REFINES_WATCH_WINDOW_MS, refinesWatchDelay, useBuildSession } from "./useBuildSession";
import { resetSharedBuildReads } from "./useBuildPreview";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const T0 = Date.parse("2026-10-06T10:00:00.000Z");
const MIN = 60_000;

let refinesAnswer: () => unknown[] = () => [];
let doneAt = new Date(T0).toISOString();

const refineCalls = () => apiFetch.mock.calls.filter((c) => String(c[0]).includes("refines")).length;
const fixPass = (status: string) => ({ id: "fix-1", status, message: "The site's preview shows an error to visitors", created_at: new Date(T0 + 4 * MIN).toISOString() });

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
  resetSharedBuildReads();
  refinesAnswer = () => [];
  doneAt = new Date(T0).toISOString();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) =>
    path.includes("refines")
      ? json({ refines: refinesAnswer() })
      : json({ run: { id: "b1", status: "done", updated_at: doneAt } }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a fix pass the server starts after the build finished", () => {
  it("shows up as a change in progress in the open tab within one slow poll", async () => {
    const { result } = renderHook(() => useBuildSession("b1", null));
    await advance(0);
    expect(result.current.run?.status).toBe("done");
    expect(latestBusyRefine(result.current.refines)).toBeNull();

    await advance(4 * MIN);
    refinesAnswer = () => [fixPass("active")];
    expect(latestBusyRefine(result.current.refines)).toBeNull();
    await advance(30_000);
    expect(latestBusyRefine(result.current.refines)?.id).toBe("fix-1");

    refinesAnswer = () => [fixPass("done")];
    await advance(8_000);
    expect(latestBusyRefine(result.current.refines)).toBeNull();
    expect(result.current.refines.map((r) => r.status)).toEqual(["done"]);
  });

  it("stops watching once ten minutes have passed since the build finished", async () => {
    renderHook(() => useBuildSession("b1", null));
    await advance(0);
    await advance(REFINES_WATCH_WINDOW_MS + MIN);
    const atWindowEnd = refineCalls();
    expect(atWindowEnd).toBeGreaterThanOrEqual(19);
    expect(atWindowEnd).toBeLessThanOrEqual(23);
    await advance(30 * MIN);
    expect(refineCalls()).toBe(atWindowEnd);
  });

  it("never polls for a build that finished long ago", async () => {
    doneAt = new Date(T0 - 2 * 60 * MIN).toISOString();
    renderHook(() => useBuildSession("b1", null));
    await advance(0);
    const afterMount = refineCalls();
    expect(afterMount).toBe(1);
    await advance(20 * MIN);
    expect(refineCalls()).toBe(afterMount);
  });

  it("watches only a finished build with a known finish time", () => {
    const run = { id: "b1", objective: null, createdAt: null, stages: [], failure: null };
    expect(refinesWatchDelay({ ...run, status: "done", updatedAt: new Date(T0).toISOString() }, T0 + MIN)).toBe(30_000);
    expect(refinesWatchDelay({ ...run, status: "done", updatedAt: new Date(T0).toISOString() }, T0 + REFINES_WATCH_WINDOW_MS - 5_000)).toBe(5_000);
    expect(refinesWatchDelay({ ...run, status: "done", updatedAt: new Date(T0).toISOString() }, T0 + REFINES_WATCH_WINDOW_MS)).toBeNull();
    expect(refinesWatchDelay({ ...run, status: "active", updatedAt: new Date(T0).toISOString() }, T0)).toBeNull();
    expect(refinesWatchDelay({ ...run, status: "failed", updatedAt: new Date(T0).toISOString() }, T0)).toBeNull();
    expect(refinesWatchDelay({ ...run, status: "done", updatedAt: null }, T0)).toBeNull();
    expect(refinesWatchDelay(null, T0)).toBeNull();
  });
});
