import { describe, expect, it } from "vitest";
import { mergeHistory, type BuildSessionMeta } from "./buildHistory";
import type { WorkspaceThreadMeta } from "@/components/workspace/useAgentThreads";

const NOW = Date.parse("2026-10-01T12:00:00Z");

function chat(id: string, created: string, last: string, extra: Partial<WorkspaceThreadMeta> = {}): WorkspaceThreadMeta {
  return {
    id,
    agent_slug: "operator",
    title: `Chat ${id}`,
    created_at: created,
    last_message_at: last,
    last_message: null,
    run_status: "done",
    pending: false,
    ...extra,
  };
}

function build(id: string, created: string, last: string, extra: Partial<BuildSessionMeta> = {}): BuildSessionMeta {
  return {
    id,
    title: `Build ${id}`,
    request: "",
    state: "ready",
    run_status: "done",
    created_at: created,
    last_activity_at: last,
    refine_count: 0,
    is_current: false,
    ...extra,
  };
}

const ids = (items: { kind: string; id: string }[]) => items.map((i) => `${i.kind}:${i.id}`);

describe("DEL-1323 B36: Recent rows stay still while you watch", () => {
  const threads = [
    chat("a", "2026-10-01T09:00:00Z", "2026-10-01T09:05:00Z"),
    chat("b", "2026-10-01T10:00:00Z", "2026-10-01T10:01:00Z"),
  ];
  const sessions = [build("s", "2026-10-01T11:00:00Z", "2026-10-01T11:02:00Z")];

  it("a reply streaming into an old chat does not move it to the top", () => {
    const before = mergeHistory(threads, sessions, { now: NOW, stable: true });
    const streaming = [
      chat("a", "2026-10-01T09:00:00Z", "2026-10-01T11:59:00Z", { presentation_status: "running" }),
      threads[1]!,
    ];
    const during = mergeHistory(streaming, sessions, { now: NOW, stable: true });
    expect(ids(before)).toEqual(["build:s", "chat:b", "chat:a"]);
    expect(ids(during)).toEqual(ids(before));
    expect(ids(mergeHistory(streaming, sessions, { now: NOW }))).toEqual(["chat:a", "build:s", "chat:b"]);
  });

  it("the yellow dot means a build in progress, never an ordinary chat reply being written", () => {
    const running = [chat("a", "2026-10-01T09:00:00Z", "2026-10-01T11:59:00Z", { presentation_status: "running" })];
    const building = [build("s", "2026-10-01T11:00:00Z", "2026-10-01T11:59:00Z", { state: "building" })];
    const stable = mergeHistory(running, building, { now: NOW, stable: true });
    expect(stable.find((i) => i.id === "a")!.status).toBeNull();
    expect(stable.find((i) => i.id === "s")!.status).toBe("running");
    expect(mergeHistory(running, building, { now: NOW }).find((i) => i.id === "a")!.status).toBe("running");
  });

  it("a chat still shows its new-reply dot once the reply has landed", () => {
    const answered = [chat("a", "2026-10-01T09:00:00Z", "2026-10-01T11:58:00Z", { presentation_status: "answered" })];
    expect(mergeHistory(answered, [], { now: NOW, stable: true })[0]!.status).toBe("completed");
  });

  it("a row the list sends twice shows once", () => {
    const dup = [threads[0]!, threads[0]!];
    expect(ids(mergeHistory(dup, [sessions[0]!, sessions[0]!], { now: NOW, stable: true }))).toEqual(["build:s", "chat:a"]);
    expect(mergeHistory(dup, [], { now: NOW })).toHaveLength(2);
  });

  it("a build's own chat folds under the build instead of a second row", () => {
    const linked = [build("s", "2026-10-01T11:00:00Z", "2026-10-01T11:02:00Z", { chat_thread_ids: ["b"] })];
    expect(ids(mergeHistory(threads, linked, { now: NOW, foldBuildChats: true }))).toEqual(["build:s", "chat:a"]);
    expect(ids(mergeHistory(threads, linked, { now: NOW }))).toContain("chat:b");
  });

  it("rows with the same title get the site name, else the date, so they can be told apart", () => {
    const builds = [
      build("s1", "2026-09-28T12:00:00Z", "2026-09-28T12:00:00Z", {
        title: "Bakery website",
        site: { hostname: "rise.zaviagent.com", live_url: null, status: "live", name: "Rise Bakery" },
      }),
      build("s2", "2026-09-30T12:00:00Z", "2026-09-30T12:00:00Z", { title: "Bakery website" }),
    ];
    const chats = [
      chat("c1", "2026-09-20T12:00:00Z", "2026-09-20T12:00:00Z", { title: "New Chat" }),
      chat("c2", "2026-09-25T12:00:00Z", "2026-09-25T12:00:00Z", { title: "New Chat" }),
      chat("c3", "2026-09-26T12:00:00Z", "2026-09-26T12:00:00Z", { title: "Pricing ideas" }),
    ];
    const items = mergeHistory(chats, builds, { now: NOW, stable: true });
    const title = (id: string) => items.find((i) => i.id === id)!.title;
    expect(title("s1")).toBe("Bakery website · Rise Bakery");
    expect(title("s2")).toBe("Bakery website · Sep 30");
    expect(title("c1")).toBe("New Chat · Sep 20");
    expect(title("c2")).toBe("New Chat · Sep 25");
    expect(title("c3")).toBe("Pricing ideas");
    expect(new Set(items.map((i) => i.title)).size).toBe(items.length);
    const off = mergeHistory(chats, builds, { now: NOW });
    expect(off.filter((i) => i.title === "New Chat")).toHaveLength(2);
  });

  it("same title on the same day falls back to the time", () => {
    const chats = [
      chat("c1", "2026-09-20T09:00:00Z", "2026-09-20T09:00:00Z", { title: "New Chat" }),
      chat("c2", "2026-09-20T09:30:00Z", "2026-09-20T09:30:00Z", { title: "New Chat" }),
    ];
    const titles = mergeHistory(chats, [], { now: NOW, stable: true }).map((i) => i.title);
    expect(new Set(titles).size).toBe(2);
    expect(titles.every((t) => t.startsWith("New Chat · "))).toBe(true);
  });

  it("same title in the same minute numbers the repeat", () => {
    const chats = [
      chat("c1", "2026-09-20T09:00:00Z", "2026-09-20T09:00:00Z", { title: "New Chat" }),
      chat("c2", "2026-09-20T09:00:20Z", "2026-09-20T09:00:20Z", { title: "New Chat" }),
    ];
    const titles = mergeHistory(chats, [], { now: NOW, stable: true }).map((i) => i.title);
    expect(new Set(titles).size).toBe(2);
    expect(titles.some((t) => t.endsWith(" (2)"))).toBe(true);
  });
});
