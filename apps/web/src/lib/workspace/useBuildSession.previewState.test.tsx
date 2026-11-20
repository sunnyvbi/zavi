// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: vi.fn() }));

import { MAX_SETTLE_TICKS, SETTLE_POLL_MS, UNPUBLISHED_PREVIEW_POLL_MS, resetSharedBuildReads } from "./useBuildPreview";
import { useBuildSession } from "./useBuildSession";

const PREVIEW = "https://5173-restored.e2b.app";

function status(previewState: "starting" | "stopped" | null, liveUrl: string | null = null) {
  return {
    run: { id: "site-run", status: "done", stages: [{ stage: "build", status: "done" }] },
    site: { id: "site-1", status: liveUrl ? "live" : "building", live_url: liveUrl },
    target: { live_url: liveUrl },
    app_ready: true,
    is_current: true,
    preview: previewState ? { kind: "none", url: null } : { kind: "instant", url: PREVIEW },
    ...(previewState ? { preview_state: previewState } : {}),
    publish: { status: liveUrl ? "live" : "none" },
  };
}

let current: unknown = status("stopped");
const statusReads = () => apiFetch.mock.calls.filter(([p]) => String(p).includes("build-status")).length;

async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSharedBuildReads();
  apiFetch.mockReset();
  current = status("stopped");
  apiFetch.mockImplementation(async (path: string) =>
    String(path).includes("refines")
      ? new Response(JSON.stringify({ refines: [] }))
      : new Response(JSON.stringify(current)),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps reading a finished unpublished site while its preview is stopped, so the chat copy follows a restart", async () => {
  const { result } = renderHook(() => useBuildSession("site-run", null));
  await tick();
  expect(result.current.previewState).toBe("stopped");
  await tick(SETTLE_POLL_MS * (MAX_SETTLE_TICKS + 2));
  current = status("starting");
  await tick(UNPUBLISHED_PREVIEW_POLL_MS);
  expect(result.current.previewState).toBe("starting");
  current = status(null);
  await tick(UNPUBLISHED_PREVIEW_POLL_MS);
  expect(result.current.previewState ?? null).toBeNull();
  expect(result.current.previewUrl).toBe(PREVIEW);
  const reads = statusReads();
  await tick(UNPUBLISHED_PREVIEW_POLL_MS * 3);
  expect(statusReads()).toBe(reads);
});

it("does not keep reading a published site", async () => {
  current = status(null, "https://shop.zaviagent.com");
  renderHook(() => useBuildSession("site-run", null));
  await tick();
  await tick(SETTLE_POLL_MS * (MAX_SETTLE_TICKS + 2));
  const reads = statusReads();
  await tick(UNPUBLISHED_PREVIEW_POLL_MS * 3);
  expect(statusReads()).toBe(reads);
});
