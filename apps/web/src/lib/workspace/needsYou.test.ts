import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeDecision } from "@/lib/approvals/decisionApi";
import type { WorkspaceThreadMeta } from "@/components/workspace/useAgentThreads";

const fetchHome = vi.fn();
vi.mock("@/lib/approvals/decisionApi", () => ({ fetchHome: (...a: unknown[]) => fetchHome(...a) }));
vi.mock("@/components/workspace/growth/ReviewRow", () => ({
  reviewDecisionText: (d: { body: { title?: string } }) => ({ title: d.body.title ?? "Untitled", why: "", agent: "Zavi" }),
}));

const {
  getNeedsYouSnapshot,
  needsYouItems,
  needsYouNavCount,
  needsYouRemaining,
  refreshNeedsYou,
  resetNeedsYouStore,
  NEEDS_YOU_HOMES,
} = await import("./needsYou");

function decision(id: string, at: string, over: Partial<HomeDecision> = {}): HomeDecision {
  return {
    id,
    agent_run_id: null,
    decision_class: "meta.budget",
    handler: null,
    body: { title: `card ${id}` },
    status: "proposed",
    emitted_at: at,
    dispatched_at: null,
    dispatch_error: null,
    home: "needs_you",
    home_channel: null,
    channel_slug: null,
    agent_slug: "cgo",
    thread_id: null,
    run_stopped: false,
    needs_owner_admin: false,
    ...over,
  } as HomeDecision;
}

function thread(id: string, over: Partial<WorkspaceThreadMeta> = {}): WorkspaceThreadMeta {
  return {
    id,
    agent_slug: "performance-marketer",
    title: "t",
    last_message_at: null,
    created_at: null,
    last_message: null,
    run_status: null,
    pending: null,
    ...over,
  };
}

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  resetNeedsYouStore();
  fetchHome.mockReset();
});

describe("needsYouItems", () => {
  it("merges approvals and unread chat questions, newest first", () => {
    const items = needsYouItems(
      [decision("d1", "2026-10-24T10:00:00Z"), decision("d2", "2026-10-24T12:00:00Z")],
      [
        thread("t1", { unread: true, unread_reply: { head: "Which city should I start in? I see two.", kind: "question", at: "2026-10-24T11:00:00Z" } }),
        thread("t2", { unread: true, unread_reply: { head: "Done.", kind: "reply", at: "2026-10-24T13:00:00Z" } }),
        thread("t3", { unread: false, unread_reply: null }),
      ],
      new Set(),
    );
    expect(items.map((i) => i.key)).toEqual(["approval:d2", "question:t1:2026-10-24T11:00:00Z", "approval:d1"]);
    const q = items[1]!;
    expect(q.kind === "question" && q.text).toBe("Which city should I start in?");
  });

  it("drops what the user closed, and a closed question does not hide the next one in that chat", () => {
    const t = (at: string) => thread("t1", { unread: true, unread_reply: { head: "Which?", kind: "question", at } });
    const dismissed = new Set(["approval:d1", "question:t1:2026-10-24T11:00:00Z"]);
    expect(needsYouItems([decision("d1", "2026-10-24T10:00:00Z")], [t("2026-10-24T11:00:00Z")], dismissed)).toEqual([]);
    expect(needsYouItems([], [t("2026-10-24T14:00:00Z")], dismissed)).toHaveLength(1);
  });

  it("names the agent that filed the card", () => {
    const [item] = needsYouItems([decision("d1", "2026-10-24T10:00:00Z", { agent_slug: "cgo" })], [], new Set());
    expect(item!.who).not.toBe("");
    expect(item!.text).toBe("card d1");
  });
});

describe("needsYouRemaining", () => {
  const snap = (ids: string[], total: number) => ({
    tenantId: "t",
    decisions: ids.map((id) => decision(id, "2026-10-24T10:00:00Z")),
    totals: { needs_you: total, growth: 0, channel: 0 },
    loaded: true,
  });
  it("subtracts a closed card only while it is still pending", () => {
    const items = needsYouItems(snap(["d1", "d2"], 150).decisions, [], new Set(["approval:d1"]));
    expect(needsYouRemaining(snap(["d1", "d2"], 150), items, new Set(["approval:d1"]))).toBe(149);
    expect(needsYouRemaining(snap(["d2"], 149), needsYouItems(snap(["d2"], 149).decisions, [], new Set(["approval:d1"])), new Set(["approval:d1"]))).toBe(149);
  });
});

describe("refreshNeedsYou", () => {
  it("reads every home with the true totals", async () => {
    fetchHome.mockResolvedValue({ decisions: [], next_cursor: null, totals: { needs_you: 3, growth: 1, channel: 0 } });
    await refreshNeedsYou("t-a");
    expect(fetchHome).toHaveBeenCalledWith(NEEDS_YOU_HOMES, { count: true, limit: 25 });
    expect(needsYouNavCount(getNeedsYouSnapshot())).toBe(3);
  });

  it("is single-flight: calls during a read collapse into one more read", async () => {
    const first = deferred<unknown>();
    fetchHome.mockReturnValueOnce(first.promise).mockResolvedValue({ decisions: [], next_cursor: null });
    const p = refreshNeedsYou("t-a");
    void refreshNeedsYou("t-a");
    void refreshNeedsYou("t-a");
    expect(fetchHome).toHaveBeenCalledTimes(1);
    first.resolve({ decisions: [], next_cursor: null });
    await p;
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchHome).toHaveBeenCalledTimes(2);
  });

  it("drops a response for a company that is no longer active", async () => {
    const first = deferred<unknown>();
    fetchHome.mockReturnValueOnce(first.promise).mockResolvedValue({ decisions: [], next_cursor: null, totals: { needs_you: 0, growth: 0, channel: 0 } });
    const p = refreshNeedsYou("t-a");
    void refreshNeedsYou("t-b");
    first.resolve({ decisions: [decision("x", "2026-10-24T10:00:00Z")], next_cursor: null, totals: { needs_you: 9, growth: 0, channel: 0 } });
    await p;
    await new Promise((r) => setTimeout(r, 0));
    const snap = getNeedsYouSnapshot();
    expect(snap.tenantId).toBe("t-b");
    expect(snap.decisions).toEqual([]);
    expect(needsYouNavCount(snap)).toBe(0);
  });

  it("keeps the last good list when a read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchHome.mockResolvedValueOnce({ decisions: [decision("d1", "2026-10-24T10:00:00Z")], next_cursor: null, totals: { needs_you: 1, growth: 0, channel: 0 } });
    await refreshNeedsYou("t-a");
    fetchHome.mockRejectedValueOnce(new Error("HTTP 503"));
    await refreshNeedsYou("t-a");
    expect(getNeedsYouSnapshot().decisions.map((d) => d.id)).toEqual(["d1"]);
    expect(needsYouNavCount(getNeedsYouSnapshot())).toBe(1);
    warn.mockRestore();
  });
});
