// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ clearOptimisticBuildStart: vi.fn() }));

import {
  FAST_POLL_MS,
  NOT_CURRENT_BEFORE_STOPPING,
  SETTLE_POLL_MS,
  resetSharedBuildReads,
  useBuildPreview,
} from "./useBuildPreview";

type Body = Record<string, unknown>;
const replies = new Map<string, Array<{ status: number; body: Body }>>();

function reply(runId: string, status: number, body: Body = {}) {
  const list = replies.get(runId) ?? [];
  list.push({ status, body });
  replies.set(runId, list);
}

function run(id: string, status: string, extra: Body = {}): Body {
  return {
    run: { id, status, stages: [], created_at: null, updated_at: null },
    preview: { kind: status === "done" ? "final" : "none", url: status === "done" ? `https://${id}.onrender.com` : null },
    is_current: true,
    ...extra,
  };
}

function callsFor(runId: string) {
  return apiFetch.mock.calls.filter(([u]) => String(u).endsWith(`run_id=${runId}`)).length;
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetSharedBuildReads();
  replies.clear();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    const id = decodeURIComponent(String(path).split("run_id=")[1] ?? "");
    const list = replies.get(id) ?? [];
    const next = list.length > 1 ? list.shift()! : list[0];
    if (!next) throw new Error(`no reply for ${id}`);
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as Response;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useBuildPreview across a session switch", () => {
  it("does not count opening an already-finished session as a build that just settled", async () => {
    reply("A", 200, run("A", "active"));
    reply("B", 200, run("B", "done"));
    reply("C", 200, run("C", "failed"));
    const { result, rerender } = renderHook(({ id }) => useBuildPreview(true, 0, id), {
      initialProps: { id: "A" },
    });
    await settle();
    expect(result.current.building).toBe(true);

    rerender({ id: "B" });
    await settle();
    expect(result.current.runId).toBe("B");
    expect(result.current.settledNonce).toBe(0);

    rerender({ id: "A" });
    await settle();
    expect(result.current.building).toBe(true);
    rerender({ id: "C" });
    await settle();
    expect(result.current.runStatus).toBe("failed");
    expect(result.current.settledNonce).toBe(0);
  });

  it("still settles once when the session it switched to finishes while watched", async () => {
    reply("A", 200, run("A", "active"));
    reply("B", 200, run("B", "active"));
    reply("B", 200, run("B", "done"));
    const { result, rerender } = renderHook(({ id }) => useBuildPreview(true, 0, id), {
      initialProps: { id: "A" },
    });
    await settle();
    rerender({ id: "B" });
    await settle();
    expect(result.current.settledNonce).toBe(0);
    expect(result.current.building).toBe(true);
    await settle(FAST_POLL_MS);
    expect(result.current.runStatus).toBe("done");
    expect(result.current.settledNonce).toBe(1);
  });
});

describe("useBuildPreview when the session looks superseded", () => {
  it("keeps watching through a single is_current:false blip and still sees the build finish", async () => {
    reply("A", 200, run("A", "active"));
    reply("A", 200, run("A", "active", { is_current: false }));
    reply("A", 200, run("A", "active"));
    reply("A", 200, run("A", "done"));
    const { result } = renderHook(() => useBuildPreview(true, 0, "A"));
    await settle();
    await settle(FAST_POLL_MS);
    await settle(FAST_POLL_MS);
    await settle(FAST_POLL_MS);
    expect(callsFor("A")).toBe(4);
    expect(result.current.runStatus).toBe("done");
    expect(result.current.settledNonce).toBe(1);
  });

  it("keeps watching through a single 404 blip without blanking the build on screen", async () => {
    reply("A", 200, run("A", "active"));
    reply("A", 404);
    reply("A", 200, run("A", "active"));
    reply("A", 200, run("A", "done"));
    const { result } = renderHook(() => useBuildPreview(true, 0, "A"));
    await settle();
    await settle(FAST_POLL_MS);
    expect(result.current.runId).toBe("A");
    expect(result.current.building).toBe(true);
    await settle(FAST_POLL_MS);
    await settle(FAST_POLL_MS);
    expect(result.current.runStatus).toBe("done");
    expect(result.current.settledNonce).toBe(1);
  });

  it("stops once is_current:false persists, and never polls again", async () => {
    reply("A", 200, run("A", "active", { is_current: false }));
    renderHook(() => useBuildPreview(true, 0, "A"));
    await settle();
    await settle(FAST_POLL_MS * NOT_CURRENT_BEFORE_STOPPING * 2);
    expect(callsFor("A")).toBe(NOT_CURRENT_BEFORE_STOPPING);
    await settle(SETTLE_POLL_MS * 10);
    expect(callsFor("A")).toBe(NOT_CURRENT_BEFORE_STOPPING);
  });

  it("clears the build and stops once 404 persists", async () => {
    reply("A", 200, run("A", "active"));
    reply("A", 404);
    const { result } = renderHook(() => useBuildPreview(true, 0, "A"));
    await settle();
    await settle(FAST_POLL_MS * (NOT_CURRENT_BEFORE_STOPPING + 3));
    expect(callsFor("A")).toBe(1 + NOT_CURRENT_BEFORE_STOPPING);
    expect(result.current.runId).toBeNull();
    expect(result.current.building).toBe(false);
  });
});

describe("useBuildPreview — a failed first read keeps the session unclassified and polling", () => {
  it("classified stays false through a 500 and the hook keeps polling until a 2xx", async () => {
    reply("S", 500, {});
    reply("S", 200, run("S", "active", { site: { id: "site-1", status: "building" } }));
    const { result } = renderHook(() => useBuildPreview(true, 0, "S"));
    await settle();
    expect(result.current.loaded).toBe(true);
    expect(result.current.classified).toBe(false);
    await settle(FAST_POLL_MS);
    expect(result.current.classified).toBe(true);
    expect(result.current.site?.id).toBe("site-1");
    expect(callsFor("S")).toBeGreaterThanOrEqual(2);
  });
});
