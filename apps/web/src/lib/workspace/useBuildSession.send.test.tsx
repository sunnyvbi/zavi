// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: vi.fn(),
}));

import { useBuildSession } from "./useBuildSession";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const BUSY = { id: "ref-new", message: "Make it blue", status: "queued", created_at: "2026-09-28T12:00:00Z" };

let refinesReadsAfterPost = 0;
let posted = false;
let appear = false;
let postStatus = 200;

beforeEach(() => {
  refinesReadsAfterPost = 0;
  posted = false;
  appear = false;
  postStatus = 200;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path.endsWith("/refine-product") && init?.method === "POST") {
      posted = true;
      return json(postStatus === 200 ? { ok: true } : { error: { message: "nope" } }, postStatus);
    }
    if (path.includes("refines")) {
      if (!posted) return json({ refines: [] });
      refinesReadsAfterPost += 1;
      return json({ refines: appear ? [BUSY] : [] });
    }
    return json({ run: { id: "b-send", status: "done" }, target: { live_url: "https://x.example.com" } });
  });
});

afterEach(() => cleanup());

describe("useBuildSession sendRefine keeps the composer busy until the change is really in flight", () => {
  it("stays submitting after the POST returns, until the refines list carries the new change", async () => {
    const { result } = renderHook(() => useBuildSession("b-send", null));
    await waitFor(() => expect(result.current.run?.id).toBe("b-send"));

    let settled: string | null | object = "unset";
    let done = false;
    act(() => {
      void result.current.sendRefine("Make it blue").then((r) => {
        settled = r;
        done = true;
      });
    });

    await waitFor(() => expect(posted).toBe(true));
    await waitFor(() => expect(refinesReadsAfterPost).toBeGreaterThanOrEqual(1));
    await waitFor(() => expect(refinesReadsAfterPost).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    expect(done).toBe(false);
    expect(result.current.refineSubmitting).toBe(true);
    expect(result.current.refines).toEqual([]);

    appear = true;
    await waitFor(() => expect(result.current.refines.map((r) => r.id)).toEqual(["ref-new"]), { timeout: 6000 });
    await waitFor(() => expect(done).toBe(true));
    expect(settled).toBeNull();
    expect(result.current.refineSubmitting).toBe(false);
  }, 10000);

  it("does not wait on a change the server refused", async () => {
    postStatus = 402;
    const { result } = renderHook(() => useBuildSession("b-send", null));
    await waitFor(() => expect(result.current.run?.id).toBe("b-send"));

    let settled: unknown = "unset";
    await act(async () => {
      settled = await result.current.sendRefine("Make it blue");
    });

    expect(settled).not.toBeNull();
    expect(result.current.refineSubmitting).toBe(false);
    expect(refinesReadsAfterPost).toBe(0);
  });
});
