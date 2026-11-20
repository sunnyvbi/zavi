// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { flushSync } from "react-dom";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";

type Thread = {
  id: string;
  tenant_id?: string;
  agent_slug: string;
  title: string | null;
  last_message_at: string;
  created_at: string;
};
type Msg = {
  id: string;
  tenant_id: string;
  body: string;
  sender_role: "user" | "assistant";
  agent_run_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  attachments: null;
  thread_id: string;
};

const db = {
  threads: new Map<string, Thread>(),
  messages: [] as Msg[],
  runs: new Map<string, { status: string; started_at: string; enqueued_at: string }>(),
  artifacts: [] as Array<{ id: string; run_id: string; filename: string; mime: string; bytes: number }>,
  threadError: null as string | null,
  messagesError: null as string | null,
  messageQueries: 0,
};

function resolveQuery(table: string, filters: Record<string, unknown>) {
  if (table === "agent_threads") {
    if (db.threadError) return { data: null, error: { message: db.threadError } };
    if (filters.id === undefined && typeof filters.agent_slug === "string") {
      const latest = [...db.threads.values()]
        .filter((t) => t.agent_slug === filters.agent_slug)
        .filter((t) => filters.tenant_id === undefined || (t.tenant_id ?? "tenant-1") === filters.tenant_id)
        .sort((a, b) => (a.last_message_at < b.last_message_at ? 1 : -1))[0];
      return { data: latest ?? null, error: null };
    }
    return { data: db.threads.get(filters.id as string) ?? null, error: null };
  }
  if (table === "agent_thread_messages") {
    db.messageQueries++;
    if (db.messagesError) return { data: null, error: { message: db.messagesError } };
    const hideSuperseded = filters["filter:meta->>superseded_by"] !== undefined;
    const rows = db.messages
      .filter((m) => m.thread_id === filters.thread_id)
      .filter((m) => !hideSuperseded || !m.meta?.superseded_by)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { data: rows, error: null };
  }
  if (table === "agent_runs" && typeof filters.id === "string") {
    return { data: db.runs.get(filters.id) ?? null, error: null };
  }
  if (table === "run_artifacts" && Array.isArray(filters.run_id)) {
    const ids = filters.run_id as string[];
    return { data: db.artifacts.filter((a) => ids.includes(a.run_id)), error: null };
  }
  return { data: null, error: null };
}

function builder(table: string) {
  const filters: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  const self = () => b;
  Object.assign(b, {
    select: self,
    is: self,
    filter: (col: string, op: string, val: unknown) => {
      filters[`filter:${col}`] = [op, val];
      return b;
    },
    order: self,
    limit: self,
    in: (col: string, vals: unknown) => {
      filters[col] = vals;
      return b;
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return b;
    },
    maybeSingle: () => Promise.resolve(resolveQuery(table, filters)),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(resolveQuery(table, filters)).then(res, rej),
  });
  return b;
}

const fakeSupabase = {
  from: (table: string) => builder(table),
  rpc: () => Promise.resolve({ data: [], error: null }),
};

vi.mock("@/lib/supabase", () => ({ createBrowserSupabase: () => fakeSupabase }));
const activeTenant = vi.hoisted(() => ({ id: "tenant-1" as string | null }));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: () => Promise.resolve(activeTenant.id) }));
const { realtimeCalls } = vi.hoisted(() => ({
  realtimeCalls: [] as Array<{ table: string; event?: string; filter?: string; enabled?: boolean }>,
}));
vi.mock("./useRealtimeChannel", () => ({
  useRealtimeChannel: (o: { table: string; event?: string; filter?: string; enabled?: boolean }) => {
    realtimeCalls.push(o);
  },
}));
vi.mock("./sessionScopedCache", () => ({ registerSessionScopedCache: () => {} }));
const notifyFiles = vi.fn();
vi.mock("./useWorkspaceFiles", () => ({ notifyWorkspaceFilesChanged: () => notifyFiles() }));

import { useChatThread, type ChatRow } from "./useChatThread";

let seq = 0;
function uuid() {
  seq++;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

function addThread(slug = "operator"): string {
  const id = uuid();
  db.threads.set(id, {
    id,
    agent_slug: slug,
    title: null,
    last_message_at: "2026-09-16T10:00:00Z",
    created_at: "2026-09-16T10:00:00Z",
  });
  return id;
}

function addMsg(threadId: string, m: Partial<Msg> & Pick<Msg, "body" | "sender_role">) {
  db.messages.push({
    id: uuid(),
    tenant_id: "tenant-1",
    agent_run_id: null,
    meta: null,
    created_at: `2026-09-16T10:00:0${db.messages.length}Z`,
    attachments: null,
    thread_id: threadId,
    ...m,
  });
}

const texts = (rows: { body: unknown }[]) =>
  rows.map((r) => (r.body as { text?: string })?.text);

describe("useChatThread — Bug #2 chat history", () => {
  beforeEach(() => {
    db.threads.clear();
    db.messages = [];
    db.runs.clear();
    db.threadError = null;
    db.messagesError = null;
    db.messageQueries = 0;
  });
  afterEach(() => cleanup());

  it("hydrates the same composer branch when the browser cache is warm", async () => {
    const id = addThread();
    addMsg(id, { body: "cached reply", sender_role: "assistant" });
    function ChatSurface() {
      const chat = useChatThread("operator", id);
      return (
        <div>
          {chat.rows.length === 0 ? (
            <textarea aria-label="Message" />
          ) : (
            <p>Conversation</p>
          )}
        </div>
      );
    }

    const html = renderToString(<ChatSurface />);
    const warmed = renderHook(() => useChatThread("operator", id));
    await waitFor(() =>
      expect(texts(warmed.result.current.rows)).toContain("cached reply"),
    );
    warmed.unmount();

    expect(renderToString(<ChatSurface />)).toBe(html);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let root: ReturnType<typeof hydrateRoot> | undefined;
      await act(async () => {
        root = hydrateRoot(container, <ChatSurface />);
      });
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/hydrat/i);
      await waitFor(() => expect(container.textContent).toContain("Conversation"));
      await act(async () => root?.unmount());
    } finally {
      errors.mockRestore();
      container.remove();
    }
  });

  it("switching A → B in the same tab drops A's sent bubble and in-flight run", async () => {
    const a = addThread();
    const b = addThread();
    addMsg(a, { body: "question for A", sender_role: "user", agent_run_id: "run-a" });
    db.runs.set("run-a", {
      status: "running",
      started_at: new Date().toISOString(),
      enqueued_at: new Date().toISOString(),
    });
    addMsg(b, { body: "old B message", sender_role: "user" });
    addMsg(b, { body: "old B reply", sender_role: "assistant" });

    const { result, rerender } = renderHook(
      ({ id }) => useChatThread("operator", id),
      { initialProps: { id: a } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeRunId).toBe("run-a");

    act(() => {
      result.current.appendOptimisticUser("follow-up typed in A");
    });
    expect(texts(result.current.rows)).toContain("follow-up typed in A");

    rerender({ id: b });
    expect(result.current.activeRunId).toBeNull();
    expect(result.current.activityRows).toEqual([]);
    expect(texts(result.current.rows)).not.toContain("follow-up typed in A");

    await waitFor(() => expect(texts(result.current.rows)).toContain("old B reply"));
    expect(texts(result.current.rows)).not.toContain("follow-up typed in A");
    expect(texts(result.current.rows)).not.toContain("question for A");
    expect(result.current.activeRunId).toBeNull();
  });

  it("the first send (null → new thread) keeps the optimistic bubble", async () => {
    const x = addThread();
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useChatThread("operator", id),
      { initialProps: { id: null as string | null } },
    );
    act(() => {
      result.current.appendOptimisticUser("my first message");
    });
    rerender({ id: x });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(texts(result.current.rows)).toContain("my first message");
  });

  it("a refetch captured before the first send bound its thread still loads the reply", async () => {
    const x = addThread();
    addMsg(x, { body: "Hello", sender_role: "user" });
    addMsg(x, { body: "Hey! How can Zavi help you?", sender_role: "assistant" });
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useChatThread("operator", id),
      { initialProps: { id: null as string | null } },
    );
    act(() => {
      result.current.appendOptimisticUser("Hello");
    });
    const refetchFromSend = result.current.refetch;
    act(() => {
      flushSync(() => rerender({ id: x }));
      void refetchFromSend();
    });
    await waitFor(() =>
      expect(texts(result.current.rows)).toEqual(["Hello", "Hey! How can Zavi help you?"]),
    );
  });

  it("a failed messages read shows an error instead of an empty chat, and is never cached", async () => {
    const c = addThread();
    addMsg(c, { body: "a real conversation", sender_role: "user" });
    db.messagesError = "network blip";

    const first = renderHook(() => useChatThread("operator", c));
    await waitFor(() => expect(first.result.current.errorMsg).toBe("network blip"));
    expect(first.result.current.rows).toEqual([]);
    first.unmount();

    db.messagesError = null;
    const second = renderHook(() => useChatThread("operator", c));
    expect(second.result.current.loading).toBe(true);
    await waitFor(() =>
      expect(texts(second.result.current.rows)).toContain("a real conversation"),
    );
    expect(second.result.current.errorMsg).toBeNull();
  });

  it("a failed thread-row read shows an error, not the welcome screen", async () => {
    const d = addThread();
    addMsg(d, { body: "hi", sender_role: "user" });
    db.threadError = "timeout";
    const { result } = renderHook(() => useChatThread("operator", d));
    await waitFor(() => expect(result.current.errorMsg).toBe("timeout"));
    expect(result.current.notFound).toBe(false);
    expect(result.current.rows).toEqual([]);
  });

  it("a failed background refetch keeps the conversation already on screen", async () => {
    const e = addThread();
    addMsg(e, { body: "keep me", sender_role: "user" });
    const { result } = renderHook(() => useChatThread("operator", e));
    await waitFor(() => expect(texts(result.current.rows)).toContain("keep me"));

    db.messagesError = "blip";
    await act(async () => {
      await result.current.refetch();
    });
    expect(texts(result.current.rows)).toContain("keep me");
    expect(result.current.errorMsg).toBeNull();
  });

  it("the latest-thread lookup stays in the active tenant, even when another company has a newer thread", async () => {
    const mine = addThread();
    addMsg(mine, { body: "active company", sender_role: "assistant" });
    const other = addThread();
    db.threads.set(other, { ...db.threads.get(other)!, tenant_id: "tenant-2", last_message_at: "2026-09-17T10:00:00Z" });
    addMsg(other, { body: "other company", sender_role: "assistant" });
    const { result } = renderHook(() => useChatThread("operator", undefined));
    await waitFor(() => expect(texts(result.current.rows)).toContain("active company"));
    expect(texts(result.current.rows)).not.toContain("other company");
  });

  it("a failed latest-thread lookup (no thread bound yet) shows an error, not a fresh chat", async () => {
    db.threadError = "lookup failed";
    const { result } = renderHook(() => useChatThread("operator", undefined));
    await waitFor(() => expect(result.current.errorMsg).toBe("lookup failed"));
  });

  it("a failed read right after the first send keeps the sent bubble instead of an error box", async () => {
    const g = addThread();
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useChatThread("operator", id),
      { initialProps: { id: null as string | null } },
    );
    act(() => {
      result.current.appendOptimisticUser("sent before the blip");
    });
    db.messagesError = "blip";
    rerender({ id: g });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.errorMsg).toBeNull();
    expect(texts(result.current.rows)).toContain("sent before the blip");
  });

  it("Try again after an error shows loading, not the empty welcome state", async () => {
    const h = addThread();
    addMsg(h, { body: "recovered", sender_role: "user" });
    db.messagesError = "down";
    const { result } = renderHook(() => useChatThread("operator", h));
    await waitFor(() => expect(result.current.errorMsg).toBe("down"));

    db.messagesError = null;
    let retry!: Promise<void>;
    act(() => {
      retry = result.current.refetch();
    });
    expect(result.current.errorMsg).toBeNull();
    expect(result.current.loading).toBe(true);
    await act(async () => {
      await retry;
    });
    expect(texts(result.current.rows)).toContain("recovered");
    expect(result.current.loading).toBe(false);
  });

  it("a new onThreadLoaded identity does not reload the thread", async () => {
    const f = addThread();
    addMsg(f, { body: "stable", sender_role: "user" });
    const { result, rerender } = renderHook(
      ({ cb }) => useChatThread("operator", f, cb),
      { initialProps: { cb: () => {} } },
    );
    await waitFor(() => expect(texts(result.current.rows)).toContain("stable"));
    const queries = db.messageQueries;

    rerender({ cb: () => {} });
    rerender({ cb: () => {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(db.messageQueries).toBe(queries);
  });
});

describe("the 30s optimistic GC is a promise about a row that is coming", () => {

  it("by default the bubble is swept, including on a first send with no thread yet", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useChatThread("operator", null as string | null),
      );
      act(() => {
        result.current.appendOptimisticUser("a first message that never lands");
      });
      expect(texts(result.current.rows)).toContain("a first message that never lands");
      act(() => {
        vi.advanceTimersByTime(31_000);
      });
      expect(texts(result.current.rows)).not.toContain("a first message that never lands");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a turn that writes no chat row keeps its bubble past the sweep", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() =>
        useChatThread("operator", null as string | null),
      );
      act(() => {
        result.current.appendOptimisticUser("use last month's numbers", undefined, {
          persists: false,
        });
        result.current.appendOptimisticSystem("Zavi is running this channel again.", {
          persists: false,
        });
      });
      act(() => {
        vi.advanceTimersByTime(31_000);
      });
      expect(texts(result.current.rows)).toContain("use last month's numbers");
      expect(texts(result.current.rows)).toContain("Zavi is running this channel again.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("useChatThread — a generated image refreshes the Files pane", () => {
  beforeEach(() => {
    db.threads.clear();
    db.messages = [];
    db.runs.clear();
    db.artifacts = [];
    db.threadError = null;
    db.messagesError = null;
    notifyFiles.mockClear();
  });
  afterEach(() => cleanup());

  function threadWithReply(runId: string): string {
    const t = addThread();
    addMsg(t, { body: "make me a hero image", sender_role: "user" });
    addMsg(t, { body: "here it is", sender_role: "assistant", agent_run_id: runId });
    return t;
  }

  it("fires once when a NEW image artifact lands on the thread already on screen, never for the first paint or a PDF", async () => {
    const t = threadWithReply("run-1");
    db.artifacts.push({ id: "art-pdf", run_id: "run-1", filename: "report.pdf", mime: "application/pdf", bytes: 1 });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.rows.some((r) => (r.artifacts ?? []).length > 0)).toBe(true);
    expect(notifyFiles).not.toHaveBeenCalled();

    db.artifacts.push({ id: "art-1", run_id: "run-1", filename: "hero.png", mime: "image/png", bytes: 9 });
    await act(() => result.current.refetch());
    expect(notifyFiles).toHaveBeenCalledTimes(1);

    await act(() => result.current.refetch());
    expect(notifyFiles).toHaveBeenCalledTimes(1);

    db.artifacts.push({ id: "art-2", run_id: "run-1", filename: "hero-2.png", mime: "image/jpeg", bytes: 9 });
    await act(() => result.current.refetch());
    expect(notifyFiles).toHaveBeenCalledTimes(2);
  });

  it("switching to another thread whose images already exist does not fire", async () => {
    const a = threadWithReply("run-a");
    const b = threadWithReply("run-b");
    db.artifacts.push({ id: "art-b", run_id: "run-b", filename: "old.png", mime: "image/png", bytes: 9 });
    const { result, rerender } = renderHook(({ id }) => useChatThread("operator", id), { initialProps: { id: a } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ id: b });
    await waitFor(() => expect(result.current.rows.some((r) => (r.artifacts ?? []).length > 0)).toBe(true));
    expect(notifyFiles).not.toHaveBeenCalled();
  });
});

describe("isBrowserTaskScreenshot (browser__task screenshots stay behind the link)", () => {
  it("matches only browser-task-*.png", async () => {
    const { isBrowserTaskScreenshot } = await import("./useChatThread");
    expect(isBrowserTaskScreenshot("browser-task-abc123-1.png")).toBe(true);
    expect(isBrowserTaskScreenshot("screenshot-1700000000.png")).toBe(false);
    expect(isBrowserTaskScreenshot("browser-task-notes.pdf")).toBe(false);
  });

  it("also hides a tab task's saved step (tab-task-*.jpg, behind \"See what Zavi saw\")", async () => {
    const { isBrowserTaskScreenshot } = await import("./useChatThread");
    expect(isBrowserTaskScreenshot("tab-task-0b8f3a5e1c2d.jpg")).toBe(true);
    expect(isBrowserTaskScreenshot("tab-task-notes.pdf")).toBe(false);
    expect(isBrowserTaskScreenshot("photo.jpg")).toBe(false);
  });
});

describe("offeredTeamNote + reply flags (Report to Zavi team, quiet + precise)", () => {
  const draftMeta = (state: string, draft: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    team_note_draft: { offer_id: "o1", note: "It failed.", signal: "other", offer_stop: false, ...draft },
    team_note_state: state,
    ...extra,
  });
  const strip = (anchor: string) => ({ surface: "strip", anchor_message_id: anchor });
  const flagOf = (rows: ChatRow[], id: string) => rows.find((r) => r.id === `m:${id}`)?.teamNoteFlag;

  beforeEach(() => {
    db.threads.clear();
    db.messages = [];
    db.runs.clear();
    db.threadError = null;
    db.messagesError = null;
    db.messageQueries = 0;
    realtimeCalls.length = 0;
  });
  afterEach(() => cleanup());

  it("subscribes to UPDATEs on this thread's messages", async () => {
    const t = addThread();
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(realtimeCalls).toContainEqual(
      expect.objectContaining({
        table: "agent_thread_messages",
        event: "UPDATE",
        filter: `thread_id=eq.${t}`,
        enabled: true,
      }),
    );
  });

  it("a hard-failure strip anchored on the reply is the strip, not a flag", async () => {
    const t = addThread();
    addMsg(t, { body: "ask", sender_role: "user" });
    addMsg(t, { id: "m9", body: "bad reply", sender_role: "assistant", meta: draftMeta("drafted", strip("m9")) });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() =>
      expect(result.current.offeredTeamNote).toMatchObject({ messageId: "m9", offerId: "o1", state: "drafted", surface: "strip" }),
    );
    expect(flagOf(result.current.rows, "m9")).toBeUndefined();
  });

  it("the strip ends when the founder writes again: the note becomes a flag on its reply", async () => {
    const t = addThread();
    addMsg(t, { body: "ask", sender_role: "user" });
    addMsg(t, { id: "m9", body: "bad reply", sender_role: "assistant", meta: draftMeta("shown", strip("m9")) });
    addMsg(t, { id: "u2", body: "next question", sender_role: "user" });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(texts(result.current.rows)).toContain("next question"));
    expect(result.current.offeredTeamNote).toBeNull();
    expect(flagOf(result.current.rows, "m9")).toMatchObject({ messageId: "m9", state: "shown" });
    expect(result.current.teamNoteTurnKey).toBe("m:u2");
  });

  it("a pushback strip is anchored on the founder's message and survives the next reply", async () => {
    const t = addThread();
    addMsg(t, { body: "ask", sender_role: "user" });
    addMsg(t, { id: "m9", body: "bad reply", sender_role: "assistant", meta: draftMeta("drafted", strip("u2")) });
    addMsg(t, { id: "u2", body: "no, that is wrong", sender_role: "user" });
    addMsg(t, { id: "m10", body: "sorry, fixed", sender_role: "assistant" });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(result.current.offeredTeamNote?.messageId).toBe("m9"));
  });

  it("everything else is a flag on its own reply; a note from before surfaces is a flag", async () => {
    const t = addThread();
    addMsg(t, { body: "ask", sender_role: "user" });
    addMsg(t, { id: "m9", body: "recovered", sender_role: "assistant", meta: draftMeta("drafted", { surface: "flag", anchor_message_id: null }) });
    addMsg(t, { id: "m10", body: "old note", sender_role: "assistant", meta: draftMeta("shown") });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(flagOf(result.current.rows, "m9")).toMatchObject({ surface: "flag" }));
    expect(flagOf(result.current.rows, "m10")).toMatchObject({ surface: "flag", state: "shown" });
    expect(result.current.offeredTeamNote).toBeNull();
  });

  it("two strips qualify: the newer anchor wins, the other is a flag", async () => {
    const t = addThread();
    addMsg(t, { body: "ask", sender_role: "user" });
    addMsg(t, { id: "m9", body: "first", sender_role: "assistant", meta: draftMeta("drafted", strip("u2")) });
    addMsg(t, { id: "u2", body: "no, wrong", sender_role: "user" });
    addMsg(t, { id: "m10", body: "second", sender_role: "assistant", meta: draftMeta("drafted", strip("m10")) });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(result.current.offeredTeamNote?.messageId).toBe("m10"));
    expect(flagOf(result.current.rows, "m9")).toMatchObject({ messageId: "m9" });
  });

  it("a superseded reply (edit) no longer offers anything: it is not loaded at all", async () => {
    const t = addThread();
    addMsg(t, { body: "ask", sender_role: "user" });
    addMsg(t, { id: "m9", body: "bad reply", sender_role: "assistant", meta: draftMeta("drafted", strip("m9"), { superseded_by: "u2" }) });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.offeredTeamNote).toBeNull();
    expect(result.current.rows.some((r) => r.teamNoteFlag)).toBe(false);
  });

  it("threadId undefined: resolves the latest thread and derives its strip", async () => {
    const t = addThread();
    addMsg(t, { id: "m9", body: "bad reply", sender_role: "assistant", meta: draftMeta("shown", strip("m9")) });
    const { result } = renderHook(() => useChatThread("operator", undefined));
    await waitFor(() => expect(result.current.offeredTeamNote?.messageId).toBe("m9"));
    expect(result.current.offeredTeamNote?.state).toBe("shown");
  });

  it("a sent or dismissed note is neither a strip nor a flag", async () => {
    const t = addThread();
    addMsg(t, { id: "m9", body: "bad reply", sender_role: "assistant", meta: draftMeta("sent", strip("m9")) });
    addMsg(t, { id: "m10", body: "other", sender_role: "assistant", meta: draftMeta("dismissed") });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.offeredTeamNote).toBeNull();
    expect(result.current.rows.some((r) => r.teamNoteFlag)).toBe(false);
  });

  it("thread switch: the note resets, and a cached thread restores its own note", async () => {
    const a = addThread();
    const b = addThread();
    addMsg(a, { id: "m9", body: "bad reply", sender_role: "assistant", meta: draftMeta("drafted", strip("m9")) });
    addMsg(b, { body: "fine reply", sender_role: "assistant" });
    const { result, rerender } = renderHook(({ id }) => useChatThread("operator", id), {
      initialProps: { id: a },
    });
    await waitFor(() => expect(result.current.offeredTeamNote?.messageId).toBe("m9"));

    rerender({ id: b });
    expect(result.current.offeredTeamNote).toBeNull();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.offeredTeamNote).toBeNull();

    rerender({ id: a });
    expect(result.current.offeredTeamNote?.messageId).toBe("m9");
  });

  it("a note on a message from another tenant never surfaces (multi-tenant founder, tenant A active)", async () => {
    const t = addThread();
    addMsg(t, { body: "ask", sender_role: "user", tenant_id: "tenant-2" });
    addMsg(t, { id: "m9", body: "bad reply", sender_role: "assistant", tenant_id: "tenant-2", meta: draftMeta("drafted", strip("m9")) });
    addMsg(t, { id: "m10", body: "other", sender_role: "assistant", tenant_id: "tenant-2", meta: draftMeta("drafted", { surface: "flag" }) });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(texts(result.current.rows)).toContain("bad reply"));
    expect(result.current.offeredTeamNote).toBeNull();
    expect(result.current.rows.some((r) => r.teamNoteFlag)).toBe(false);
  });

  it("no active tenant yet: no note at all (the thread still loads)", async () => {
    activeTenant.id = null;
    try {
      const t = addThread();
      addMsg(t, { id: "m9", body: "bad reply", sender_role: "assistant", meta: draftMeta("drafted", strip("m9")) });
      const { result } = renderHook(() => useChatThread("operator", t));
      await waitFor(() => expect(texts(result.current.rows)).toContain("bad reply"));
      expect(result.current.offeredTeamNote).toBeNull();
      expect(result.current.rows.some((r) => r.teamNoteFlag)).toBe(false);
    } finally {
      activeTenant.id = "tenant-1";
    }
  });

  it("the strip ends the moment the founder sends (optimistic), before any refetch; its note becomes a flag", async () => {
    const t = addThread();
    addMsg(t, { body: "ask", sender_role: "user" });
    addMsg(t, { id: "m9", body: "bad reply", sender_role: "assistant", meta: draftMeta("shown", strip("m9")) });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(result.current.offeredTeamNote?.messageId).toBe("m9"));
    const queries = db.messageQueries;
    act(() => {
      result.current.appendOptimisticUser("next question");
    });
    expect(result.current.offeredTeamNote).toBeNull();
    expect(flagOf(result.current.rows, "m9")).toMatchObject({ messageId: "m9" });
    expect(result.current.teamNoteTurnKey).toMatch(/^optimistic:/);
    expect(db.messageQueries).toBe(queries);
  });

  it("the note comes from the same message read as the bubbles (one query, no separate note read)", async () => {
    const t = addThread();
    addMsg(t, { body: "ask", sender_role: "user" });
    addMsg(t, { id: "m9", body: "reply", sender_role: "assistant", meta: draftMeta("drafted", strip("m9")) });
    const { result } = renderHook(() => useChatThread("operator", t));
    await waitFor(() => expect(texts(result.current.rows)).toContain("reply"));
    expect(result.current.errorMsg).toBeNull();
    expect(result.current.offeredTeamNote?.messageId).toBe("m9");
    expect(db.messageQueries).toBe(1);
  });
});
