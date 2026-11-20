// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/optimisticBuildStart", () => ({ clearOptimisticBuildStart: vi.fn() }));

import { FAST_POLL_MS, resetSharedBuildReads, useBuildPreview } from "./useBuildPreview";

type Body = Record<string, unknown>;
type Reply = { status: number; body?: Body } | "hang" | "throw";
const replies = new Map<string, Reply[]>();

function reply(runId: string, r: Reply) {
  const list = replies.get(runId) ?? [];
  list.push(r);
  replies.set(runId, list);
}

function run(id: string, status: string, extra: Body = {}): Body {
  return {
    run: { id, status, stages: [], created_at: null, updated_at: null },
    preview: { kind: status === "done" ? "final" : "instant", url: `https://${id.toLowerCase()}-app.onrender.com` },
    is_current: true,
    ...extra,
  };
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
    if (next === "hang") return new Promise(() => {});
    if (next === "throw") throw new Error("network down");
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body } as Response;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function track(initial: string) {
  const seen: Array<{ prop: string; previewUrl: string | null; runId: string | null }> = [];
  const hook = renderHook(
    ({ id }) => {
      const s = useBuildPreview(true, 0, id);
      useLayoutEffect(() => {
        seen.push({ prop: id, previewUrl: s.previewUrl, runId: s.runId });
      });
      return s;
    },
    { initialProps: { id: initial } },
  );
  return { ...hook, seen };
}

describe("useBuildPreview switching Build sessions", () => {
  it("never renders the previous session's preview while the new session's read is in flight", async () => {
    reply("A", { status: 200, body: run("A", "done") });
    reply("B", "hang");
    const { result, rerender, seen } = track("A");
    await settle();
    expect(result.current.previewUrl).toBe("https://a-app.onrender.com");

    rerender({ id: "B" });
    await settle();
    const afterSwitch = seen.filter((r) => r.prop === "B");
    expect(afterSwitch.length).toBeGreaterThan(0);
    expect(afterSwitch.every((r) => r.previewUrl === null && r.runId !== "A")).toBe(true);
    expect(result.current.loaded).toBe(false);
  });

  it("does not keep showing the previous app while the new session's reads keep failing", async () => {
    reply("A", { status: 200, body: run("A", "active") });
    reply("B", { status: 503 });
    reply("B", "throw");
    reply("B", { status: 500 });
    const { result, rerender, seen } = track("A");
    await settle();
    expect(result.current.previewUrl).toBe("https://a-app.onrender.com");

    rerender({ id: "B" });
    await settle();
    await settle(FAST_POLL_MS * 4);
    const afterSwitch = seen.filter((r) => r.prop === "B");
    expect(afterSwitch.some((r) => r.previewUrl === "https://a-app.onrender.com")).toBe(false);
    expect(result.current.runId).toBeNull();
    expect(result.current.building).toBe(false);
  });

  it("shows the new session's preview once its read lands and keeps the settle counter", async () => {
    reply("A", { status: 200, body: run("A", "active") });
    reply("A", { status: 200, body: run("A", "done") });
    reply("B", { status: 200, body: run("B", "done") });
    const { result, rerender } = track("A");
    await settle();
    await settle(FAST_POLL_MS);
    expect(result.current.settledNonce).toBe(1);

    rerender({ id: "B" });
    await settle();
    expect(result.current.runId).toBe("B");
    expect(result.current.previewUrl).toBe("https://b-app.onrender.com");
    expect(result.current.settledNonce).toBe(1);
  });

  it("keeps the preview when the watch narrows from the tenant build to that same run", async () => {
    replies.set("", [{ status: 200, body: run("A", "active") }]);
    reply("A", "hang");
    const { result, rerender, seen } = renderHookNullable();
    await settle();
    expect(result.current.previewUrl).toBe("https://a-app.onrender.com");
    rerender({ id: "A" });
    await settle();
    expect(seen.filter((r) => r.prop === "A").every((r) => r.previewUrl === "https://a-app.onrender.com")).toBe(true);
  });
});

function renderHookNullable() {
  const seen: Array<{ prop: string | null; previewUrl: string | null }> = [];
  const hook = renderHook(
    ({ id }: { id: string | null }) => {
      const s = useBuildPreview(true, 0, id);
      useLayoutEffect(() => {
        seen.push({ prop: id, previewUrl: s.previewUrl });
      });
      return s;
    },
    { initialProps: { id: null as string | null } },
  );
  return { ...hook, seen };
}
