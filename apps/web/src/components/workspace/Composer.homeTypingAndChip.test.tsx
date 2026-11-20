// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { Profiler, useMemo, useState, type ComponentProps } from "react";

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
import { WorkspaceModeWelcome } from "./ZaviWelcome";

Element.prototype.scrollIntoView = () => {};

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

const prof = { commits: 0 };

function HomeTab() {
  const [threadId, setThreadId] = useState<string | null>(null);
  ws.bind = (id) => setThreadId(id);
  const chat = useChatThread("operator", threadId);
  const [draft] = useState(createComposerDraft);
  const [attachments, setAttachments] = useState<NonNullable<ComponentProps<typeof Composer>["attachments"]>>([]);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const composerSeed = useMemo(() => (seed ? { ...seed, autoSend: true } : undefined), [seed]);
  const pick = (prompt: string) => setSeed((c) => ({ text: prompt, nonce: (c?.nonce ?? 0) + 1 }));
  const welcome = !chat.loading && chat.rows.length === 0;
  const composer = (embedded: boolean) => (
    <Composer
      agentSlug="operator"
      tabId="home"
      threadId={threadId}
      onOptimistic={(text, att) => chat.appendOptimisticUser(text, att, { settleLater: true })}
      onOptimisticSettled={chat.settleOptimisticUser}
      draft={draft}
      onSystem={chat.appendOptimisticSystem}
      onSent={() => {}}
      onNonRunHandled={() => {}}
      onCreditWall={() => {}}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      seed={composerSeed}
      hideStarterChips
      homeMentions
      embedded={embedded}
    />
  );
  return (
    <Profiler id="home" onRender={() => { prof.commits++; }}>
      {welcome ? (
        <WorkspaceModeWelcome mode="grow" composer={composer(true)} onPickSuggestion={pick} foldIdeas={false} />
      ) : (
        <div>
          <ol>
            {chat.rows.map((r) => (
              <li key={r.id} data-kind={r.kind}>
                {(r.body as { text?: string }).text}
              </li>
            ))}
          </ol>
          {composer(false)}
        </div>
      )}
    </Profiler>
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nativeType(ta: HTMLTextAreaElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, next);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  db.threads.clear();
  db.messages.length = 0;
  net.calls.length = 0;
  net.respond = async () => ok({ thread_id: "th-typed", user_message_id: "u-1", run_id: "run-1" });
  ws.bind = () => {};
  prof.commits = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Home composer typing burst", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  const prevAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

  afterEach(() => {
    root?.unmount();
    container?.remove();
    root = null;
    container = null;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = prevAct;
  });

  it("keeps every character when keystrokes land back to back, with no update-depth error", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.map(String).join(" "));
    });
    const windowErrors: string[] = [];
    const onError = (e: ErrorEvent) => {
      windowErrors.push(String(e.message));
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(<HomeTab />);
    await sleep(300);
    const ta = () => container!.querySelector("textarea") as HTMLTextAreaElement;
    const text =
      "Write a 5-star review for our truffle pasta that sounds like a real customer review, then draft two more for our tiramisu and our wood-fired margherita";
    const before = prof.commits;
    let thrown = 0;
    for (const ch of text) {
      try {
        nativeType(ta(), ta().value + ch);
      } catch {
        thrown++;
      }
    }
    const typingCommits = prof.commits - before;
    await sleep(100);
    window.removeEventListener("error", onError);

    expect(thrown).toBe(0);
    expect(windowErrors.filter((m) => m.includes("Maximum update depth"))).toEqual([]);
    expect(errors.filter((m) => m.includes("Maximum update depth"))).toEqual([]);
    expect(ta().value).toBe(text);
    expect(typingCommits).toBeLessThanOrEqual(text.length);
  });
});

describe("Home chip prompt declined over typed words", () => {
  it("one Return sends only the typed message after the chip was clicked over it", async () => {
    render(<HomeTab />);
    await flush();
    const typed = "Write a 5-star review for our truffle pasta";
    fireEvent.change(screen.getByRole("textbox"), { target: { value: typed } });
    fireEvent.click(screen.getByText("Plan my next month"));
    await flush();
    expect(net.calls).toEqual([]);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(typed);

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    await flush();
    await flush();

    expect(net.calls).toEqual([{ message: typed, thread_id: null }]);
    expect(screen.queryByText("What's my 30 day marketing strategy?")).toBeNull();
    expect(Array.from(document.querySelectorAll("li")).map((li) => li.textContent)).toEqual([typed]);
  });

  it("a chip clicked into an empty box still sends its prompt exactly once across the swap", async () => {
    render(<HomeTab />);
    await flush();
    fireEvent.click(screen.getByText("Plan my next month"));
    await flush();
    await flush();

    expect(net.calls).toEqual([{ message: "What's my 30 day marketing strategy?", thread_id: null }]);
  });
});
