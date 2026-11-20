// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: vi.fn(),
}));

import { useBuildSession } from "./useBuildSession";
import { resetSharedBuildReads } from "./useBuildPreview";
import { APPLY_SITE_EDITS_UNREACHABLE, sendSiteEditsOptimistic, useSiteEditsApply } from "./siteInlineEdits";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const T0 = Date.parse("2026-10-08T08:00:00.000Z");
const APPLIED = { id: "chg-1", status: "done", message: "Applied 1 edit", created_at: new Date(T0 + 60_000).toISOString() };

let refinesAnswer: () => unknown[] = () => [];

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
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string) => {
    if (path.includes("/refines?")) return json({ refines: refinesAnswer() });
    return json({ run: { id: "b1", status: "done", updated_at: new Date(T0 - 3_600_000).toISOString() } });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a text edit written straight to the site", () => {
  it("shows its Applied change in the chat right away, without a reload and without starting refine polling", async () => {
    const session = renderHook(() => useBuildSession("b1", null));
    const apply = renderHook(() => useSiteEditsApply("b1", false));
    await advance(0);
    expect(session.result.current.refines).toEqual([]);

    refinesAnswer = () => [APPLIED];
    act(() => apply.result.current.onApplied({ applied: 1, direct: true, conductorRunId: null }));
    await advance(0);

    expect(session.result.current.refines.map((r) => r.id)).toEqual(["chg-1"]);
    expect(apply.result.current.applying).toBe(false);
  });

  it("another session's direct edit does not reload this chat", async () => {
    const session = renderHook(() => useBuildSession("b1", null));
    const other = renderHook(() => useSiteEditsApply("b2", false));
    await advance(0);
    refinesAnswer = () => [APPLIED];
    const before = apiFetch.mock.calls.filter((c) => String(c[0]).includes("/refines?")).length;
    act(() => other.result.current.onApplied({ applied: 1, direct: true, conductorRunId: null }));
    await advance(0);
    expect(apiFetch.mock.calls.filter((c) => String(c[0]).includes("/refines?")).length).toBe(before);
    expect(session.result.current.refines).toEqual([]);
  });
});

describe("Send on the text tool puts its Applied line in the chat before the server answers", () => {
  let answerApply: (res: Response | Error) => void = () => undefined;
  beforeEach(() => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path.includes("/refines?")) return json({ refines: refinesAnswer() });
      if (path === "/api/website/site-edits/apply") {
        return new Promise<Response>((resolve, reject) => {
          answerApply = (r) => (r instanceof Error ? reject(r) : resolve(r));
        });
      }
      return json({ run: { id: "b1", status: "done", updated_at: new Date(T0 - 3_600_000).toISOString() } });
    });
  });

  it("shows Applied 2 edits as saving while the apply is in flight, without making the session look busy", async () => {
    const session = renderHook(() => useBuildSession("b1", null));
    const apply = renderHook(() => useSiteEditsApply("b1", false));
    await advance(0);
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = sendSiteEditsOptimistic("site:s1", "b1", 2, apply.result.current.onApplied);
    });
    await advance(0);
    expect(session.result.current.savingEdits.map((r) => ({ message: r.message, saving: r.saving }))).toEqual([{ message: "Applied 2 edits", saving: true }]);
    expect(session.result.current.refines).toEqual([]);

    refinesAnswer = () => [{ ...APPLIED, message: "Applied 2 edits" }];
    await act(async () => {
      answerApply(json({ applied: 2, applied_selectors: ["main > h1", "main > p"], remaining: 0, direct: true, rows_direct: 2, rows_fallback: 0, change_id: "chg-1" }));
      await outcome;
    });
    await advance(0);
    expect(await outcome).toEqual({ ok: true, direct: true, applied: 2, appliedSelectors: ["main > h1", "main > p"] });
    expect(session.result.current.refines.map((r) => r.id)).toEqual(["chg-1"]);
    expect(session.result.current.savingEdits).toEqual([]);
  });

  it("keeps the saving line until the real change has been read, so the chat never goes blank in between", async () => {
    const session = renderHook(() => useBuildSession("b1", null));
    const apply = renderHook(() => useSiteEditsApply("b1", false));
    await advance(0);
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = sendSiteEditsOptimistic("site:s1", "b1", 1, apply.result.current.onApplied);
    });
    await advance(0);
    let releaseRefines!: () => void;
    const refinesGate = new Promise<void>((r) => (releaseRefines = r));
    apiFetch.mockImplementation(async (path: string) => {
      if (path.includes("/refines?")) {
        await refinesGate;
        return json({ refines: [APPLIED] });
      }
      return json({ run: { id: "b1", status: "done" } });
    });
    await act(async () => {
      answerApply(json({ applied: 1, applied_selectors: ["main > h1"], remaining: 0, direct: true, rows_direct: 1, rows_fallback: 0, change_id: "chg-1" }));
      await outcome;
    });
    await advance(0);
    expect(session.result.current.savingEdits.map((r) => r.message)).toEqual(["Applied 1 edit"]);
    releaseRefines();
    await advance(0);
    expect(session.result.current.refines.map((r) => r.id)).toEqual(["chg-1"]);
    expect(session.result.current.savingEdits).toEqual([]);
  });

  it("a failed apply takes the saving line back out of the chat and reports the failure", async () => {
    const session = renderHook(() => useBuildSession("b1", null));
    const apply = renderHook(() => useSiteEditsApply("b1", false));
    await advance(0);
    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = sendSiteEditsOptimistic("site:s1", "b1", 1, apply.result.current.onApplied);
    });
    await advance(0);
    expect(session.result.current.savingEdits).toHaveLength(1);
    await act(async () => {
      answerApply(new Error("offline"));
      await outcome;
    });
    await advance(0);
    expect(await outcome).toEqual({ ok: false, message: APPLY_SITE_EDITS_UNREACHABLE });
    expect(session.result.current.savingEdits).toEqual([]);
    expect(session.result.current.refines).toEqual([]);
  });

  it("another session's saving line never shows in this chat", async () => {
    const session = renderHook(() => useBuildSession("b1", null));
    await advance(0);
    act(() => {
      void sendSiteEditsOptimistic("site:s2", "b2", 1, () => undefined);
    });
    await advance(0);
    expect(session.result.current.savingEdits).toEqual([]);
  });
});
