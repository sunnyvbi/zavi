// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { POLL_CAP_MS, POLL_MS, noteSectionsOf, useGrowthPlan } from "./useGrowthPlan";

const planRow = {
  id: "plan-1",
  source: "typed",
  pending_acceptance: true,
  objective: "Grow",
  north_star_metric: null,
  constraint_lever_family: null,
  constraint_statement: null,
  constraint_confidence: null,
  basis_evidence: [],
  version: 1,
  updated_at: "2026-09-17T00:00:00Z",
};

let plan: unknown = null;
let extra: Record<string, unknown> = {};
const apiFetchMock = vi.fn(async (_path?: string) => ({
  ok: true,
  status: 200,
  json: async (): Promise<unknown> => ({ plan, ...extra }),
}));
vi.mock("@/lib/api", () => ({ apiFetch: (path: string) => apiFetchMock(path) }));

const settle = () => act(async () => {});
const startWatch = async (result: { current: { watchForPlan: () => void } }) => {
  await act(async () => {
    result.current.watchForPlan();
  });
};
const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  plan = null;
  extra = {};
  apiFetchMock.mockClear();
});

describe("useGrowthPlan goal_work", () => {
  it("keeps cgo's work per goal from the fetched payload, dropping malformed moves", async () => {
    extra = {
      goal_work: {
        g1: {
          status_line: "6 of 20 signups",
          status_at: "2026-09-26T10:00:00Z",
          moves: [
            { decision_id: "d1", agent: "seo", intent: "Fix titles", why: null, state: "waiting", run_id: null, emitted_at: "2026-09-26T10:00:00Z" },
            { decision_id: "d2", agent: "seo", intent: "x", state: "not_a_state" },
          ],
        },
      },
    };
    const { result } = renderHook(() => useGrowthPlan());
    await settle();
    const work = result.current.data?.goal_work;
    expect(work?.g1.status_line).toBe("6 of 20 signups");
    expect(work?.g1.moves.map((m) => m.decision_id)).toEqual(["d1"]);
  });

  it("an older backend without goal_work gives an empty map", async () => {
    const { result } = renderHook(() => useGrowthPlan());
    await settle();
    expect(result.current.data?.goal_work).toEqual({});
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useGrowthPlan polling", () => {
  it("does not poll when no draft was requested", async () => {
    renderHook(() => useGrowthPlan());
    await settle();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    await tick(POLL_MS * 5);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("polls while a draft is in progress and stops once the plan lands", async () => {
    const { result } = renderHook(() => useGrowthPlan());
    await settle();
    await startWatch(result);
    expect(result.current.drafting).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await tick(POLL_MS);
    await tick(POLL_MS);
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.drafting).toBe(true);

    plan = planRow;
    await tick(POLL_MS);
    expect(apiFetchMock).toHaveBeenCalledTimes(4);
    expect(result.current.data?.plan?.id).toBe("plan-1");
    expect(result.current.drafting).toBe(true);

    plan = { ...planRow, pending_acceptance: false, updated_at: "2026-09-17T00:00:01Z" };
    await tick(POLL_MS);
    expect(apiFetchMock).toHaveBeenCalledTimes(5);
    expect(result.current.drafting).toBe(false);

    await tick(POLL_MS * 5);
    expect(apiFetchMock).toHaveBeenCalledTimes(5);
  });

  it("waits for a NEW plan when one already existed at the request", async () => {
    plan = planRow;
    const { result } = renderHook(() => useGrowthPlan());
    await settle();
    act(() => result.current.watchForPlan());
    await tick(POLL_MS);
    expect(result.current.drafting).toBe(true);

    plan = { ...planRow, version: 2, pending_acceptance: false };
    await tick(POLL_MS);
    expect(result.current.drafting).toBe(false);
  });

  it("slows polling after ten minutes and still shows a plan arriving at minute thirteen", async () => {
    const { result } = renderHook(() => useGrowthPlan());
    await settle(); await startWatch(result); await tick(POLL_CAP_MS);
    expect(result.current.drafting).toBe(true);expect(result.current.draftSlow).toBe(true);
    const calls=apiFetchMock.mock.calls.length;
    await tick(60_000);expect(apiFetchMock.mock.calls.length-calls).toBe(2);
    plan={...planRow,pending_acceptance:false};await tick(2*60_000);
    expect(result.current.data?.plan?.id).toBe("plan-1");expect(result.current.drafting).toBe(false);
  });

  it("stops polling on unmount", async () => {
    const { result, unmount } = renderHook(() => useGrowthPlan());
    await settle();
    await startWatch(result);
    unmount();
    const calls = apiFetchMock.mock.calls.length;
    await tick(POLL_MS * 5);
    expect(apiFetchMock.mock.calls.length).toBe(calls);
  });

  it("keeps the rendered data when a background read fails", async () => {
    const { result } = renderHook(() => useGrowthPlan());
    await settle();
    await startWatch(result);
    apiFetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    await tick(POLL_MS);
    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
    expect(result.current.drafting).toBe(true);
  });
});

describe("noteSectionsOf: the fix descriptor and urgent flag survive sanitizing", () => {
  const section = (row: Record<string, unknown>) => [
    { key: "needs_you", title: "Needs you", rows: [{ line: "x", url: null, ...row }], more: null },
  ];
  it("keeps every well-formed fix kind", () => {
    const kinds = [
      { kind: "reconnect", slug: "tiktok_ads" },
      { kind: "budget" },
      { kind: "check", decision_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      { kind: "locations", channel_slug: "google_ads" },
      { kind: "action", channel_slug: "tiktok", action_id: "a1" },
    ];
    for (const fix of kinds) {
      const out = noteSectionsOf(section({ fix }))![0].rows[0];
      expect(out.fix).toEqual(fix);
    }
  });
  it("urgent survives only as literal true", () => {
    expect(noteSectionsOf(section({ urgent: true }))![0].rows[0].urgent).toBe(true);
    expect(noteSectionsOf(section({ urgent: "yes" }))![0].rows[0].urgent).toBeUndefined();
  });
  it("malformed fixes are dropped, never thrown", () => {
    for (const fix of [
      { kind: "reconnect" },
      { kind: "reconnect", slug: "<script>" },
      { kind: "check", decision_id: "not-a-uuid" },
      { kind: "nope" },
      "reconnect",
      42,
    ]) {
      const out = noteSectionsOf(section({ fix }))![0].rows[0];
      expect(out.fix).toBeUndefined();
    }
  });
});

describe("draft run failure", () => {
  it("stops watching a terminal failure and keeps its message through successful plan reads", async () => {
    const { result } = renderHook(() => useGrowthPlan());
    await settle();
    await act(async () => result.current.watchForPlan("run-1"));
    apiFetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ plan: null }) }))
      .mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ run: { status: "parse_failed" } }) }));
    await tick(POLL_MS);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/agents/runs/run-1");
    expect(result.current.drafting).toBe(false);
    expect(result.current.draftError).toMatch(/could not finish/i);
    await act(async () => result.current.refresh());
    expect(result.current.draftError).toMatch(/could not finish/i);
    expect(result.current.error).toBeNull();
  });
  it("a cancelled run (Start over, or a newer plan replaced the draft) stops the watch with no error", async () => {
    const { result } = renderHook(() => useGrowthPlan());
    await settle();
    await act(async () => result.current.watchForPlan("run-3"));
    apiFetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ plan: null }) }))
      .mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ run: { status: "cancelled" } }) }));
    await tick(POLL_MS);
    expect(result.current.drafting).toBe(false);
    expect(result.current.draftError ?? null).toBeNull();
  });
  it("a stopped watch ignores a late failure response", async () => {
    const { result } = renderHook(() => useGrowthPlan()); await settle();
    await act(async () => result.current.watchForPlan("run-2"));
    let finish!: (value: unknown) => void;
    apiFetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ plan: null }) }))
      .mockImplementationOnce(async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { finish = resolve; }) }));
    await tick(POLL_MS);
    await act(async () => { result.current.stopWatch(); finish({ run: { status: "error" } }); });
    expect(result.current.draftError).toBeNull();
  });
});
