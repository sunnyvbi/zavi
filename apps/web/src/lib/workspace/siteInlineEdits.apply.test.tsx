// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { SITE_EDITS_APPLY_PICKUP_MS, siteEditsSendOutcome, useSiteEditsApply } from "./siteInlineEdits";
import { BUILD_REFINE_STARTED_EVENT } from "./useBuildSession";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount(sessionId: string | null = "sess-1", building = false) {
  const started: unknown[] = [];
  const onStarted = (e: Event) => started.push((e as CustomEvent).detail);
  window.addEventListener(BUILD_REFINE_STARTED_EVENT, onStarted);
  const hook = renderHook(({ id, b }) => useSiteEditsApply(id, b), { initialProps: { id: sessionId, b: building } });
  return { hook, started, stop: () => window.removeEventListener(BUILD_REFINE_STARTED_EVENT, onStarted) };
}

describe("applying a site's inline edits", () => {
  it("starts nothing when the server applied no edits", () => {
    const { hook, started, stop } = mount();
    act(() => hook.result.current.onApplied({ applied: 0 }));
    expect(started).toEqual([]);
    expect(hook.result.current.applying).toBe(false);
    stop();
  });

  it("announces the refine and stays applying until that refine finishes", () => {
    const { hook, started, stop } = mount();
    act(() => hook.result.current.onApplied({ applied: 2 }));
    expect(started).toEqual([{ sessionId: "sess-1" }]);
    expect(hook.result.current.applying).toBe(true);
    hook.rerender({ id: "sess-1", b: true });
    expect(hook.result.current.applying).toBe(true);
    hook.rerender({ id: "sess-1", b: false });
    expect(hook.result.current.applying).toBe(false);
    stop();
  });

  it("does not stay applying forever when the refine is never seen running", () => {
    vi.useFakeTimers();
    const { hook, stop } = mount();
    act(() => hook.result.current.onApplied({ applied: 1 }));
    act(() => {
      vi.advanceTimersByTime(SITE_EDITS_APPLY_PICKUP_MS - 1);
    });
    expect(hook.result.current.applying).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(hook.result.current.applying).toBe(false);
    stop();
  });

  it("never carries an apply over to another session", () => {
    const { hook, stop } = mount();
    act(() => hook.result.current.onApplied({ applied: 1 }));
    hook.rerender({ id: "sess-2", b: false });
    expect(hook.result.current.applying).toBe(false);
    hook.rerender({ id: "sess-1", b: false });
    expect(hook.result.current.applying).toBe(false);
    stop();
  });
});

describe("a direct text apply", () => {
  it("opens no running change card and starts no refine polling", () => {
    const { hook, started, stop } = mount();
    act(() => hook.result.current.onApplied({ applied: 2, direct: true, conductorRunId: null }));
    expect(started).toEqual([]);
    expect(hook.result.current.applying).toBe(false);
    stop();
  });

  it("a partial apply whose leftovers became a refine keeps today's card and polling", () => {
    const { hook, started, stop } = mount();
    act(() => hook.result.current.onApplied({ applied: 2, direct: true, conductorRunId: "run-1" }));
    expect(started).toEqual([{ sessionId: "sess-1" }]);
    expect(hook.result.current.applying).toBe(true);
    stop();
  });

  it("the send outcome says direct only when no refine was started", () => {
    const base = { ok: true as const, applied: 1, appliedSelectors: ["main > h1"], remaining: 0, rowsDirect: 1, rowsFallback: 0 };
    expect(siteEditsSendOutcome({ ...base, direct: true, conductorRunId: null })).toEqual({ ok: true, direct: true, applied: 1, appliedSelectors: ["main > h1"] });
    expect(siteEditsSendOutcome({ ...base, direct: true, conductorRunId: "run-1" })).toEqual({ ok: true, applied: 1, appliedSelectors: ["main > h1"] });
    expect(siteEditsSendOutcome({ ...base, direct: false, conductorRunId: "run-1" })).toEqual({ ok: true, applied: 1, appliedSelectors: ["main > h1"] });
  });
});
