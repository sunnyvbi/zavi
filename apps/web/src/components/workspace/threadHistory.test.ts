import { describe, it, expect } from "vitest";
import {
  cleanPreview,
  liveUnreadThreadIds,
  sortByRecency,
  threadRunning,
  threadsNeedPoll,
  type ThreadMeta,
} from "./threadHistory";

function mk(over: Partial<ThreadMeta> & { id: string }): ThreadMeta {
  return {
    title: null,
    last_message_at: null,
    created_at: null,
    last_message: null,
    run_status: null,
    presentation_status: null,
    pending: null,
    ...over,
  };
}

describe("sortByRecency", () => {
  it("orders by last_message_at descending (newest first)", () => {
    const out = sortByRecency([
      mk({ id: "old", last_message_at: "2026-07-01T00:00:00Z" }),
      mk({ id: "new", last_message_at: "2026-07-10T00:00:00Z" }),
      mk({ id: "mid", last_message_at: "2026-07-05T00:00:00Z" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });

  it("sorts null last_message_at last, tie-broken by created_at desc", () => {
    const out = sortByRecency([
      mk({ id: "nulls-newer-created", last_message_at: null, created_at: "2026-07-09T00:00:00Z" }),
      mk({ id: "has-msg", last_message_at: "2026-07-02T00:00:00Z" }),
      mk({ id: "nulls-older-created", last_message_at: null, created_at: "2026-07-01T00:00:00Z" }),
    ]);
    expect(out.map((t) => t.id)).toEqual([
      "has-msg",
      "nulls-newer-created",
      "nulls-older-created",
    ]);
  });

  it("treats invalid/NaN dates as null (sorted last)", () => {
    const out = sortByRecency([
      mk({ id: "garbage", last_message_at: "not-a-date" }),
      mk({ id: "valid", last_message_at: "2026-07-04T00:00:00Z" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["valid", "garbage"]);
  });

  it("is deterministic on full ties via id ascending", () => {
    const out = sortByRecency([
      mk({ id: "b", last_message_at: "2026-07-04T00:00:00Z", created_at: "2026-07-01T00:00:00Z" }),
      mk({ id: "a", last_message_at: "2026-07-04T00:00:00Z", created_at: "2026-07-01T00:00:00Z" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("does NOT mutate the input array (pill order stays intact)", () => {
    const input = [
      mk({ id: "x", last_message_at: "2026-07-01T00:00:00Z" }),
      mk({ id: "y", last_message_at: "2026-07-09T00:00:00Z" }),
    ];
    const before = input.map((t) => t.id);
    const out = sortByRecency(input);
    expect(input.map((t) => t.id)).toEqual(before);
    expect(out).not.toBe(input);
    expect(out.map((t) => t.id)).toEqual(["y", "x"]);
  });
});

describe("cleanPreview", () => {
  it("returns empty string for null/blank", () => {
    expect(cleanPreview(null)).toBe("");
    expect(cleanPreview("   \n  ")).toBe("");
  });

  it("strips heading markers", () => {
    expect(cleanPreview("## Plan Add a health endpoint")).toBe(
      "Plan Add a health endpoint",
    );
  });

  it("unwraps inline code, keeping the text", () => {
    expect(cleanPreview("Add a `GET /health` endpoint returning `{ status }`")).toBe(
      "Add a GET /health endpoint returning { status }",
    );
  });

  it("reduces markdown links to their text", () => {
    expect(cleanPreview("Shipped — [PR #8](https://github.com/x/y/pull/8)")).toBe(
      "Shipped — PR #8",
    );
  });

  it("removes bold/italic emphasis markers", () => {
    expect(cleanPreview("**Done**: shipped the _footer_ update")).toBe(
      "Done: shipped the footer update",
    );
  });

  it("collapses newlines and whitespace to single spaces", () => {
    expect(cleanPreview("line one\n\n- bullet two\n  line three")).toBe(
      "line one bullet two line three",
    );
  });
});

describe("liveUnreadThreadIds", () => {
  const tab = (
    id: string,
    slug: string,
    threadId: string | null,
    kind = "agent",
  ) => ({ id, kind, payload: { kind: "agent", slug, threadId } });

  it("maps a flagged tab back to the thread it is bound to", () => {
    const ids = liveUnreadThreadIds(
      [tab("tab-1", "operator", "thread-1")],
      { "tab-1": true },
      "operator",
    );
    expect([...ids]).toEqual(["thread-1"]);
  });

  it("ignores a tab that is not flagged", () => {
    const ids = liveUnreadThreadIds(
      [tab("tab-1", "operator", "thread-1")],
      {},
      "operator",
    );
    expect(ids.size).toBe(0);
  });

  it("never lights a pill from ANOTHER agent's completion", () => {
    const ids = liveUnreadThreadIds(
      [tab("tab-1", "engineer", "thread-1")],
      { "tab-1": true },
      "operator",
    );
    expect(ids.size).toBe(0);
  });

  it("skips an unbound tab — a fresh chat has no thread to light", () => {
    const ids = liveUnreadThreadIds(
      [tab("tab-1", "operator", null)],
      { "tab-1": true },
      "operator",
    );
    expect(ids.size).toBe(0);
  });

  it("skips a non-agent tab", () => {
    const ids = liveUnreadThreadIds(
      [{ id: "tab-1", kind: "brain", payload: { kind: "brain" } }],
      { "tab-1": true },
      "operator",
    );
    expect(ids.size).toBe(0);
  });

  it("collects several flagged threads of the same agent", () => {
    const ids = liveUnreadThreadIds(
      [
        tab("tab-1", "operator", "thread-1"),
        tab("tab-2", "operator", "thread-2"),
        tab("tab-3", "operator", "thread-3"),
      ],
      { "tab-1": true, "tab-3": true },
      "operator",
    );
    expect([...ids].sort()).toEqual(["thread-1", "thread-3"]);
  });

  it("tolerates a malformed payload rather than throwing", () => {
    const ids = liveUnreadThreadIds(
      [{ id: "tab-1", kind: "agent", payload: null }],
      { "tab-1": true },
      "operator",
    );
    expect(ids.size).toBe(0);
  });
});

describe("threadsNeedPoll — poll only while a pill is lit", () => {
  const fresh = new Date().toISOString();
  it("polls while a run is running or queued", () => {
    expect(threadsNeedPoll([mk({ id: "a", run_status: "queued", last_message_at: fresh })])).toBe(true);
    expect(threadsNeedPoll([mk({ id: "a", presentation_status: "running" })])).toBe(true);
  });
  it("stops once every run is terminal (success, failed, cancelled)", () => {
    expect(
      threadsNeedPoll([
        mk({ id: "a", run_status: "success", presentation_status: "answered" }),
        mk({ id: "b", run_status: "cancelled", presentation_status: "cancelled" }),
        mk({ id: "c", run_status: "failed" }),
      ]),
    ).toBe(false);
  });
  it("presentation_status wins over a raw running status", () => {
    expect(threadRunning(mk({ id: "a", run_status: "running", presentation_status: "cancelled" }))).toBe(false);
  });
  it("keeps polling a live run on an old thread (a stuck-scan retry)", () => {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(threadsNeedPoll([mk({ id: "a", run_status: "running", last_message_at: old })])).toBe(true);
  });
});
