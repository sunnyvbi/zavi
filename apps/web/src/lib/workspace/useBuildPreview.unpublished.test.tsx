// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { MAX_SETTLE_TICKS, SETTLE_POLL_MS, UNPUBLISHED_PREVIEW_POLL_MS, resetSharedBuildReads, useBuildPreview } from "./useBuildPreview";

const oldUrl = "https://5173-old.e2b.app";
const newUrl = "https://5173-restored.e2b.app";
function body(url: string | null, live = false) {
  return {
    run: { id: "draft-run", status: "done" },
    site: { id: "draft-site", status: live ? "live" : "building", live_url: live ? "https://shop.zaviagent.com" : null },
    app_ready: true,
    preview: { kind: url ? (live ? "final" : "instant") : "none", url },
    publish: { status: live ? "live" : "none" },
  };
}
async function tick(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
beforeEach(() => {
  vi.useFakeTimers();
  apiFetch.mockReset();
  resetSharedBuildReads();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it("keeps a finished unpublished site watched after settling so a dead preview can be replaced", async () => {
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(body(oldUrl))));
  const { result } = renderHook(() => useBuildPreview(true, 0, "draft-run"));
  await tick();
  await tick(SETTLE_POLL_MS * (MAX_SETTLE_TICKS + 2));
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(body(null))));
  await tick(UNPUBLISHED_PREVIEW_POLL_MS);
  expect(result.current.previewUrl).toBeNull();
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(body(newUrl))));
  await tick(UNPUBLISHED_PREVIEW_POLL_MS);
  expect(result.current.previewUrl).toBe(newUrl);
});

it("stops the sandbox watch when the site publishes", async () => {
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(body(oldUrl))));
  const { result } = renderHook(() => useBuildPreview(true, 0, "draft-run"));
  await tick();
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(body("https://shop.zaviagent.com", true))));
  await tick(UNPUBLISHED_PREVIEW_POLL_MS);
  expect(result.current.publish.status).toBe("live");
  const calls = apiFetch.mock.calls.length;
  await tick(UNPUBLISHED_PREVIEW_POLL_MS * 3);
  expect(apiFetch).toHaveBeenCalledTimes(calls);
});

it("parks the draft watch in a hidden tab and refreshes immediately when visible", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(body(oldUrl))));
  const { result } = renderHook(() => useBuildPreview(true, 0, "draft-run"));
  await tick();
  hidden.mockReturnValue(true);
  await tick(UNPUBLISHED_PREVIEW_POLL_MS * 4);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(body(newUrl))));
  hidden.mockReturnValue(false);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(result.current.previewUrl).toBe(newUrl);
});

it("stops the draft watch when the pane is disabled", async () => {
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(body(oldUrl))));
  const { rerender } = renderHook(({ enabled }) => useBuildPreview(enabled, 0, "draft-run"), { initialProps: { enabled: true } });
  await tick();
  rerender({ enabled: false });
  await tick(UNPUBLISHED_PREVIEW_POLL_MS * 3);
  expect(apiFetch).toHaveBeenCalledTimes(1);
});
