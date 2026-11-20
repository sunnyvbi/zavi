import { describe, expect, it } from "vitest";
import { firstSentence, mergeHistory, unreadReplyPreview } from "./buildHistory";
import type { WorkspaceThreadMeta } from "@/components/workspace/useAgentThreads";

function thread(over: Partial<WorkspaceThreadMeta> = {}): WorkspaceThreadMeta {
  return {
    id: "t1",
    agent_slug: "performance-marketer",
    title: "Meta this week",
    last_message_at: "2026-10-24T10:00:00Z",
    created_at: "2026-10-24T09:00:00Z",
    last_message: null,
    run_status: "success",
    presentation_status: "answered",
    pending: null,
    ...over,
  };
}

describe("firstSentence", () => {
  it("strips markdown and stops at the first sentence", () => {
    expect(firstSentence("**41 bookings** for $1,240. Cost per booking fell 9%.")).toBe("41 bookings for $1,240.");
  });
  it("skips a short heading and reads the body", () => {
    expect(firstSentence("## Done\n\nI paused the ad set. It was losing money.")).toBe("I paused the ad set.");
  });
  it("does not cut inside a dollar amount or decimal", () => {
    expect(firstSentence("Raise it from $270.50 to $284 a day. ROAS held.")).toBe("Raise it from $270.50 to $284 a day.");
  });
  it("caps a long line with an ellipsis", () => {
    const out = firstSentence("word ".repeat(80));
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out.endsWith("…")).toBe(true);
  });
  it("is empty for nothing readable", () => {
    expect(firstSentence("```\n```")).toBe("");
    expect(firstSentence(null)).toBe("");
  });
});

describe("unreadReplyPreview", () => {
  it("is null unless the server says unread", () => {
    expect(unreadReplyPreview(thread({ unread: false, unread_reply: { head: "x.", kind: "reply", at: "a" } }))).toBeNull();
    expect(unreadReplyPreview(thread({ unread: true, unread_reply: null }))).toBeNull();
  });
  it("falls back to plain words when the reply is only a card", () => {
    expect(unreadReplyPreview(thread({ unread: true, unread_reply: { head: "", kind: "reply", at: "a" } }))?.text).toBe("Replied.");
    expect(unreadReplyPreview(thread({ unread: true, unread_reply: { head: "", kind: "question", at: "a" } }))?.text).toBe(
      "Has a question for you.",
    );
  });
});

describe("mergeHistory reply", () => {
  const unread = thread({ unread: true, unread_reply: { head: "41 bookings this week.", kind: "reply", at: "2026-10-24T10:00:00Z" } });

  it("carries the unread reply on the chat row, past the 15-minute pill TTL", () => {
    const [row] = mergeHistory([unread], [], { now: Date.parse("2026-10-24T12:00:00Z") });
    expect(row!.kind === "chat" && row!.reply).toEqual({ text: "41 bookings this week.", kind: "reply", at: "2026-10-24T10:00:00Z" });
  });

  it("drops it once this browser opened the chat after the reply", () => {
    const [row] = mergeHistory([unread], [], { seen: { t1: Date.parse("2026-10-24T10:05:00Z") } });
    expect(row!.kind === "chat" && row!.reply).toBeNull();
  });

  it("keeps it when the chat was opened before the reply landed", () => {
    const [row] = mergeHistory([unread], [], { seen: { t1: Date.parse("2026-10-24T09:30:00Z") } });
    expect(row!.kind === "chat" && row!.reply?.text).toBe("41 bookings this week.");
  });
});
