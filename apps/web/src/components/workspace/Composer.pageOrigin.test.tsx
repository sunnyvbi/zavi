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
  threadId,
  pageChannel,
  channelActionId,
}: {
  threadId: string | null;
  pageChannel?: string;
  channelActionId?: string;
}) {
  const [draft] = useState(createComposerDraft);
  const [bound, setBound] = useState<string | null>(threadId);
  return (
    <Composer
      agentSlug="operator"
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
  net.bodies = [];
  net.respond = async () => ok({ thread_id: "th-new", user_message_id: "u1", run_id: "run-1" });
});

afterEach(() => {
  cleanup();
});

describe("Composer on a channel page sends page_channel on every own turn", () => {
  it("first turn and follow-up both carry page_channel", async () => {
    render(<PageComposer threadId={null} pageChannel="chatgpt_ads" />);
    send("How are my ChatGPT ads doing?");
    await flush();
    send("And yesterday?");
    await flush();
    expect(net.bodies).toHaveLength(2);
    expect(net.bodies[0]).toMatchObject({ thread_id: null, page_channel: "chatgpt_ads", channels: ["chatgpt_ads"] });
    expect(net.bodies[1]).toMatchObject({ thread_id: "th-new", page_channel: "chatgpt_ads" });
    expect(net.bodies[0]).not.toHaveProperty("page_channel_action_id");
  });

  it("a card chat carries the card as page_channel_action_id", async () => {
    render(<PageComposer threadId={null} pageChannel="chatgpt_ads" channelActionId={CARD} />);
    send("Why this one?");
    await flush();
    expect(net.bodies[0]).toMatchObject({
      page_channel: "chatgpt_ads",
      page_channel_action_id: CARD,
      channel_action_id: CARD,
    });
  });

  it("a tenant command from the page carries page_channel", async () => {
    render(<PageComposer threadId={null} pageChannel="chatgpt_ads" />);
    send("/weekly for chatgpt");
    await flush();
    expect(net.bodies[0]).toMatchObject({ command_slug: "weekly", page_channel: "chatgpt_ads" });
  });

  it("the stale-thread self-heal retry carries page_channel to the replacement thread", async () => {
    let n = 0;
    net.respond = async () => {
      n += 1;
      if (n === 1) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: { code: "thread_not_found", message: "gone" } }),
          text: async () => JSON.stringify({ error: { code: "thread_not_found", message: "gone" } }),
        };
      }
      return ok({ thread_id: "th-healed", user_message_id: "u2", run_id: "run-2" });
    };
    render(<PageComposer threadId="th-stale" pageChannel="chatgpt_ads" />);
    send("still there?");
    await flush();
    expect(net.bodies).toHaveLength(2);
    expect(net.bodies[0]).toMatchObject({ thread_id: "th-stale", page_channel: "chatgpt_ads" });
    expect(net.bodies[1]).toMatchObject({ thread_id: null, page_channel: "chatgpt_ads" });
  });

  it("off a channel page the body carries no page_channel", async () => {
    render(<PageComposer threadId={null} />);
    send("hello there friend");
    await flush();
    expect(net.bodies[0]).not.toHaveProperty("page_channel");
    expect(net.bodies[0]).not.toHaveProperty("page_channel_action_id");
  });
});
