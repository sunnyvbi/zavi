// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({
  clearOptimisticBuildStart: vi.fn(),
}));

import {
  FAST_POLL_MS,
  UNAUTHORIZED_BEFORE_GIVING_UP,
  useBuildPreview,
} from "./useBuildPreview";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const statusCalls = () =>
  apiFetch.mock.calls.filter((c) => String(c[0]).includes("build-status")).length;

const ACTIVE_RUN = {
  run: { id: "r1", status: "active", stages: [], created_at: null, updated_at: null },
  preview: { kind: "none" },
};

beforeEach(() => {
  apiFetch.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useBuildPreview — an expired session stops the watch", () => {
  it("gives a first 401 a second chance, then stops on the second", async () => {
    apiFetch.mockResolvedValue(json({}, 401));

    const { result } = renderHook(() => useBuildPreview(true, 0));

    await waitFor(
      () => expect(statusCalls()).toBe(UNAUTHORIZED_BEFORE_GIVING_UP),
      { timeout: FAST_POLL_MS * UNAUTHORIZED_BEFORE_GIVING_UP + 1500 },
    );
    expect(result.current.loaded).toBe(true);

    await new Promise((r) => setTimeout(r, FAST_POLL_MS + 400));
    expect(statusCalls()).toBe(UNAUTHORIZED_BEFORE_GIVING_UP);
  });

  it("recovers when a first 401 is followed by a good answer", async () => {
    let tick = 0;
    apiFetch.mockImplementation(async () => {
      tick += 1;
      return tick === 1 ? json({}, 401) : json(ACTIVE_RUN);
    });

    const { result } = renderHook(() => useBuildPreview(true, 0));

    await waitFor(() => expect(result.current.runId).toBe("r1"), {
      timeout: FAST_POLL_MS * 3,
    });
  });

  it("does not count 401, 500, 401 as two strikes", async () => {
    let tick = 0;
    apiFetch.mockImplementation(async () => {
      tick += 1;
      if (tick === 1) return json(ACTIVE_RUN);
      if (tick === 2) return json({}, 401);
      if (tick === 3) return json({}, 500);
      if (tick === 4) return json({}, 401);
      return json(ACTIVE_RUN);
    });

    const { result } = renderHook(() => useBuildPreview(true, 0));

    await waitFor(() => expect(statusCalls()).toBeGreaterThanOrEqual(5), {
      timeout: FAST_POLL_MS * 6,
    });
    expect(result.current.runId).toBe("r1");
  }, 20_000);

  it("keeps the last known build on screen when the session dies", async () => {
    let tick = 0;
    apiFetch.mockImplementation(async () => {
      tick += 1;
      return tick === 1 ? json(ACTIVE_RUN) : json({}, 401);
    });

    const { result } = renderHook(() => useBuildPreview(true, 0));

    await waitFor(() => expect(result.current.runId).toBe("r1"));
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(1), {
      timeout: FAST_POLL_MS + 1500,
    });

    expect(result.current.runId).toBe("r1");
    expect(result.current.runStatus).toBe("active");
  });

  it("still retries a NON-401 error over a build it has already seen", async () => {
    let tick = 0;
    apiFetch.mockImplementation(async () => {
      tick += 1;
      if (tick === 1) return json(ACTIVE_RUN);
      if (tick === 2) return json({}, 500);
      return json(ACTIVE_RUN);
    });

    const { result } = renderHook(() => useBuildPreview(true, 0));

    await waitFor(() => expect(result.current.runId).toBe("r1"));
    await waitFor(() => expect(statusCalls()).toBeGreaterThanOrEqual(3), {
      timeout: FAST_POLL_MS * 3,
    });
  });
});
