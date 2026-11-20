import { describe, expect, it } from "vitest";
import { mergeHistory, type BuildSessionMeta } from "./buildHistory";
import type { WorkspaceThreadMeta } from "@/components/workspace/useAgentThreads";

function thread(
  id: string,
  at: string | null,
  title: string | null = null,
  agentSlug = "operator",
): WorkspaceThreadMeta {
  return {
    id,
    agent_slug: agentSlug,
    title,
    last_message_at: at,
    created_at: at,
    last_message: title ? null : "## Plan\nAdd a `GET /health` endpoint",
    run_status: null,
    pending: false,
  };
}

function session(
  id: string,
  at: string,
  title = "Customer CRM",
): BuildSessionMeta {
  return {
    id,
    title,
    request: `a customer CRM (${id})`,
    state: "ready",
    run_status: "done",
    created_at: at,
    last_activity_at: at,
    refine_count: 0,
    is_current: false,
  };
}

describe("mergeHistory", () => {
  it("interleaves chats and builds by recency, newest first", () => {
    const items = mergeHistory(
      [
        thread("c1", "2026-09-01T10:00:00Z", "Plan my launch"),
        thread("c2", "2026-09-03T10:00:00Z", "Copy"),
      ],
      [session("b1", "2026-09-02T10:00:00Z")],
    );
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      "chat:c2",
      "build:b1",
      "chat:c1",
    ]);
  });

  it("derives a readable chat title from the last message when untitled", () => {
    const [item] = mergeHistory([thread("c1", "2026-09-01T10:00:00Z")], []);
    expect(item.title).toBe("Plan Add a GET /health endpoint");
  });

  it("sorts rows without a timestamp last and keeps a stable order", () => {
    const items = mergeHistory(
      [thread("c1", null, "Old")],
      [session("b1", "2026-09-02T10:00:00Z")],
    );
    expect(items.map((i) => i.id)).toEqual(["b1", "c1"]);
  });

  it("carries each chat's agent slug so the row can open the right chat", () => {
    const items = mergeHistory(
      [
        thread("c1", "2026-09-01T10:00:00Z", "Plan my launch"),
        thread("c2", "2026-09-03T10:00:00Z", "Ad copy", "growth-lead"),
      ],
      [],
    );
    expect(
      items.map((i) => (i.kind === "chat" ? `${i.id}:${i.agentSlug}` : i.id)),
    ).toEqual(["c2:growth-lead", "c1:operator"]);
  });

  it("normalizes chat run state for the Recent status dot", () => {
    const items = mergeHistory(
      [
        {
          ...thread("c1", "2026-09-03T10:00:00Z", "Live"),
          run_status: "running",
        },
        {
          ...thread("c2", "2026-09-02T10:00:00Z", "Settled"),
          run_status: "running",
          presentation_status: "answered",
        },
        {
          ...thread("c3", "2026-09-01T10:00:00Z", "Queued"),
          run_status: "queued",
        },
        {
          ...thread("c4", "2026-08-31T10:00:00Z", "Broken"),
          run_status: "parse_failed",
          presentation_status: "failed",
        },
        { ...thread("c5", "2026-08-30T10:00:00Z", "Idle"), run_status: null },
      ],
      [],
    );
    expect(items.map((i) => i.status)).toEqual([
      "running",
      "completed",
      "running",
      "error",
      null,
    ]);
  });

  it("normalizes build state for the same Recent status dot", () => {
    const items = mergeHistory(
      [],
      [
        { ...session("b1", "2026-09-03T10:00:00Z"), state: "building" },
        { ...session("b2", "2026-09-02T10:00:00Z"), state: "ready" },
        { ...session("b3", "2026-09-01T10:00:00Z"), state: "failed" },
      ],
    );
    expect(items.map((i) => i.status)).toEqual([
      "running",
      "completed",
      "error",
    ]);
  });

  it("clears a finished dot once the row is opened or 15 minutes pass; running stays", () => {
    const at = Date.parse("2026-09-03T10:00:00Z");
    const threads = [
      { ...thread("done", "2026-09-03T10:00:00Z", "Done"), presentation_status: "answered" as const },
      { ...thread("seen", "2026-09-03T10:00:00Z", "Seen"), presentation_status: "failed" as const },
      { ...thread("live", "2026-09-03T10:00:00Z", "Live"), presentation_status: "running" as const },
      { ...thread("blocked", "2026-09-03T10:00:00Z", "Waiting"), run_status: "blocked" },
      { ...thread("reply", "2026-09-03T10:00:00Z", "Reply"), unread: true },
    ];
    const status = (now: number) =>
      Object.fromEntries(
        mergeHistory(threads, [], { now, seen: { seen: at + 1 } }).map((i) => [i.id, i.status]),
      );
    expect(status(at + 60_000)).toEqual({
      done: "completed",
      seen: null,
      live: "running",
      blocked: "running",
      reply: "completed",
    });
    expect(status(at + 16 * 60_000)).toEqual({
      done: null,
      seen: null,
      live: "running",
      blocked: "running",
      reply: null,
    });
  });

  it("keeps a failed dot past 15 minutes until the chat is opened", () => {
    const at = Date.parse("2026-09-03T10:00:00Z");
    const failed = [
      { ...thread("f", "2026-09-03T10:00:00Z", "Broke"), presentation_status: "failed" as const },
    ];
    const status = (seen: Record<string, number>) =>
      mergeHistory(failed, [], { now: at + 60 * 60_000, seen })[0].status;
    expect(status({})).toBe("error");
    expect(status({ f: at + 1 })).toBe(null);
  });
});

describe("publishing sessions in History", () => {
  it("keeps a publishing build running and marks a failed publish as an error", () => {
    const now = Date.parse("2026-09-29T12:00:00Z");
    const items = mergeHistory(
      [],
      [
        { ...session("p1", "2026-09-29T11:00:00Z"), state: "publishing", run_status: "active" },
        { ...session("p2", "2026-09-29T10:00:00Z"), state: "publish_failed", run_status: "paused" },
      ],
      { now, seen: { p1: now } },
    );
    expect(items.map((i) => [i.id, i.status, i.kind === "build" ? i.state : null])).toEqual([
      ["p1", "running", "publishing"],
      ["p2", "error", "publish_failed"],
    ]);
  });
});

describe("Recent stays clean (QA B36)", () => {
  it("hides a failed build superseded by a newer attempt at the same request", () => {
    const items = mergeHistory(
      [],
      [
        { ...session("old", "2026-10-01T01:37:00Z"), request: "A booking website for my dog grooming salon", state: "failed" },
        { ...session("new", "2026-10-01T03:19:00Z"), request: "a booking  website for my dog grooming salon", state: "failed" },
        { ...session("other", "2026-09-30T22:37:00Z"), request: "A bike repair shop", state: "failed" },
      ],
    );
    expect(items.map((i) => i.id)).toEqual(["new", "other"]);
  });

  it("keeps a failed build when the same request comes back much later", () => {
    const items = mergeHistory(
      [],
      [
        { ...session("sept", "2026-09-01T10:00:00Z"), request: "Coffee shop site", state: "failed" },
        { ...session("oct", "2026-10-01T10:00:00Z"), request: "Coffee shop site", state: "ready" },
      ],
    );
    expect(items.map((i) => i.id)).toEqual(["oct", "sept"]);
  });

  it("keeps an older attempt that worked even when the request repeats", () => {
    const items = mergeHistory(
      [],
      [
        { ...session("live", "2026-09-30T00:00:00Z"), request: "Coffee shop site", state: "ready" },
        { ...session("retry", "2026-10-01T00:00:00Z"), request: "Coffee shop site", state: "failed" },
      ],
    );
    expect(items.map((i) => i.id)).toEqual(["retry", "live"]);
  });

  it("orders a build by the founder's last request, not by background status writes", () => {
    const items = mergeHistory(
      [thread("chat", "2026-10-01T12:00:00Z", "Pricing question")],
      [
        {
          ...session("bg", "2026-10-01T11:55:00Z"),
          last_activity_at: "2026-10-01T12:11:00Z",
          last_request_at: "2026-10-01T11:55:00Z",
        },
        {
          ...session("edited", "2026-10-01T09:00:00Z"),
          last_activity_at: "2026-10-01T12:06:00Z",
          last_request_at: "2026-10-01T12:05:00Z",
        },
      ],
    );
    expect(items.map((i) => i.id)).toEqual(["edited", "chat", "bg"]);
    expect(items.find((i) => i.id === "bg")?.at).toBe(Date.parse("2026-10-01T12:11:00Z"));
  });
});
