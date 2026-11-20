// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: vi.fn() }));

import { latestBusyRefine, startBuildRefine, useBuildSession } from "./useBuildSession";
import { resetSharedBuildReads } from "./useBuildPreview";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const reply = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const refineBodies = () =>
  apiFetch.mock.calls
    .filter((c) => String(c[0]).endsWith("/refine-product"))
    .map((c) => JSON.parse(String((c[1] as { body: string }).body)));
const classifierCalls = () => apiFetch.mock.calls.filter((c) => String(c[0]) === "/api/workspace/website/chat");

beforeEach(() => {
  resetSharedBuildReads();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith("/refine-product")) return reply({ ok: true });
    if (path.includes("refines")) return reply({ refines: [{ id: "r", message: "m", status: "queued", created_at: "x" }] });
    return reply({ run: { id: SESSION, status: "done" }, target: { live_url: "https://x.example.com" }, is_current: true });
  });
});

afterEach(() => cleanup());

describe("startBuildRefine", () => {
  it("shows a preview repair immediately while the POST is still pending, then removes it on refusal", async () => {
    let respond!: (r: ReturnType<typeof reply>) => void;
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/refine-product")) return new Promise((resolve) => { respond = resolve; });
      if (path.includes("refines")) return reply({ refines: [] });
      return reply({ run: { id: SESSION, status: "done" }, is_current: true });
    });
    const { result } = renderHook(() => useBuildSession(SESSION, null));
    await waitFor(() => expect(result.current.run?.id).toBe(SESSION));
    let sending!: ReturnType<typeof startBuildRefine>;
    act(() => { sending = startBuildRefine(SESSION, "Fix this error in the preview: missing import", { optimistic: true }); });
    expect(result.current.refines.map((r) => r.message)).toContain("Fix this error in the preview: missing import");
    await act(async () => { respond(reply({ error: { message: "Try again" } }, 503)); await sending; });
    expect(result.current.refines).toEqual([]);
  });
  it("keeps an accepted repair visible until the real row arrives, without duplicating it", async () => {
    let saved = false;
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/refine-product")) return reply({ conductor_run_id: "repair-1" });
      if (path.includes("refines")) return reply({ refines: saved ? [{ id: "repair-1", message: "Fix this error", status: "done", created_at: "x" }] : [] });
      return reply({ run: { id: SESSION, status: "done" }, is_current: true });
    });
    const { result } = renderHook(() => useBuildSession(SESSION, null));
    await waitFor(() => expect(result.current.run?.id).toBe(SESSION));
    await act(async () => { await startBuildRefine(SESSION, "Fix this error", { optimistic: true }); });
    expect(result.current.refines).toHaveLength(1);
    expect(result.current.refines[0].id).toBe("repair-1");
    saved = true;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.refines[0]?.status).toBe("done"));
    expect(result.current.refines).toHaveLength(1);
  });

  it("shows a change sent from the Build chat as running the moment the server accepts it, before the refines read has it", async () => {
    const session = "6b1f3c52-7a0e-4c55-9d1e-2f8a4b9c0d11";
    let saved = false;
    let respond!: (r: ReturnType<typeof reply>) => void;
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/refine-product")) return new Promise((resolve) => { respond = resolve; });
      if (path.includes("refines")) return reply({ refines: saved ? [{ id: "change-1", message: "make the button blue", status: "done", created_at: "x" }] : [] });
      return reply({ run: { id: session, status: "done" }, is_current: true });
    });
    const { result } = renderHook(() => useBuildSession(session, null));
    await waitFor(() => expect(result.current.run?.id).toBe(session));
    let sending!: ReturnType<typeof startBuildRefine>;
    act(() => { sending = startBuildRefine(session, "make the button blue", { optimistic: false, selection: null }); });
    expect(result.current.refines).toEqual([]);
    await act(async () => { respond(reply({ conductor_run_id: "change-1" })); await sending; });
    expect(result.current.refines.map((r) => [r.id, r.status])).toEqual([["change-1", "queued"]]);
    expect(latestBusyRefine(result.current.refines)?.id).toBe("change-1");
    saved = true;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.refines[0]?.status).toBe("done"));
    expect(result.current.refines).toHaveLength(1);
    expect(latestBusyRefine(result.current.refines)).toBeNull();
  });

  it("keeps checking for an accepted change when the read of the changes fails, so it never stays queued", async () => {
    const session = "c3a8e1f0-5d2b-4e7a-9b6c-1f0e2d3c4b55";
    let readsFail = true;
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/refine-product")) return reply({ conductor_run_id: "change-2" });
      if (path.includes("refines")) return readsFail ? reply({ error: "down" }, 500) : reply({ refines: [{ id: "change-2", message: "make it blue", status: "done", created_at: "x" }] });
      return reply({ run: { id: session, status: "done" }, is_current: true });
    });
    const { result } = renderHook(() => useBuildSession(session, null));
    await waitFor(() => expect(result.current.run?.id).toBe(session));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(async () => { await startBuildRefine(session, "make it blue", { optimistic: false, selection: null }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.refines.map((r) => [r.id, r.status])).toEqual([["change-2", "queued"]]);
      readsFail = false;
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(result.current.refines.map((r) => [r.id, r.status])).toEqual([["change-2", "done"]]);
      expect(latestBusyRefine(result.current.refines)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on an accepted change the server never lists after a minute: the row goes and the polling stops", async () => {
    const session = "e7b2c4d6-8f1a-4c3e-9d5b-6a7f8e9d0c22";
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/refine-product")) return reply({ conductor_run_id: "ghost-1" });
      if (path.includes("refines")) return reply({ refines: [] });
      return reply({ run: { id: session, status: "done" }, is_current: true });
    });
    const { result } = renderHook(() => useBuildSession(session, null));
    await waitFor(() => expect(result.current.run?.id).toBe(session));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      await act(async () => { await startBuildRefine(session, "make it blue", { optimistic: false, selection: null }); });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(result.current.refines.map((r) => r.id)).toEqual(["ghost-1"]);
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
      expect(result.current.refines).toEqual([]);
      const reads = apiFetch.mock.calls.filter((c) => String(c[0]).includes("refines")).length;
      await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
      expect(apiFetch.mock.calls.filter((c) => String(c[0]).includes("refines")).length).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not add a row for a retry, which replaces the change it retries", async () => {
    const session = "9e4d2a17-3b6c-4f80-8a5e-7c1b0f2d3e44";
    apiFetch.mockImplementation(async (path: string) => {
      if (path.endsWith("/refine-product")) return reply({ conductor_run_id: "retry-1" });
      if (path.includes("refines")) return reply({ refines: [] });
      return reply({ run: { id: session, status: "done" }, is_current: true });
    });
    const { result } = renderHook(() => useBuildSession(session, null));
    await waitFor(() => expect(result.current.run?.id).toBe(session));
    await act(async () => { await startBuildRefine(session, "x", { retryOf: "dcee9f28-0000-4000-8000-000000000000" }); });
    expect(result.current.refines).toEqual([]);
  });

  it("sends the message for this build, or a retry of an earlier change", async () => {
    await startBuildRefine(SESSION, "add a pricing section");
    await startBuildRefine(SESSION, "x", { retryOf: "dcee9f28-0000-4000-8000-000000000000" });
    expect(refineBodies()).toEqual([
      { message: "add a pricing section", conductor_run_id: SESSION },
      { retry_of: "dcee9f28-0000-4000-8000-000000000000", conductor_run_id: SESSION },
    ]);
  });
});

describe("useBuildSession sendRefine from the Build pane", () => {
  it("starts one plain refine, with no classifier call first", async () => {
    const { result } = renderHook(() => useBuildSession(SESSION, null));
    await waitFor(() => expect(result.current.run?.id).toBe(SESSION));
    let out: unknown = "unset";
    await act(async () => {
      out = await result.current.sendRefine("change the title to Bikes");
    });
    expect(out).toBeNull();
    expect(classifierCalls()).toHaveLength(0);
    expect(refineBodies()).toEqual([{ message: "change the title to Bikes", conductor_run_id: SESSION }]);
  });
});
