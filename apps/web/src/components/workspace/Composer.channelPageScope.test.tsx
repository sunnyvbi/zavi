// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  urls: [] as string[],
  bodies: [] as Record<string, unknown>[],
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
  useTenantCommands: () => ({
    commands: [
      {
        id: "c1",
        slug: "weekly",
        name: "Weekly",
        description: "Weekly review",
        instructions_md: "Do the weekly review.",
        updated_at: "2026-10-01T00:00:00Z",
      },
    ],
    loaded: true,
    error: null,
  }),
}));
vi.mock("@/lib/workspace/useFeedback", () => ({ submitFeedback: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (url: string, init?: { body?: string }) => {
    if (!url.endsWith("/chat") || !init?.body) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
    }
    const body = JSON.parse(init.body) as { message: string; thread_id?: string | null };
    net.urls.push(url);
    net.bodies.push(body as Record<string, unknown>);
    const entry = { message: body.message, thread_id: body.thread_id ?? null };
    net.calls.push(entry);
    return net.respond!(entry);
  }),
}));

import { Composer, createComposerDraft } from "./Composer";

Element.prototype.scrollIntoView = () => {};

const CARD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

function PageComposer({
  agentSlug,
  threadId,
  pageChannel,
  channelActionId,
}: {
  agentSlug: string;
  threadId: string | null;
  pageChannel?: string;
  channelActionId?: string;
}) {
  const [draft] = useState(createComposerDraft);
  const [bound, setBound] = useState<string | null>(threadId);
  return (
    <Composer
      agentSlug={agentSlug}
      tabId="channel-action-chat-panel"
      threadId={bound}
      onThreadBound={setBound}
      draft={draft}
      onSent={() => {}}
      stickyChannels={pageChannel ? [pageChannel] : undefined}
      pageChannel={pageChannel}
      channelActionId={channelActionId}
    />
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
function send(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.keyDown(box(), { key: "Enter" });
}

beforeEach(() => {
  db.threads.clear();
  db.messages = [];
  net.calls = [];
  net.urls = [];
  net.bodies = [];
  net.respond = async () => ok({ thread_id: "th-new", user_message_id: "u1", run_id: "run-1" });
});

afterEach(() => {
  cleanup();
});

const META_ASK = "Set up a Meta ads campaign for my bakery with a $20/day budget.";

describe("a channel page chat keeps every turn with that channel's own agent", () => {
  it.each(["operator", "performance-marketer", "ugc", "cgo"])(
    "@%s typed on the SEO page is sent to the seo agent with the page channel",
    async (other) => {
      render(<PageComposer agentSlug="seo" threadId={null} pageChannel="seo" />);
      send(`@${other} ${META_ASK}`);
      await flush();

      expect(net.urls).toEqual(["/api/agents/seo/chat"]);
      expect(net.bodies[0]).toMatchObject({
        message: `@${other} ${META_ASK}`,
        page_channel: "seo",
      });
    },
  );

  it("a follow-up @mention in an open page chat stays in that thread", async () => {
    render(<PageComposer agentSlug="seo" threadId={null} pageChannel="seo" />);
    send("Which searches should a bakery rank for?");
    await flush();
    send(`@operator ${META_ASK}`);
    await flush();

    expect(net.urls).toEqual(["/api/agents/seo/chat", "/api/agents/seo/chat"]);
    expect(net.bodies[1]).toMatchObject({ thread_id: "th-new", page_channel: "seo" });
  });

  it("the composer does not promise to route an @mention away from the page", async () => {
    render(<PageComposer agentSlug="seo" threadId={null} pageChannel="seo" />);
    fireEvent.change(box(), { target: { value: `@operator ${META_ASK}` } });
    await flush();

    expect(screen.queryByText(/route this turn to @operator/)).toBeNull();
  });

  it("the channel mention picker does not open on a channel page", async () => {
    render(<PageComposer agentSlug="seo" threadId={null} pageChannel="seo" />);
    fireEvent.change(box(), { target: { value: "@meta" } });
    await flush();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("Meta Ads")).toBeNull();
  });

  it("the channel mention picker still opens off a channel page", async () => {
    render(<PageComposer agentSlug="operator" threadId={null} />);
    fireEvent.change(box(), { target: { value: "@meta" } });
    await flush();

    expect(screen.queryAllByText(/Meta Ads/).length).toBeGreaterThan(0);
  });

  it("off a channel page an @mention still routes to the named agent", async () => {
    render(<PageComposer agentSlug="research" threadId={null} />);
    fireEvent.change(box(), { target: { value: `@operator ${META_ASK}` } });
    await flush();
    expect(screen.getByText(/route this turn to @operator/)).toBeTruthy();
    cleanup();

    render(<PageComposer agentSlug="research" threadId={null} />);
    send(`@operator ${META_ASK}`);
    await flush();

    expect(net.urls).toEqual(["/api/agents/operator/chat"]);
    expect(net.bodies[0]).not.toHaveProperty("page_channel");
  });
});
