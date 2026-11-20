import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useState } from "react";

type Msg = {
  id: string;
  body: string;
  sender_role: "user" | "assistant";
  agent_run_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  attachments: null;
  thread_id: string;
};

const db = vi.hoisted(() => ({
  threads: new Map<string, { id: string; agent_slug: string; title: string | null; last_message_at: string; created_at: string }>(),
  messages: [] as Msg[],
}));

const net = vi.hoisted(() => ({
  calls: [] as { message: string; thread_id: string | null }[],
  respond: null as null | ((body: { message: string; thread_id: string | null }) => Promise<unknown>),
}));

const ws = vi.hoisted(() => ({ bind: (_id: string | null) => {}, keepClicked: false }));

function resolveQuery(table: string, filters: Record<string, unknown>) {
  if (table === "agent_threads") {
    return { data: db.threads.get(filters.id as string) ?? null, error: null };
  }
  if (table === "agent_thread_messages" && filters["filter:meta->>team_note_state"]) {
    return { data: [], error: null };
  }
  if (table === "agent_thread_messages") {
    const rows = db.messages
      .filter((m) => m.thread_id === filters.thread_id)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return { data: rows, error: null };
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
    order: self,
    limit: self,
    filter: (col: string, op: string, val: unknown) => {
      filters[`filter:${col}`] = [op, val];
      return b;
    },
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

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: [], error: null }),
  }),
}));
vi.mock("@/lib/active-tenant-client", () => ({ getActiveTenantId: () => Promise.resolve("tenant-1") }));
vi.mock("@/lib/workspace/useRealtimeChannel", () => ({ useRealtimeChannel: () => {} }));
vi.mock("@/lib/workspace/sessionScopedCache", () => ({ registerSessionScopedCache: () => {} }));
vi.mock("@/lib/workspace/useWorkspaceFiles", () => ({ notifyWorkspaceFilesChanged: () => {} }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./WorkspaceShell", () => {
  const noop = () => {};
  return {
    useWorkspace: () => ({
      setTabDirty: noop,
      setTabThreadId: (_tab: string, id: string | null) => ws.bind(id),
      role: "owner",
      composerSeeds: {},
      consumeComposerSeed: noop,
      closeTab: noop,
      openTab: noop,
    }),
  };
});
vi.mock("@/lib/workspace/tenantCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspace/tenantCommands")>()),
  useTenantCommands: () => ({ commands: [], loaded: true, error: null }),
}));
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string, init?: { body?: string }) => {
    if (!url.endsWith("/chat") || !init?.body) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    }
    const body = JSON.parse(init.body) as { message: string; thread_id?: string | null };
    const entry = { message: body.message, thread_id: body.thread_id ?? null };
    net.calls.push(entry);
    return net.respond!(entry);
  }),
}));

import { Composer, createComposerDraft } from "./Composer";
import { useChatThread } from "@/lib/workspace/useChatThread";

Element.prototype.scrollIntoView = () => {};

let seq = 0;
const at = () => new Date(Date.UTC(2026, 9, 5, 5, 0, seq++)).toISOString();

function addThread(id: string) {
  db.threads.set(id, {
    id,
    agent_slug: "operator",
    title: null,
    last_message_at: at(),
    created_at: at(),
  });
}

function addMsg(threadId: string, m: Pick<Msg, "id" | "body" | "sender_role"> & Partial<Msg>) {
  db.messages.push({
    agent_run_id: null,
    meta: null,
    created_at: at(),
    attachments: null,
    thread_id: threadId,
    ...m,
  });
}

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function HomeChat({ initialThreadId }: { initialThreadId: string | null }) {
  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  ws.bind = (id) => {
    if (!ws.keepClicked) setThreadId(id);
  };
  const chat = useChatThread("operator", threadId);
  refetchRef.current = chat.refetch;
  const [draft] = useState(createComposerDraft);
  const welcome = !chat.loading && chat.rows.length === 0;
  const composer = (
    <Composer
      agentSlug="operator"
      tabId="home"
      threadId={threadId}
      onOptimistic={(text, attachments) =>
        chat.appendOptimisticUser(text, attachments, { settleLater: true })
      }
      onOptimisticSettled={chat.settleOptimisticUser}
      draft={draft}
      onSystem={chat.appendOptimisticSystem}
      onSent={() => {}}
    />
  );
  return (
    <div>
      <ol>
        {chat.rows.map((r) => (
          <li key={r.id} data-kind={r.kind}>
            {(r.body as { text?: string }).text}
          </li>
        ))}
      </ol>
      {welcome ? <section data-testid="welcome">{composer}</section> : <footer>{composer}</footer>}
    </div>
  );
}
const refetchRef: { current: null | (() => Promise<void>) } = { current: null };

async function flush() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const bubbles = () =>
  Array.from(document.querySelectorAll("li")).map(
    (li) => `${li.getAttribute("data-kind") === "chat_user" ? "U" : "A"}:${li.textContent}`,
  );

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}
function enter() {
  fireEvent.keyDown(box(), { key: "Enter" });
}

beforeEach(() => {
  db.threads.clear();
  db.messages = [];
  net.calls = [];
  net.respond = null;
  seq = 0;
  ws.keepClicked = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Home chat: a sent message is never lost", () => {
  it("l3.1 keeps an accepted message on screen past 30s while every refetch is still stale, then shows it once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    addThread("th-1");
    addMsg("th-1", { id: "u-alpha", body: "Reply one word: alpha", sender_role: "user", agent_run_id: "run-a" });
    addMsg("th-1", { id: "a-alpha", body: "alpha", sender_role: "assistant", agent_run_id: "run-a" });
    net.respond = async () =>
      ok({ thread_id: "th-1", user_message_id: "u-delta", run_id: "run-d" });

    render(<HomeChat initialThreadId="th-1" />);
    await flush();
    expect(bubbles()).toEqual(["U:Reply one word: alpha", "A:alpha"]);

    type("Reply one word: delta");
    enter();
    await flush();
    expect(net.calls).toEqual([{ message: "Reply one word: delta", thread_id: "th-1" }]);
    expect(bubbles()).toEqual(["U:Reply one word: alpha", "A:alpha", "U:Reply one word: delta"]);

    for (let s = 0; s < 4; s++) {
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      await act(async () => {
        await refetchRef.current!();
      });
      await flush();
      expect(bubbles()).toEqual(["U:Reply one word: alpha", "A:alpha", "U:Reply one word: delta"]);
    }

    addMsg("th-1", { id: "u-delta", body: "Reply one word: delta", sender_role: "user", agent_run_id: "run-d" });
    addMsg("th-1", { id: "a-delta", body: "delta", sender_role: "assistant", agent_run_id: "run-d" });
    await act(async () => {
      await refetchRef.current!();
    });
    await flush();
    expect(bubbles()).toEqual([
      "U:Reply one word: alpha",
      "A:alpha",
      "U:Reply one word: delta",
      "A:delta",
    ]);
  });

  it("l3.2 Enter while the previous send is still posting sends each message on its own, in order, to the new thread", async () => {
    const posts: { entry: { message: string }; gate: ReturnType<typeof deferred<void>> }[] = [];
    net.respond = async (entry) => {
      const gate = deferred<void>();
      posts.push({ entry, gate });
      await gate.promise;
      const n = posts.findIndex((p) => p.entry === entry);
      return ok({ thread_id: "th-new", user_message_id: `u-${n}`, run_id: "run-a" });
    };

    render(<HomeChat initialThreadId={null} />);
    await flush();

    type("Reply one word: alpha");
    enter();
    await flush();
    expect(box().value).toBe("");

    type("Reply one word: bravo");
    enter();
    await flush();
    expect(box().value).toBe("");
    type(`${box().value}Reply one word: charlie`);
    enter();
    await flush();
    expect(box().value).toBe("");
    expect(net.calls.map((c) => c.message)).toEqual(["Reply one word: alpha"]);
    expect(bubbles()).toEqual([
      "U:Reply one word: alpha",
      "U:Reply one word: bravo",
      "U:Reply one word: charlie",
    ]);

    posts[0].gate.resolve();
    await flush();
    expect(net.calls.map((c) => c.message)).toEqual([
      "Reply one word: alpha",
      "Reply one word: bravo",
    ]);
    posts[1].gate.resolve();
    await flush();
    posts[2]?.gate.resolve();
    await flush();

    expect(net.calls).toEqual([
      { message: "Reply one word: alpha", thread_id: null },
      { message: "Reply one word: bravo", thread_id: "th-new" },
      { message: "Reply one word: charlie", thread_id: "th-new" },
    ]);
  });

  it("l3.3 a first Home send that fails after a 35s hang keeps the typed text, even after the bubble expires and the welcome composer comes back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const gate = deferred<void>();
    net.respond = async () => {
      await gate.promise;
      return { ok: false, status: 503, json: async () => ({}), text: async () => "upstream timeout" };
    };

    render(<HomeChat initialThreadId={null} />);
    await flush();
    expect(screen.getByTestId("welcome")).toBeTruthy();

    type("Reply with one word: ping1");
    enter();
    await flush();
    expect(bubbles()).toEqual(["U:Reply with one word: ping1"]);

    await act(async () => {
      vi.advanceTimersByTime(35_000);
    });
    await flush();
    expect(bubbles()).toEqual(["U:Reply with one word: ping1"]);

    gate.resolve();
    await flush();
    expect(box().value).toBe("Reply with one word: ping1");

    await act(async () => {
      vi.advanceTimersByTime(31_000);
    });
    await flush();
    expect(screen.getByTestId("welcome")).toBeTruthy();
    expect(box().value).toBe("Reply with one word: ping1");
  });

  it("l3.4 text typed into the server-rendered box before hydration is kept and can be sent", async () => {
    net.respond = async () => ok({ thread_id: "th-new", user_message_id: "u-1", run_id: "run-1" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    container.innerHTML = renderToString(<HomeChat initialThreadId={null} />);
    const ssrBox = container.querySelector("textarea") as HTMLTextAreaElement;
    ssrBox.value = "Reply with one word: ping2";

    let root!: Root;
    await act(async () => {
      root = hydrateRoot(container, <HomeChat initialThreadId={null} />);
    });
    await flush();
    await act(async () => {
      root.render(<HomeChat initialThreadId={null} />);
    });
    await flush();

    const liveBox = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(liveBox.value).toBe("Reply with one word: ping2");
    const send = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.keyDown(liveBox, { key: "Enter" });
    await flush();
    expect(net.calls).toEqual([{ message: "Reply with one word: ping2", thread_id: null }]);
    await act(async () => root.unmount());
    container.remove();
  });

  it.each([
    ["the tab rebinds to X when A settles", false],
    ["the tab stays on the clicked thread Y", true],
  ])("a message queued in thread X is never posted after the user switches to thread Y (%s), and comes back to the box", async (_label, keepClicked) => {
    addThread("th-x");
    addMsg("th-x", { id: "u-x1", body: "Reply one word: xray", sender_role: "user", agent_run_id: "run-x" });
    addMsg("th-x", { id: "a-x1", body: "xray", sender_role: "assistant", agent_run_id: "run-x" });
    addThread("th-y");
    addMsg("th-y", { id: "u-y1", body: "Reply one word: yankee", sender_role: "user", agent_run_id: "run-y" });
    addMsg("th-y", { id: "a-y1", body: "yankee", sender_role: "assistant", agent_run_id: "run-y" });
    const gates: ReturnType<typeof deferred<void>>[] = [];
    net.respond = async (entry) => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return ok({ thread_id: entry.thread_id, user_message_id: `u-${gates.length}`, run_id: "run-n" });
    };

    render(<HomeChat initialThreadId="th-x" />);
    await flush();
    const composerEl = box();

    type("Reply one word: alpha");
    enter();
    await flush();
    type("Reply one word: bravo");
    enter();
    await flush();
    expect(box().value).toBe("");
    expect(net.calls).toEqual([{ message: "Reply one word: alpha", thread_id: "th-x" }]);

    await act(async () => {
      ws.bind("th-y");
    });
    await flush();
    expect(bubbles()).toEqual(["U:Reply one word: yankee", "A:yankee"]);
    expect(box()).toBe(composerEl);
    ws.keepClicked = keepClicked;

    gates[0].resolve();
    await flush();
    await flush();
    gates[1]?.resolve();
    await flush();

    expect(net.calls.some((c) => c.thread_id === "th-y")).toBe(false);
    expect(net.calls).toEqual([{ message: "Reply one word: alpha", thread_id: "th-x" }]);
    expect(box().value).toBe("Reply one word: bravo");
  });

  it("a message queued in thread X that came back to the box on a thread switch survives the earlier send failing afterwards", async () => {
    addThread("th-x3");
    addMsg("th-x3", { id: "u-x3", body: "Reply one word: xray", sender_role: "user", agent_run_id: "run-x" });
    addMsg("th-x3", { id: "a-x3", body: "xray", sender_role: "assistant", agent_run_id: "run-x" });
    addThread("th-y3");
    addMsg("th-y3", { id: "u-y3", body: "Reply one word: yankee", sender_role: "user", agent_run_id: "run-y" });
    addMsg("th-y3", { id: "a-y3", body: "yankee", sender_role: "assistant", agent_run_id: "run-y" });
    const gates: ReturnType<typeof deferred<void>>[] = [];
    net.respond = async () => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return { ok: false, status: 503, json: async () => ({}), text: async () => "upstream timeout" };
    };

    render(<HomeChat initialThreadId="th-x3" />);
    await flush();

    type("Reply one word: alpha");
    enter();
    await flush();
    type("Reply one word: bravo");
    enter();
    await flush();
    expect(box().value).toBe("");

    await act(async () => {
      ws.bind("th-y3");
    });
    await flush();
    expect(box().value).toBe("Reply one word: bravo");
    ws.keepClicked = true;

    gates[0].resolve();
    await flush();
    await flush();
    gates[1]?.resolve();
    await flush();

    expect(net.calls.map((c) => c.message)).toEqual(["Reply one word: alpha"]);
    const lines = box().value.split("\n");
    expect(lines).toContain("Reply one word: alpha");
    expect(lines).toContain("Reply one word: bravo");
    expect(lines.filter((l) => l === "Reply one word: bravo")).toHaveLength(1);
  });

  it("text typed while the only send is still pending survives that send failing", async () => {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    net.respond = async () => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return { ok: false, status: 503, json: async () => ({}), text: async () => "upstream timeout" };
    };

    render(<HomeChat initialThreadId="th-1" />);
    await flush();

    type("Reply one word: alpha");
    enter();
    await flush();
    type("half-typed follow up");
    await flush();

    gates[0].resolve();
    await flush();
    await flush();

    expect(net.calls.map((c) => c.message)).toEqual(["Reply one word: alpha"]);
    expect(box().value).toBe("Reply one word: alpha\nhalf-typed follow up");
  });

  it("a message queued behind the first send of a new Home chat is never posted after the user opens another thread", async () => {
    addThread("th-y2");
    addMsg("th-y2", { id: "u-y2", body: "Reply one word: yankee", sender_role: "user", agent_run_id: "run-y" });
    addMsg("th-y2", { id: "a-y2", body: "yankee", sender_role: "assistant", agent_run_id: "run-y" });
    const gates: ReturnType<typeof deferred<void>>[] = [];
    net.respond = async () => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return ok({ thread_id: "th-fresh", user_message_id: `u-${gates.length}`, run_id: "run-n" });
    };

    render(<HomeChat initialThreadId={null} />);
    await flush();
    type("Reply one word: alpha");
    enter();
    await flush();
    type("Reply one word: bravo");
    enter();
    await flush();
    expect(net.calls).toEqual([{ message: "Reply one word: alpha", thread_id: null }]);

    await act(async () => {
      ws.bind("th-y2");
    });
    await flush();
    ws.keepClicked = true;
    gates[0].resolve();
    await flush();
    await flush();
    gates[1]?.resolve();
    await flush();

    expect(net.calls).toEqual([{ message: "Reply one word: alpha", thread_id: null }]);
    expect(box().value).toBe("Reply one word: bravo");
  });

  it("an accepted send that comes back with no user_message_id (barge-in dedup) does not leave a ghost bubble past 30s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    addThread("th-steer");
    addMsg("th-steer", { id: "u-alpha", body: "Reply one word: alpha", sender_role: "user", agent_run_id: "run-a" });
    addMsg("th-steer", { id: "a-alpha", body: "alpha", sender_role: "assistant", agent_run_id: "run-a" });
    net.respond = async () => ok({ thread_id: "th-steer", user_message_id: "", run_id: "run-a" });

    render(<HomeChat initialThreadId="th-steer" />);
    await flush();

    type("Reply one word: steer");
    enter();
    await flush();
    expect(net.calls).toEqual([{ message: "Reply one word: steer", thread_id: "th-steer" }]);
    expect(bubbles()).toEqual(["U:Reply one word: alpha", "A:alpha", "U:Reply one word: steer"]);

    await act(async () => {
      vi.advanceTimersByTime(29_000);
    });
    await flush();
    expect(bubbles()).toEqual(["U:Reply one word: alpha", "A:alpha", "U:Reply one word: steer"]);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    await act(async () => {
      await refetchRef.current!();
    });
    await flush();
    expect(bubbles()).toEqual(["U:Reply one word: alpha", "A:alpha"]);
  });

  it("when a send fails with another message queued behind it, nothing more is posted and the box reads both messages in typed order", async () => {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    net.respond = async () => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return { ok: false, status: 503, json: async () => ({}), text: async () => "upstream timeout" };
    };

    render(<HomeChat initialThreadId={null} />);
    await flush();

    type("Reply one word: alpha");
    enter();
    await flush();
    type("Reply one word: bravo");
    enter();
    await flush();
    expect(box().value).toBe("");
    expect(bubbles()).toEqual(["U:Reply one word: alpha", "U:Reply one word: bravo"]);
    expect(net.calls.map((c) => c.message)).toEqual(["Reply one word: alpha"]);

    gates[0].resolve();
    await flush();
    await flush();
    gates[1]?.resolve();
    await flush();

    expect(net.calls.map((c) => c.message)).toEqual(["Reply one word: alpha"]);
    expect(box().value).toBe("Reply one word: alpha\nReply one word: bravo");
  });

  it("when the first send finds the agent unavailable with another message queued, the queued one is never posted and comes back to the box", async () => {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    net.respond = async () => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      const body = JSON.stringify({ error: { code: "default_disabled", message: "Agent is not available" } });
      return { ok: false, status: 403, json: async () => JSON.parse(body), text: async () => body };
    };

    render(<HomeChat initialThreadId={null} />);
    await flush();

    type("Reply one word: alpha");
    enter();
    await flush();
    type("Reply one word: bravo");
    enter();
    await flush();
    expect(net.calls.map((c) => c.message)).toEqual(["Reply one word: alpha"]);

    gates[0].resolve();
    await flush();
    await flush();
    gates[1]?.resolve();
    await flush();

    expect(net.calls.map((c) => c.message)).toEqual(["Reply one word: alpha"]);
    expect(box().value).toBe("Reply one word: bravo");
  });
});
