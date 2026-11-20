// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import {
  APPROVALS_LIST_CAP,
  __resetNeedsYouStore,
  currentNeedsYouSignal,
  needsYouState,
  pendingFromApprovals,
  publishFromPage,
  readNeedsYou,
  releaseFromPage,
  setNeedsYouTenant,
  signalOf,
  type NeedsYouInput,
} from "./needsYou";

const ok = (body: unknown) => ({ ok: true, json: async () => body });
const fail = () => ({ ok: false, json: async () => ({}) });

const q = (id: string) => ({ id, ordinal: 1, ask: "Raise the cap?", recommended: null, why: null, yes_no: true });
const move = (decision_id: string, state = "waiting") => ({
  decision_id,
  agent: "meta-ads",
  intent: "shift budget",
  why: null,
  aims_to_move: null,
  state,
  run_id: null,
  emitted_at: "2026-10-17T00:00:00Z",
  hypothesis_id: null,
});
const note = (rows: Array<{ line: string; question_ordinal?: number }>, more: { count: number } | null = null) => ({
  saw: [],
  changed: [],
  would_change: [],
  need: [],
  created_at: "2026-10-17T00:00:00Z",
  next_review_at: "2026-10-18T00:00:00Z",
  sections: [
    {
      key: "needs_you" as const,
      title: "Needs you",
      rows: rows.map((r) => ({ url: null, ...r })),
      more: more ? { count: more.count, url: "/workspace?tab=growth-strategy", line: "more" } : null,
    },
  ],
});

const base = (over: Partial<NeedsYouInput> = {}): NeedsYouInput => ({
  questions: { state: "ready", open: [] },
  pending: { total: 0, capped: false, toApprove: 0, inChannels: {} },
  note: null,
  goalWork: {},
  unreadable: [],
  ...over,
});

const totals = (growth: number, channel = 0, needs_you = 0) => ({ growth, channel, needs_you });

describe("pendingFromApprovals (true per-home totals, 2026-10-17)", () => {
  it("counts loose growth decisions plus every channel's pending work; PM and QA are not in the growth home", () => {
    const p = pendingFromApprovals({ channel_pending_counts: { meta_ads: 2, x: 0 } }, { totals: totals(1, 1, 9), ids: ["g1"] });
    expect(p).toEqual({ total: 3, capped: false, toApprove: 2, inChannels: { meta_ads: 2 }, marks: ["d:g1", "c:meta_ads#0", "c:meta_ads#1"] });
  });

  it("a total past the ids read still counts every item, never a capped floor", () => {
    const ids = Array.from({ length: APPROVALS_LIST_CAP }, (_, i) => `g${i}`);
    const p = pendingFromApprovals({}, { totals: totals(212), ids });
    expect(p).toMatchObject({ total: 212, capped: false, toApprove: 212 });
    expect(p?.marks).toHaveLength(212);
  });

  it("an unanswered home read is unknown, not zero", () => {
    expect(pendingFromApprovals({ channel_pending_counts: { tiktok: 4 } }, null)).toBeNull();
  });

  it("channel-only pending work still counts", () => {
    expect(pendingFromApprovals({ channel_pending_counts: { tiktok: 4 } }, { totals: totals(0), ids: [] })).toMatchObject({ total: 4 });
  });
});

describe("needsYouState", () => {
  it("adds questions, note rows, the note's 'N more', waiting moves and approvals", () => {
    const s = needsYouState(
      base({
        questions: { state: "ready", open: [q("a"), q("b")] },
        note: note([{ line: "Reconnect Meta" }, { line: "Q row", question_ordinal: 1 }], { count: 3 }),
        goalWork: {
          g1: { status_line: null, status_at: null, moves: [move("d1"), move("d2", "running")] } as never,
          g2: { status_line: null, status_at: null, moves: [move("d1")] } as never,
        },
        pending: { total: 4, capped: true, toApprove: 1, inChannels: {} },
      }),
    );
    expect(s).toMatchObject({ kind: "ready", total: 11, capped: true });
  });

  it("an older note's 'Left for you' lines count only when it stored its questions apart", () => {
    const old = { saw: [], changed: [], would_change: [], need: ["Approve the budget"], questions: ["Q?"], created_at: "", next_review_at: "" };
    expect(needsYouState(base({ note: old }))).toMatchObject({ kind: "ready", total: 1, capped: false });
    const older = { ...old, questions: undefined };
    expect(needsYouState(base({ note: older }))).toMatchObject({ kind: "ready", total: 0, capped: false });
  });

  it("is unknown while a source loads, and failed when one failed", () => {
    expect(needsYouState(base({ questions: { state: "loading", open: [] } }))).toEqual({ kind: "loading" });
    expect(needsYouState(base({ pending: "loading" }))).toEqual({ kind: "loading" });
    expect(needsYouState(base({ questions: { state: "failed", open: [] } }))).toEqual({ kind: "failed" });
    expect(needsYouState(base({ pending: null }))).toEqual({ kind: "failed" });
    expect(needsYouState(base({ unreadable: ["goal_work"] }))).toEqual({ kind: "failed" });
    expect(needsYouState(base({ unreadable: ["head_of_growth"] }))).toEqual({ kind: "failed" });
  });

  it("an unrelated unreadable section does not hide a real count", () => {
    const s = needsYouState(base({ unreadable: ["metrics", "changes"], questions: { state: "ready", open: [q("a")] } }));
    expect(signalOf(s)).toBe("yes");
  });
});

describe("the menu's signal", () => {
  const reads = () => apiFetch.mock.calls.length;

  beforeEach(() => {
    __resetNeedsYouStore();
    apiFetch.mockReset();
    window.localStorage.clear();
  });

  const answer = (questions: unknown[], approvals: unknown = { decisions: [] }, growth = { decisions: [], next_cursor: null, totals: totals(0) }) =>
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes("/growth/questions")) return ok({ questions });
      if (url.includes("/growth/plan")) return ok({ goals: { items: [] }, unreadable: [] });
      if (url.includes("/api/approvals?home=growth")) return ok(growth);
      return ok(approvals);
    });

  it("reads the four sources once even when every sidebar view asks at once", async () => {
    answer([q("a")]);
    await Promise.all([readNeedsYou(), readNeedsYou(), readNeedsYou()]);
    expect(reads()).toBe(4);
    expect(apiFetch).toHaveBeenCalledWith("/api/approvals?home=growth&count=1&limit=100");
    expect(currentNeedsYouSignal()).toBe("yes");
  });

  it("while the page owns the signal, the menu does not read and the dot is off (the founder is looking)", async () => {
    answer([]);
    publishFromPage({ kind: "ready", total: 2, capped: false });
    await readNeedsYou();
    expect(reads()).toBe(0);
    expect(currentNeedsYouSignal()).toBe("no");
    publishFromPage({ kind: "ready", total: 0, capped: false });
    expect(currentNeedsYouSignal()).toBe("no");
    publishFromPage({ kind: "loading" });
    expect(currentNeedsYouSignal()).toBe("no");
  });

  it("on page close it hands the signal back and the next read publishes", async () => {
    const changed = vi.fn();
    window.addEventListener("needs-you:changed", changed);
    publishFromPage({ kind: "ready", total: 1, capped: false });
    releaseFromPage();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(currentNeedsYouSignal()).toBe("no");
    answer([]);
    await readNeedsYou();
    expect(reads()).toBe(4);
    expect(currentNeedsYouSignal()).toBe("no");
    window.removeEventListener("needs-you:changed", changed);
  });

  it("a read started before the page opened cannot re-light the dot after the page closes", async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => (releaseSlow = r));
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes("/growth/plan")) await slow;
      if (url.includes("/growth/questions")) return ok({ questions: [q("old")] });
      if (url.includes("/growth/plan")) return ok({ goals: { items: [] }, unreadable: [] });
      return ok({ decisions: [] });
    });
    const stale = readNeedsYou();
    publishFromPage({ kind: "ready", total: 0, capped: false });
    apiFetch.mockImplementation(async (url: string) => {
      if (url.includes("/growth/questions")) return ok({ questions: [] });
      if (url.includes("/growth/plan")) return ok({ goals: { items: [] }, unreadable: [] });
      if (url.includes("/api/approvals?home=growth")) return ok({ decisions: [], next_cursor: null, totals: totals(0) });
      return ok({ decisions: [] });
    });
    releaseFromPage();
    await readNeedsYou();
    releaseSlow();
    await stale;
    expect(currentNeedsYouSignal()).toBe("no");
  });

  it("opening the page clears the dot; only something new lights it again", async () => {
    answer([q("a"), q("b")]);
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("yes");
    publishFromPage({ kind: "ready", total: 2, capped: false, marks: ["q:a", "q:b"] });
    releaseFromPage();
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("no");
    answer([q("a"), q("b"), q("c")]);
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("yes");
  });

  it("handled items leave the seen set, so the next new item still lights the dot", async () => {
    publishFromPage({ kind: "ready", total: 3, capped: false, marks: ["q:a", "q:b", "q:c"] });
    releaseFromPage();
    answer([q("a")]);
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("no");
    answer([q("a"), q("d")]);
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("yes");
  });

  it("an item that replaces a handled one lights the dot even when the total is unchanged", async () => {
    answer([q("a"), q("b")]);
    await readNeedsYou();
    publishFromPage({ kind: "ready", total: 2, capped: false, marks: ["q:a", "q:b"] });
    releaseFromPage();
    answer([q("a"), q("c")]);
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("yes");
  });

  it("a channel whose count grows past what was seen lights the dot", async () => {
    const approvals = (n: number) => ({ decisions: [], channel_pending_counts: { meta_ads: n } });
    answer([], approvals(2));
    await readNeedsYou();
    publishFromPage({ kind: "ready", total: 2, capped: false, marks: ["c:meta_ads#0", "c:meta_ads#1"] });
    releaseFromPage();
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("no");
    answer([], approvals(3));
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("yes");
  });

  it("opening the page in another tab clears this tab's dot", async () => {
    setNeedsYouTenant("t1");
    answer([q("a")]);
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("yes");
    const { renderHook } = await import("@testing-library/react");
    const { useNeedsYouSignal } = await import("./needsYou");
    const hook = renderHook(() => useNeedsYouSignal("t1"));
    window.localStorage.setItem("zavi:cgo-needs-seen:t1", JSON.stringify(["q:a"]));
    const { act } = await import("react");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "zavi:cgo-needs-seen:t1", newValue: JSON.stringify(["q:a"]) }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(hook.result.current).toBe("no");
    hook.unmount();
  });

  it("a note row is known by its id, so a same-wording replacement is new", () => {
    const row = (rid: string) => ({
      ...base(),
      note: { ...note([{ line: "Reconnect Meta" }]), sections: [{ key: "needs_you" as const, title: "Needs you", rows: [{ line: "Reconnect Meta", url: null, rid }], more: null }] },
    });
    const a = needsYouState(row("A"));
    const b = needsYouState(row("B"));
    expect(a.kind === "ready" && a.marks).toEqual(["n:A"]);
    expect(b.kind === "ready" && b.marks).toEqual(["n:B"]);
  });

  it("keeps the seen set per tenant across reloads", async () => {
    setNeedsYouTenant("t1");
    publishFromPage({ kind: "ready", total: 2, capped: false, marks: ["q:a", "q:b"] });
    releaseFromPage();
    __resetNeedsYouStore();
    answer([q("a"), q("b")]);
    setNeedsYouTenant("t1");
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("no");
    __resetNeedsYouStore();
    setNeedsYouTenant("t2");
    await readNeedsYou();
    expect(currentNeedsYouSignal()).toBe("yes");
  });

  it("a failed read is unknown, never 'nothing needs you'", async () => {
    apiFetch.mockImplementation(async (url: string) => (url.includes("/approvals") ? fail() : ok({ questions: [], unreadable: [] })));
    await readNeedsYou();
    expect(reads()).toBe(4);
    expect(currentNeedsYouSignal()).toBe("unknown");
  });
});
